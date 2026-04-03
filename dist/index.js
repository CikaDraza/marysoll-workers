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
var connection = new import_ioredis.default(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});

// src/services/sendCampaign.ts
var import_mongoose = __toESM(require("mongoose"));
var campaignSchema = new import_mongoose.Schema({}, { strict: false });
var subscriberSchema = new import_mongoose.Schema({}, { strict: false });
var analyticsSchema = new import_mongoose.Schema({}, { strict: false });
function getModel(name, schema) {
  return import_mongoose.default.models[name] ?? import_mongoose.default.model(name, schema);
}
var Campaign = getModel("EmailCampaign", campaignSchema);
var NewsletterSubscriber = getModel("NewsletterSubscriber", subscriberSchema);
var CampaignAnalytics = getModel("CampaignAnalytics", analyticsSchema);
var BATCH_SIZE = 50;
var BATCH_DELAY_MS = 200;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function chunk(arr, size) {
  const batches = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
}
function pickVariant(variants) {
  const rand = Math.random() * 100;
  let cumulative = 0;
  for (const variant of variants) {
    cumulative += variant.weight;
    if (rand < cumulative) return variant;
  }
  return variants[variants.length - 1];
}
async function sendEmail(payload) {
  const internalApiUrl = process.env.INTERNAL_API_URL;
  if (!internalApiUrl) {
    throw new Error("INTERNAL_API_URL is not set");
  }
  const response = await fetch(`${internalApiUrl}/internal/send-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `sendEmail failed [${response.status}] for subscriber ${payload.subscriberId}: ${text}`
    );
  }
}
async function updateCampaignAnalytics(campaign, recipientsCount) {
  const historyEntry = {
    campaignId: campaign._id,
    sentAt: campaign.sentAt ?? /* @__PURE__ */ new Date(),
    recipients: recipientsCount,
    topic: campaign.topic
  };
  await CampaignAnalytics.findOneAndUpdate(
    {
      salonProfileId: campaign.salonProfileId,
      tenantId: campaign.tenantId
    },
    {
      $set: {
        recipients: recipientsCount,
        topic: campaign.topic,
        sendTime: campaign.sentAt ?? /* @__PURE__ */ new Date()
      },
      $push: { campaignHistory: historyEntry }
    },
    { upsert: true }
  );
}
async function sendCampaign({ campaignId }) {
  console.log(`[sendCampaign] Starting campaign ${campaignId}`);
  const campaign = await Campaign.findById(campaignId).lean();
  if (!campaign) {
    throw new Error(`Campaign not found: ${campaignId}`);
  }
  await Campaign.findByIdAndUpdate(campaignId, { status: "sending" });
  console.log(`[sendCampaign] Campaign ${campaignId} \u2192 sending`);
  try {
    const subscribers = await NewsletterSubscriber.find({
      salonProfileId: campaign.salonProfileId,
      tenantId: campaign.tenantId,
      isSubscribed: true
    }).lean();
    console.log(
      `[sendCampaign] Campaign ${campaignId}: ${subscribers.length} subscribers found`
    );
    const batches = chunk(subscribers, BATCH_SIZE);
    let sentCount = 0;
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      await Promise.allSettled(
        batch.map(async (subscriber) => {
          let subject = campaign.subject;
          if (campaign.abTest?.enabled && campaign.abTest.variants.length > 0) {
            const variant = pickVariant(campaign.abTest.variants);
            subject = variant.subject;
          }
          const payload = {
            to: subscriber.email,
            subject,
            html: campaign.htmlContent,
            campaignId,
            subscriberId: subscriber._id.toString()
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
      if (batchIndex < batches.length - 1) {
        await sleep(BATCH_DELAY_MS);
      }
    }
    const sentAt = /* @__PURE__ */ new Date();
    await Campaign.findByIdAndUpdate(campaignId, {
      recipientsCount: sentCount,
      status: "sent",
      sentAt
    });
    campaign.sentAt = sentAt;
    await updateCampaignAnalytics(campaign, sentCount);
    console.log(
      `[sendCampaign] Campaign ${campaignId} finished \u2014 ${sentCount}/${subscribers.length} sent`
    );
  } catch (err) {
    await Campaign.findByIdAndUpdate(campaignId, { status: "failed" });
    console.error(`[sendCampaign] Campaign ${campaignId} failed:`, err);
    throw err;
  }
}

// src/workers/emailCampaignWorker.ts
var emailCampaignWorker = new import_bullmq.Worker(
  "email-campaign-queue",
  async (job) => {
    if (job.name !== "send-campaign") {
      console.warn(`[worker] Unknown job name "${job.name}" \u2014 skipping`);
      return;
    }
    const { campaignId } = job.data;
    if (!campaignId) {
      throw new Error(`Job ${job.id} is missing campaignId`);
    }
    await sendCampaign({ campaignId });
  },
  {
    connection,
    concurrency: 5
  }
);

// src/index.ts
async function connectMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  await import_mongoose2.default.connect(uri);
  console.log("[bootstrap] MongoDB connected");
}
emailCampaignWorker.on("completed", (job) => {
  console.log(`[worker] Job ${job.id} completed (campaign: ${job.data.campaignId})`);
});
emailCampaignWorker.on("failed", (job, err) => {
  const id = job?.id ?? "unknown";
  const campaignId = job?.data?.campaignId ?? "unknown";
  console.error(`[worker] Job ${id} failed (campaign: ${campaignId}):`, err.message);
});
emailCampaignWorker.on("stalled", (jobId) => {
  console.warn(`[worker] Job ${jobId} stalled \u2014 will be retried`);
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
  console.log("[bootstrap] Marysoll workers started \u2014 listening on email-campaign-queue");
})().catch((err) => {
  console.error("[bootstrap] Fatal startup error:", err);
  process.exit(1);
});
