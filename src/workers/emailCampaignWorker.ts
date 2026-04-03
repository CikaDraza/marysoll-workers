import { Worker, Job } from "bullmq";
import { connection } from "../redis";
import { sendCampaign } from "../services/sendCampaign";
import type { CampaignJobData } from "../types";

// ---------------------------------------------------------------------------
// BullMQ worker for the "email-campaign-queue"
//
// The SaaS app enqueues jobs with:
//   emailCampaignQueue.add("send-campaign", { campaignId }, { delay, attempts, backoff })
//
// Retry policy is intentionally set on the SaaS side (queue producer) so it
// can be adjusted without redeploying this worker. The worker simply processes
// whatever it receives and re-throws on failure so BullMQ applies the backoff.
//
// concurrency: 5 — process up to 5 campaigns in parallel.
//   Lower this (e.g. to 1) if the email provider has strict send-rate limits.
// ---------------------------------------------------------------------------

export const emailCampaignWorker = new Worker<CampaignJobData>(
  "email-campaign-queue",
  async (job: Job<CampaignJobData>) => {
    // Guard: ignore unrecognised job types without failing the queue
    if (job.name !== "send-campaign") {
      console.warn(
        `[emailCampaignWorker] Unknown job name "${job.name}" (id: ${job.id}) — skipping`,
      );
      return;
    }

    const { campaignId } = job.data;

    if (!campaignId) {
      // Throw a non-retryable error — the job data itself is malformed
      throw new Error(
        `[emailCampaignWorker] Job ${job.id} is missing campaignId — check the producer`,
      );
    }

    console.log(
      `[emailCampaignWorker] Processing job ${job.id} — campaign: ${campaignId}`,
    );

    await sendCampaign({ campaignId });
  },
  {
    connection,
    concurrency: 5,
  },
);
