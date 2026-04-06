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
var import_config = require("dotenv/config");
var import_mongoose = __toESM(require("mongoose"));

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
async function sendCampaign({ campaignId }) {
  console.log(`[sendCampaign] \u25B6 Triggering campaign ${campaignId}`);
  const baseUrl = process.env.INTERNAL_API_URL;
  const apiKey = process.env.INTERNAL_API_KEY;
  if (!baseUrl) throw new Error("INTERNAL_API_URL is not set");
  if (!apiKey) throw new Error("INTERNAL_API_KEY is not set");
  const url = `${baseUrl.replace(/\/$/, "")}/internal/send-email`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-api-key": apiKey
    },
    body: JSON.stringify({ campaignId })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[sendCampaign] Platform returned HTTP ${res.status} for campaign ${campaignId}: ${text}`
    );
  }
  const result = await res.json().catch(() => ({}));
  console.log(
    `[sendCampaign] \u2713 Campaign ${campaignId} dispatched \u2014 recipients: ${result.recipients ?? "unknown"}`
  );
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
  await import_mongoose.default.connect(uri);
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
  await import_mongoose.default.disconnect();
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
