import { Worker, Job } from "bullmq";
import { connection } from "../redis";
import { sendCampaign } from "../services/sendCampaign";
import type { CampaignJobData } from "../types";

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
// Retry policy (attempts + backoff) is set by the SaaS when enqueuing jobs.
// Recommended job options on the SaaS side:
//   { attempts: 3, backoff: { type: "exponential", delay: 5000 } }
// ---------------------------------------------------------------------------

export const emailCampaignWorker = new Worker<CampaignJobData>(
  "email-campaign-queue",
  async (job: Job<CampaignJobData>) => {
    if (job.name !== "send-campaign") {
      console.warn(`[worker] Unknown job name "${job.name}" — skipping`);
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
    concurrency: 5,
  }
);
