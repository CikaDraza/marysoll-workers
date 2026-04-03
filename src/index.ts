import 'dotenv/config';
import mongoose from "mongoose";
import { emailCampaignWorker } from "./workers/emailCampaignWorker";

// ---------------------------------------------------------------------------
// Environment validation
// Fail immediately at startup if critical env vars are missing —
// better than cryptic runtime errors deep inside a job.
// ---------------------------------------------------------------------------

const REQUIRED_ENV = [
  "MONGODB_URI",
  "REDIS_URL",
  "INTERNAL_API_URL",
  "INTERNAL_API_KEY",
] as const;

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[bootstrap] Missing required env var: ${key}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// MongoDB connection
// ---------------------------------------------------------------------------

async function connectMongo(): Promise<void> {
  const uri = process.env.MONGODB_URI!;
  await mongoose.connect(uri);
  console.log("[bootstrap] MongoDB connected");
}

// ---------------------------------------------------------------------------
// Worker event listeners
// ---------------------------------------------------------------------------

emailCampaignWorker.on("completed", (job) => {
  console.log(
    `[worker] ✓ Job ${job.id} completed (campaign: ${job.data.campaignId})`,
  );
});

emailCampaignWorker.on("failed", (job, err) => {
  const id         = job?.id         ?? "unknown";
  const campaignId = job?.data?.campaignId ?? "unknown";
  console.error(
    `[worker] ✗ Job ${id} failed (campaign: ${campaignId}): ${err.message}`,
  );
});

emailCampaignWorker.on("stalled", (jobId) => {
  console.warn(`[worker] Job ${jobId} stalled — BullMQ will retry`);
});

emailCampaignWorker.on("error", (err) => {
  console.error("[worker] Worker error:", err.message);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// Waits for the current job to finish before closing connections.
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  console.log(`[bootstrap] Received ${signal} — shutting down gracefully`);
  await emailCampaignWorker.close();
  await mongoose.disconnect();
  console.log("[bootstrap] Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

(async () => {
  await connectMongo();
  console.log(
    "[bootstrap] Marysoll workers started — listening on email-campaign-queue",
  );
})().catch((err: unknown) => {
  console.error("[bootstrap] Fatal startup error:", err);
  process.exit(1);
});
