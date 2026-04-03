import mongoose from "mongoose";
import { emailCampaignWorker } from "./workers/emailCampaignWorker";

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

async function connectMongo(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  await mongoose.connect(uri);
  console.log("[bootstrap] MongoDB connected");
}

// ---------------------------------------------------------------------------
// Worker events
// ---------------------------------------------------------------------------

emailCampaignWorker.on("completed", (job) => {
  console.log(`[worker] Job ${job.id} completed (campaign: ${job.data.campaignId})`);
});

emailCampaignWorker.on("failed", (job, err) => {
  const id = job?.id ?? "unknown";
  const campaignId = job?.data?.campaignId ?? "unknown";
  console.error(`[worker] Job ${id} failed (campaign: ${campaignId}):`, err.message);
});

emailCampaignWorker.on("stalled", (jobId) => {
  console.warn(`[worker] Job ${jobId} stalled — will be retried`);
});

emailCampaignWorker.on("error", (err) => {
  console.error("[worker] Worker error:", err.message);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  console.log(`[bootstrap] Received ${signal} — shutting down gracefully`);
  await emailCampaignWorker.close();
  await mongoose.disconnect();
  console.log("[bootstrap] Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

(async () => {
  await connectMongo();
  console.log("[bootstrap] Marysoll workers started — listening on email-campaign-queue");
})().catch((err) => {
  console.error("[bootstrap] Fatal startup error:", err);
  process.exit(1);
});
