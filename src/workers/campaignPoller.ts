import mongoose, { Schema, Model } from "mongoose";
import { sendCampaign } from "../services/sendCampaign";

// ---------------------------------------------------------------------------
// Lightweight Campaign model (strict:false — mirrors platform's EmailCampaign)
// ---------------------------------------------------------------------------

interface CampaignDoc {
  _id: mongoose.Types.ObjectId;
  scheduling: {
    status: string;
    sendAt?: Date;
  };
}

function getCampaignModel(): Model<CampaignDoc> {
  const schema = new Schema<CampaignDoc>({}, { strict: false });
  return (
    (mongoose.models.EmailCampaign as Model<CampaignDoc>) ??
    mongoose.model<CampaignDoc>("EmailCampaign", schema)
  );
}

// ---------------------------------------------------------------------------
// Poll interval
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 60_000; // 60 s

// ---------------------------------------------------------------------------
// Single poll tick
//
// Finds all campaigns with:
//   status = "scheduled"  AND  sendAt <= now
//
// Claims each one immediately (status → "sending") before dispatching, so
// multiple worker instances never double-send the same campaign.
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  const Campaign = getCampaignModel();
  const now = new Date();

  // Atomic claim: findOneAndUpdate returns null if another worker already
  // changed the status, preventing duplicate sends.
  let claimed: CampaignDoc | null;

  do {
    claimed = await Campaign.findOneAndUpdate(
      {
        "scheduling.status": "scheduled",
        "scheduling.sendAt": { $lte: now },
      },
      { $set: { "scheduling.status": "sending" } },
      { new: false }, // return the pre-update doc to get the _id
    ).lean();

    if (!claimed) break;

    const campaignId = claimed._id.toString();
    console.log(`[poller] Claimed campaign ${campaignId} — dispatching`);

    try {
      await sendCampaign({ campaignId });
    } catch (err) {
      console.error(`[poller] Campaign ${campaignId} failed:`, err);
      // Mark as failed so the operator can see it; won't be retried automatically.
      await Campaign.findByIdAndUpdate(campaignId, {
        $set: { "scheduling.status": "failed" },
      });
    }
  } while (claimed); // drain all due campaigns in one tick
}

// ---------------------------------------------------------------------------
// Start the poller — returns a cleanup function for graceful shutdown
// ---------------------------------------------------------------------------

export function startCampaignPoller(): () => void {
  console.log(
    `[poller] Started — polling every ${POLL_INTERVAL_MS / 1000} s`,
  );

  // Run immediately on start, then on interval
  tick().catch((err) => console.error("[poller] Tick error:", err));

  const timer = setInterval(() => {
    tick().catch((err) => console.error("[poller] Tick error:", err));
  }, POLL_INTERVAL_MS);

  return () => {
    clearInterval(timer);
    console.log("[poller] Stopped");
  };
}
