import type { SendCampaignParams } from "../types";

// ---------------------------------------------------------------------------
// sendCampaign
//
// Delegates the entire send to the platform's /api/internal/send-email route.
// That route owns:
//   - audience resolution (AudienceContact, optional segment filters)
//   - A/B test splitting
//   - open/click tracking injection
//   - Resend batch dispatch
//   - campaign status + metrics update
//   - CampaignAnalytics upsert
//
// The worker's only responsibility is to dequeue the job and call the API once.
// Keeping send logic in the platform avoids duplicating Mongoose models,
// Resend client, and tracking URLs in this process.
//
// Required env vars:
//   INTERNAL_API_URL  — e.g. https://app.marysoll.com  (no trailing slash, no /api suffix)
//   INTERNAL_API_KEY  — shared secret verified by x-internal-api-key header
// ---------------------------------------------------------------------------

export async function sendCampaign({ campaignId }: SendCampaignParams): Promise<void> {
  console.log(`[sendCampaign] ▶ Triggering campaign ${campaignId}`);

  const baseUrl = process.env.INTERNAL_API_URL;
  const apiKey  = process.env.INTERNAL_API_KEY;

  if (!baseUrl) throw new Error("INTERNAL_API_URL is not set");
  if (!apiKey)  throw new Error("INTERNAL_API_KEY is not set");

  // INTERNAL_API_URL already includes the /api prefix (e.g. https://app.marysoll.com/api).
  // Strip any accidental trailing slash then append the route path.
  const url = `${baseUrl.replace(/\/$/, "")}/internal/send-email`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-api-key": apiKey,
    },
    body: JSON.stringify({ campaignId }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[sendCampaign] Platform returned HTTP ${res.status} for campaign ${campaignId}: ${text}`,
    );
  }

  const result = await res.json().catch(() => ({})) as { recipients?: number };
  console.log(
    `[sendCampaign] ✓ Campaign ${campaignId} dispatched — recipients: ${result.recipients ?? "unknown"}`,
  );
}
