"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/index.ts
var import_mongoose2 = __toESM(require("mongoose"));

// src/workers/emailCampaignWorker.ts
var import_bullmq = require("bullmq");

// src/redis.ts
var import_ioredis = __toESM(require("ioredis"));
var redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error(
    "[redis] REDIS_URL is not set. Set it to your Upstash Redis URL: rediss://:token@hostname:port"
  );
}
var connection = new import_ioredis.default(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  // Enable TLS when the URL scheme is rediss:// (Upstash default)
  tls: redisUrl.startsWith("rediss://") ? {} : void 0
});
connection.on("connect", () => console.log("[redis] Connected"));
connection.on(
  "error",
  (err) => console.error("[redis] Connection error:", err.message)
);

// src/services/sendCampaign.ts
var import_mongoose = __toESM(require("mongoose"));
function getModel(name) {
  const schema = new import_mongoose.Schema({}, { strict: false });
  return import_mongoose.default.models[name] ?? import_mongoose.default.model(name, schema);
}
var Campaign = getModel("EmailCampaign");
var User = getModel("User");
var Analytics = getModel("CampaignAnalytics");
var BATCH_SIZE = 50;
var BATCH_DELAY_MS = 200;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function pickVariant(variants) {
  const total = variants.reduce((sum, v) => sum + v.weight, 0);
  let rand = Math.random() * total;
  for (const variant of variants) {
    rand -= variant.weight;
    if (rand <= 0) return variant;
  }
  return variants[variants.length - 1];
}
async function dispatchEmail(payload) {
  const baseUrl = process.env.INTERNAL_API_URL;
  const apiKey = process.env.INTERNAL_API_KEY;
  if (!baseUrl) throw new Error("INTERNAL_API_URL is not set");
  if (!apiKey) throw new Error("INTERNAL_API_KEY is not set");
  const res = await fetch(`${baseUrl}/internal/send-email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // The SaaS /internal/* route must verify this header
      "x-internal-api-key": apiKey
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `dispatchEmail HTTP ${res.status} for subscriber ${payload.subscriberId}: ${body}`
    );
  }
}
async function updateAnalytics(campaign, sentCount) {
  const sentAt = campaign.scheduling.sentAt ?? /* @__PURE__ */ new Date();
  const subject = campaign.content.subject;
  const predictedOpenRate = campaign.optimization?.predictedOpenRate ?? 0;
  const predictedClickRate = campaign.optimization?.predictedClickRate ?? 0;
  const entry = {
    campaignId: campaign._id.toString(),
    subjectLine: subject,
    topic: campaign.topic,
    sentCount,
    deliveredCount: sentCount,
    // refined by webhook bounces if implemented
    openCount: 0,
    clickCount: 0,
    openRate: predictedOpenRate,
    clickRate: predictedClickRate,
    createdAt: sentAt
  };
  const existing = await Analytics.findOne({
    tenantId: campaign.tenantId,
    salonProfileId: campaign.salonProfileId
  }).lean();
  const history = [
    ...existing?.campaignHistory ?? [],
    entry
  ];
  const sentHistory = history.filter((h) => h.sentCount > 0);
  const avgOpenRate = sentHistory.length > 0 ? sentHistory.reduce((s, h) => s + h.openRate, 0) / sentHistory.length : 0;
  const avgClickRate = sentHistory.length > 0 ? sentHistory.reduce((s, h) => s + h.clickRate, 0) / sentHistory.length : 0;
  const sortedByOpen = [...history].sort((a, b) => b.openRate - a.openRate);
  const bestSubjectLines = sortedByOpen.slice(0, 5).map((h) => h.subjectLine);
  const worstSubjectLines = sortedByOpen.slice(-5).map((h) => h.subjectLine);
  const topicCounts = {};
  for (const h of history) {
    if (h.topic) topicCounts[h.topic] = (topicCounts[h.topic] ?? 0) + 1;
  }
  const topTopics = Object.entries(topicCounts).sort(([, a], [, b]) => b - a).slice(0, 5).map(([t]) => t);
  await Analytics.findOneAndUpdate(
    {
      tenantId: campaign.tenantId,
      salonProfileId: campaign.salonProfileId
    },
    {
      $set: {
        avgOpenRate,
        avgClickRate,
        bestSubjectLines,
        worstSubjectLines,
        topTopics,
        campaignHistory: history,
        lastUpdated: /* @__PURE__ */ new Date()
      },
      $inc: { totalCampaigns: 1 }
    },
    { upsert: true, new: true }
  );
  console.log(
    `[sendCampaign] Analytics updated \u2014 avgOpen: ${avgOpenRate.toFixed(1)}%, avgClick: ${avgClickRate.toFixed(1)}%`
  );
}
async function sendCampaign({ campaignId }) {
  console.log(`[sendCampaign] \u25B6 Starting campaign ${campaignId}`);
  if (!process.env.INTERNAL_API_URL) throw new Error("INTERNAL_API_URL is not set");
  if (!process.env.INTERNAL_API_KEY) throw new Error("INTERNAL_API_KEY is not set");
  const campaign = await Campaign.findById(campaignId).lean();
  if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
  if (!campaign.template?.html) {
    throw new Error(`Campaign ${campaignId} has no rendered HTML template`);
  }
  await Campaign.findByIdAndUpdate(campaignId, {
    "scheduling.status": "sending"
  });
  console.log(`[sendCampaign] Campaign ${campaignId} \u2192 status: sending`);
  try {
    const subscribers = await User.find({
      tenantId: campaign.tenantId,
      $or: [
        {
          "newsletterPreferences.subscribed": true,
          "newsletterPreferences.emailVerified": true
        },
        { "notificationSettings.newsletterPromotions": true },
        { "notificationSettings.newsletterUpdates": true },
        { "notificationSettings.newsletterTips": true }
      ]
    }).select("email name tenantId newsletterPreferences notificationSettings").lean();
    console.log(
      `[sendCampaign] Campaign ${campaignId}: found ${subscribers.length} subscribers`
    );
    if (subscribers.length === 0) {
      console.warn(`[sendCampaign] No subscribers found \u2014 marking sent with 0 recipients`);
      await Campaign.findByIdAndUpdate(campaignId, {
        "scheduling.status": "sent",
        "scheduling.sentAt": /* @__PURE__ */ new Date(),
        "metrics.recipients": 0
      });
      return;
    }
    const batches = chunk(subscribers, BATCH_SIZE);
    let sentCount = 0;
    let failCount = 0;
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const results = await Promise.allSettled(
        batch.map(async (subscriber) => {
          let subject = campaign.content.subject;
          if (campaign.abTest?.enabled && campaign.abTest.variants.length >= 2) {
            subject = pickVariant(campaign.abTest.variants).subject;
          }
          const payload = {
            to: subscriber.email,
            subject,
            html: campaign.template.html,
            campaignId,
            subscriberId: subscriber._id.toString(),
            tenantId: campaign.tenantId.toString()
          };
          await dispatchEmail(payload);
        })
      );
      for (const result of results) {
        if (result.status === "fulfilled") {
          sentCount++;
        } else {
          failCount++;
          console.error(
            `[sendCampaign] Batch ${i + 1} send failure:`,
            result.reason instanceof Error ? result.reason.message : result.reason
          );
        }
      }
      console.log(
        `[sendCampaign] Batch ${i + 1}/${batches.length} \u2014 sent: ${sentCount}, failed: ${failCount}`
      );
      if (i < batches.length - 1) await sleep(BATCH_DELAY_MS);
    }
    const sentAt = /* @__PURE__ */ new Date();
    await Campaign.findByIdAndUpdate(campaignId, {
      "scheduling.status": "sent",
      "scheduling.sentAt": sentAt,
      "metrics.recipients": sentCount
    });
    campaign.scheduling.sentAt = sentAt;
    await updateAnalytics(campaign, sentCount);
    console.log(
      `[sendCampaign] \u2713 Campaign ${campaignId} complete \u2014 ${sentCount} sent, ${failCount} failed out of ${subscribers.length} subscribers`
    );
  } catch (err) {
    await Campaign.findByIdAndUpdate(campaignId, {
      "scheduling.status": "failed"
    });
    console.error(`[sendCampaign] \u2717 Campaign ${campaignId} failed:`, err);
    throw err;
  }
}

// src/workers/emailCampaignWorker.ts
var emailCampaignWorker = new import_bullmq.Worker(
  "email-campaign-queue",
  async (job) => {
    if (job.name !== "send-campaign") {
      console.warn(
        `[emailCampaignWorker] Unknown job name "${job.name}" (id: ${job.id}) \u2014 skipping`
      );
      return;
    }
    const { campaignId } = job.data;
    if (!campaignId) {
      throw new Error(
        `[emailCampaignWorker] Job ${job.id} is missing campaignId \u2014 check the producer`
      );
    }
    console.log(
      `[emailCampaignWorker] Processing job ${job.id} \u2014 campaign: ${campaignId}`
    );
    await sendCampaign({ campaignId });
  },
  {
    connection,
    concurrency: 5
  }
);

// src/index.ts
var REQUIRED_ENV = [
  "MONGODB_URI",
  "REDIS_URL",
  "INTERNAL_API_URL",
  "INTERNAL_API_KEY"
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[bootstrap] Missing required env var: ${key}`);
    process.exit(1);
  }
}
async function connectMongo() {
  const uri = process.env.MONGODB_URI;
  await import_mongoose2.default.connect(uri);
  console.log("[bootstrap] MongoDB connected");
}
emailCampaignWorker.on("completed", (job) => {
  console.log(
    `[worker] \u2713 Job ${job.id} completed (campaign: ${job.data.campaignId})`
  );
});
emailCampaignWorker.on("failed", (job, err) => {
  const id = job?.id ?? "unknown";
  const campaignId = job?.data?.campaignId ?? "unknown";
  console.error(
    `[worker] \u2717 Job ${id} failed (campaign: ${campaignId}): ${err.message}`
  );
});
emailCampaignWorker.on("stalled", (jobId) => {
  console.warn(`[worker] Job ${jobId} stalled \u2014 BullMQ will retry`);
});
emailCampaignWorker.on("error", (err) => {
  console.error("[worker] Worker error:", err.message);
});
async function shutdown(signal) {
  console.log(`[bootstrap] Received ${signal} \u2014 shutting down gracefully`);
  await emailCampaignWorker.close();
  await import_mongoose2.default.disconnect();
  console.log("[bootstrap] Shutdown complete");
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
(async () => {
  await connectMongo();
  console.log(
    "[bootstrap] Marysoll workers started \u2014 listening on email-campaign-queue"
  );
})().catch((err) => {
  console.error("[bootstrap] Fatal startup error:", err);
  process.exit(1);
});
