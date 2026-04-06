import 'dotenv/config';
import mongoose from "mongoose";
import { startCampaignPoller } from "./workers/campaignPoller";

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

const REQUIRED_ENV = [
  "MONGODB_URI",
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
// Start
// ---------------------------------------------------------------------------

let stopPoller: (() => void) | null = null;

(async () => {
  await connectMongo();
  stopPoller = startCampaignPoller();
  console.log("[bootstrap] Marysoll workers started — polling MongoDB for scheduled campaigns");
})().catch((err: unknown) => {
  console.error("[bootstrap] Fatal startup error:", err);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  console.log(`[bootstrap] Received ${signal} — shutting down`);
  if (stopPoller) stopPoller();
  await mongoose.disconnect();
  console.log("[bootstrap] Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
