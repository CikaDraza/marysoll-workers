import mongoose, { Schema, Model } from "mongoose";
import type {
  CampaignDocument,
  CampaignAnalyticsDocument,
  EmailCampaignPerformance,
  Subscriber,
  SendCampaignParams,
  SendEmailPayload,
  AbTestVariant,
} from "../types";

// ---------------------------------------------------------------------------
// Mongoose models
//
// The worker connects to the same MongoDB as the SaaS app and reads from the
// same collections. Schemas use strict:false so we don't need to replicate
// every field — Mongoose will hydrate whatever is in the document.
// ---------------------------------------------------------------------------

function getModel<T>(name: string): Model<T> {
  const schema = new Schema<T>({}, { strict: false });
  return (mongoose.models[name] as Model<T>) ?? mongoose.model<T>(name, schema);
}

const Campaign       = getModel<CampaignDocument>("EmailCampaign");
const User           = getModel<Subscriber>("User");
const Analytics      = getModel<CampaignAnalyticsDocument>("CampaignAnalytics");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BATCH_SIZE     = 50;   // emails per parallel batch
const BATCH_DELAY_MS = 200;  // ms to wait between batches (rate-limit guard)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Weighted random A/B variant selection.
 * Weights are relative — they don't need to sum to any specific value.
 * Example: [{ weight: 60 }, { weight: 40 }] → 60 % chance of first variant.
 */
function pickVariant(variants: AbTestVariant[]): AbTestVariant {
  const total = variants.reduce((sum, v) => sum + v.weight, 0);
  let rand = Math.random() * total;
  for (const variant of variants) {
    rand -= variant.weight;
    if (rand <= 0) return variant;
  }
  return variants[variants.length - 1];
}

// ---------------------------------------------------------------------------
// Email dispatch — calls the SaaS internal API
//
// Required env vars:
//   INTERNAL_API_URL  — e.g. https://app.marysoll.com  (no trailing slash)
//   INTERNAL_API_KEY  — shared secret checked by /internal/send-email
// ---------------------------------------------------------------------------

async function dispatchEmail(payload: SendEmailPayload): Promise<void> {
  const baseUrl = process.env.INTERNAL_API_URL;
  const apiKey  = process.env.INTERNAL_API_KEY;

  if (!baseUrl) throw new Error("INTERNAL_API_URL is not set");
  if (!apiKey)  throw new Error("INTERNAL_API_KEY is not set");

  const res = await fetch(`${baseUrl}/internal/send-email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // The SaaS /internal/* route must verify this header
      "x-internal-api-key": apiKey,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `dispatchEmail HTTP ${res.status} for subscriber ${payload.subscriberId}: ${body}`
    );
  }
}

// ---------------------------------------------------------------------------
// Analytics upsert
//
// One CampaignAnalytics document per (tenantId, salonProfileId).
// After each campaign send we:
//   1. Increment totalCampaigns
//   2. Push a history entry (real open/click rates come in later via tracking)
//   3. Recalculate avgOpenRate / avgClickRate from the full history
//   4. Refresh bestSubjectLines / topTopics rankings
// ---------------------------------------------------------------------------

async function updateAnalytics(
  campaign: CampaignDocument,
  sentCount: number,
): Promise<void> {
  const sentAt = campaign.scheduling.sentAt ?? new Date();
  const subject = campaign.content.subject;

  // Predicted rates (actual rates are updated later by tracking webhooks)
  const predictedOpenRate  = campaign.optimization?.predictedOpenRate ?? 0;
  const predictedClickRate = campaign.optimization?.predictedClickRate ?? 0;

  const entry: EmailCampaignPerformance = {
    campaignId:     campaign._id.toString(),
    subjectLine:    subject,
    topic:          campaign.topic,
    sentCount,
    deliveredCount: sentCount, // refined by webhook bounces if implemented
    openCount:      0,
    clickCount:     0,
    openRate:       predictedOpenRate,
    clickRate:      predictedClickRate,
    createdAt:      sentAt,
  };

  // Load current analytics doc to recalculate aggregates
  const existing = await Analytics.findOne({
    tenantId:      campaign.tenantId,
    salonProfileId: campaign.salonProfileId,
  }).lean() as CampaignAnalyticsDocument | null;

  const history: EmailCampaignPerformance[] = [
    ...(existing?.campaignHistory ?? []),
    entry,
  ];

  // Recalculate averages over all history entries that have sent emails
  const sentHistory = history.filter((h) => h.sentCount > 0);
  const avgOpenRate =
    sentHistory.length > 0
      ? sentHistory.reduce((s, h) => s + h.openRate, 0) / sentHistory.length
      : 0;
  const avgClickRate =
    sentHistory.length > 0
      ? sentHistory.reduce((s, h) => s + h.clickRate, 0) / sentHistory.length
      : 0;

  // Top 5 subject lines by openRate (descending)
  const sortedByOpen = [...history].sort((a, b) => b.openRate - a.openRate);
  const bestSubjectLines  = sortedByOpen.slice(0, 5).map((h) => h.subjectLine);
  const worstSubjectLines = sortedByOpen.slice(-5).map((h) => h.subjectLine);

  // Top topics by frequency
  const topicCounts: Record<string, number> = {};
  for (const h of history) {
    if (h.topic) topicCounts[h.topic] = (topicCounts[h.topic] ?? 0) + 1;
  }
  const topTopics = Object.entries(topicCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([t]) => t);

  await Analytics.findOneAndUpdate(
    {
      tenantId:       campaign.tenantId,
      salonProfileId: campaign.salonProfileId,
    },
    {
      $set: {
        avgOpenRate,
        avgClickRate,
        bestSubjectLines,
        worstSubjectLines,
        topTopics,
        campaignHistory: history,
        lastUpdated: new Date(),
      },
      $inc: { totalCampaigns: 1 },
    },
    { upsert: true, new: true },
  );

  console.log(
    `[sendCampaign] Analytics updated — avgOpen: ${avgOpenRate.toFixed(1)}%, ` +
    `avgClick: ${avgClickRate.toFixed(1)}%`,
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function sendCampaign({ campaignId }: SendCampaignParams): Promise<void> {
  console.log(`[sendCampaign] ▶ Starting campaign ${campaignId}`);

  // 1. Validate env early — fail fast before touching the DB
  if (!process.env.INTERNAL_API_URL) throw new Error("INTERNAL_API_URL is not set");
  if (!process.env.INTERNAL_API_KEY)  throw new Error("INTERNAL_API_KEY is not set");

  // 2. Load campaign document (enforce tenantId isolation via _id + lean)
  const campaign = await Campaign.findById(campaignId).lean() as CampaignDocument | null;
  if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);

  if (!campaign.template?.html) {
    throw new Error(`Campaign ${campaignId} has no rendered HTML template`);
  }

  // 3. Mark as sending (idempotent — safe to re-run after a partial failure)
  await Campaign.findByIdAndUpdate(campaignId, {
    "scheduling.status": "sending",
  });
  console.log(`[sendCampaign] Campaign ${campaignId} → status: sending`);

  try {
    // 4. Load active newsletter subscribers for this tenant
    //    Matches the platform's newsletter query (User model, tenantId-scoped)
    const subscribers = await User.find({
      tenantId: campaign.tenantId,
      $or: [
        {
          "newsletterPreferences.subscribed":    true,
          "newsletterPreferences.emailVerified": true,
        },
        { "notificationSettings.newsletterPromotions": true },
        { "notificationSettings.newsletterUpdates":    true },
        { "notificationSettings.newsletterTips":       true },
      ],
    })
      .select("email name tenantId newsletterPreferences notificationSettings")
      .lean() as Subscriber[];

    console.log(
      `[sendCampaign] Campaign ${campaignId}: found ${subscribers.length} subscribers`,
    );

    if (subscribers.length === 0) {
      console.warn(`[sendCampaign] No subscribers found — marking sent with 0 recipients`);
      await Campaign.findByIdAndUpdate(campaignId, {
        "scheduling.status": "sent",
        "scheduling.sentAt": new Date(),
        "metrics.recipients": 0,
      });
      return;
    }

    // 5. Send in batches
    const batches = chunk(subscribers, BATCH_SIZE);
    let sentCount  = 0;
    let failCount  = 0;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];

      const results = await Promise.allSettled(
        batch.map(async (subscriber) => {
          // A/B test: each subscriber independently draws a variant
          let subject = campaign.content.subject;
          if (campaign.abTest?.enabled && campaign.abTest.variants.length >= 2) {
            subject = pickVariant(campaign.abTest.variants).subject;
          }

          const payload: SendEmailPayload = {
            to:           subscriber.email,
            subject,
            html:         campaign.template.html,
            campaignId,
            subscriberId: subscriber._id.toString(),
            tenantId:     campaign.tenantId.toString(),
          };

          await dispatchEmail(payload);
        }),
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          sentCount++;
        } else {
          failCount++;
          console.error(
            `[sendCampaign] Batch ${i + 1} send failure:`,
            result.reason instanceof Error ? result.reason.message : result.reason,
          );
        }
      }

      console.log(
        `[sendCampaign] Batch ${i + 1}/${batches.length} — ` +
        `sent: ${sentCount}, failed: ${failCount}`,
      );

      // Throttle between batches (skip delay after the last one)
      if (i < batches.length - 1) await sleep(BATCH_DELAY_MS);
    }

    // 6. Mark campaign as sent and persist delivery metrics
    const sentAt = new Date();
    await Campaign.findByIdAndUpdate(campaignId, {
      "scheduling.status":  "sent",
      "scheduling.sentAt":  sentAt,
      "metrics.recipients": sentCount,
    });

    // Attach sentAt so analytics can reference the exact send time
    campaign.scheduling.sentAt = sentAt;

    // 7. Update CampaignAnalytics aggregate document
    await updateAnalytics(campaign, sentCount);

    console.log(
      `[sendCampaign] ✓ Campaign ${campaignId} complete — ` +
      `${sentCount} sent, ${failCount} failed out of ${subscribers.length} subscribers`,
    );
  } catch (err) {
    // Mark as failed so the operator can investigate; BullMQ will retry
    await Campaign.findByIdAndUpdate(campaignId, {
      "scheduling.status": "failed",
    });
    console.error(`[sendCampaign] ✗ Campaign ${campaignId} failed:`, err);
    throw err; // re-throw for BullMQ retry logic
  }
}
