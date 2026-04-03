import mongoose, { Schema, Model } from "mongoose";
import type {
  CampaignDocument,
  Subscriber,
  CampaignAnalyticsDocument,
  SendCampaignParams,
  SendEmailPayload,
  AbTestVariant,
} from "../types";

// ---------------------------------------------------------------------------
// Mongoose models (minimal schemas — strict:false preserves SaaS-side fields)
// ---------------------------------------------------------------------------

const campaignSchema = new Schema<CampaignDocument>({}, { strict: false });
const subscriberSchema = new Schema<Subscriber>({}, { strict: false });
const analyticsSchema = new Schema<CampaignAnalyticsDocument>({}, { strict: false });

function getModel<T>(name: string, schema: Schema): Model<T> {
  return (mongoose.models[name] as Model<T>) ?? mongoose.model<T>(name, schema);
}

const Campaign = getModel<CampaignDocument>("EmailCampaign", campaignSchema);
const NewsletterSubscriber = getModel<Subscriber>("NewsletterSubscriber", subscriberSchema);
const CampaignAnalytics = getModel<CampaignAnalyticsDocument>("CampaignAnalytics", analyticsSchema);

const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk<T>(arr: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
}

/**
 * Weighted random variant selection for A/B tests.
 * Variants must have weights summing to 100.
 */
function pickVariant(variants: AbTestVariant[]): AbTestVariant {
  const rand = Math.random() * 100;
  let cumulative = 0;
  for (const variant of variants) {
    cumulative += variant.weight;
    if (rand < cumulative) return variant;
  }
  return variants[variants.length - 1];
}

// ---------------------------------------------------------------------------
// Email dispatch — calls SaaS internal API
// ---------------------------------------------------------------------------

async function sendEmail(payload: SendEmailPayload): Promise<void> {
  const internalApiUrl = process.env.INTERNAL_API_URL;
  if (!internalApiUrl) {
    throw new Error("INTERNAL_API_URL is not set");
  }

  const response = await fetch(`${internalApiUrl}/internal/send-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `sendEmail failed [${response.status}] for subscriber ${payload.subscriberId}: ${text}`
    );
  }
}

// ---------------------------------------------------------------------------
// Analytics update
// ---------------------------------------------------------------------------

async function updateCampaignAnalytics(
  campaign: CampaignDocument,
  recipientsCount: number
): Promise<void> {
  const historyEntry = {
    campaignId: campaign._id,
    sentAt: campaign.sentAt ?? new Date(),
    recipients: recipientsCount,
    topic: campaign.topic,
  };

  await CampaignAnalytics.findOneAndUpdate(
    {
      salonProfileId: campaign.salonProfileId,
      tenantId: campaign.tenantId,
    },
    {
      $set: {
        recipients: recipientsCount,
        topic: campaign.topic,
        sendTime: campaign.sentAt ?? new Date(),
      },
      $push: { campaignHistory: historyEntry },
    },
    { upsert: true }
  );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function sendCampaign({ campaignId }: SendCampaignParams): Promise<void> {
  console.log(`[sendCampaign] Starting campaign ${campaignId}`);

  // 1. Load campaign
  const campaign = (await Campaign.findById(campaignId).lean()) as CampaignDocument | null;
  if (!campaign) {
    throw new Error(`Campaign not found: ${campaignId}`);
  }

  // 2. Mark as sending
  await Campaign.findByIdAndUpdate(campaignId, { status: "sending" });
  console.log(`[sendCampaign] Campaign ${campaignId} → sending`);

  try {
    // 3. Load active subscribers for this salon/tenant
    const subscribers = (await NewsletterSubscriber.find({
      salonProfileId: campaign.salonProfileId,
      tenantId: campaign.tenantId,
      isSubscribed: true,
    }).lean()) as Subscriber[];

    console.log(
      `[sendCampaign] Campaign ${campaignId}: ${subscribers.length} subscribers found`
    );

    // 4. Send in batches
    const batches = chunk(subscribers, BATCH_SIZE);
    let sentCount = 0;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];

      await Promise.allSettled(
        batch.map(async (subscriber) => {
          // A/B test: assign variant per subscriber
          let subject = campaign.subject;
          if (campaign.abTest?.enabled && campaign.abTest.variants.length > 0) {
            const variant = pickVariant(campaign.abTest.variants);
            subject = variant.subject;
          }

          const payload: SendEmailPayload = {
            to: subscriber.email,
            subject,
            html: campaign.htmlContent,
            campaignId: campaignId,
            subscriberId: subscriber._id.toString(),
          };

          try {
            await sendEmail(payload);
            sentCount++;
          } catch (err) {
            console.error(
              `[sendCampaign] Failed to send to ${subscriber.email} (campaign ${campaignId}):`,
              err
            );
          }
        })
      );

      console.log(
        `[sendCampaign] Campaign ${campaignId}: batch ${batchIndex + 1}/${batches.length} processed`
      );

      // Throttle between batches (skip delay after last batch)
      if (batchIndex < batches.length - 1) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    // 5. Update recipients count
    const sentAt = new Date();
    await Campaign.findByIdAndUpdate(campaignId, {
      recipientsCount: sentCount,
      status: "sent",
      sentAt,
    });

    // Attach sentAt to campaign object for analytics
    campaign.sentAt = sentAt;

    // 6. Update analytics
    await updateCampaignAnalytics(campaign, sentCount);

    console.log(
      `[sendCampaign] Campaign ${campaignId} finished — ${sentCount}/${subscribers.length} sent`
    );
  } catch (err) {
    // Mark campaign as failed so operators can investigate
    await Campaign.findByIdAndUpdate(campaignId, { status: "failed" });
    console.error(`[sendCampaign] Campaign ${campaignId} failed:`, err);
    // Re-throw so BullMQ can apply retry policy
    throw err;
  }
}
