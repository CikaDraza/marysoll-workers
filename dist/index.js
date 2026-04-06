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
var import_mongoose2 = __toESM(require("mongoose"));

// src/workers/campaignPoller.ts
var import_mongoose = __toESM(require("mongoose"));

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

// src/workers/campaignPoller.ts
function getCampaignModel() {
  const schema = new import_mongoose.Schema({}, { strict: false });
  return import_mongoose.default.models.EmailCampaign ?? import_mongoose.default.model("EmailCampaign", schema);
}
var POLL_INTERVAL_MS = 6e4;
async function tick() {
  const Campaign = getCampaignModel();
  const now = /* @__PURE__ */ new Date();
  let claimed;
  do {
    claimed = await Campaign.findOneAndUpdate(
      {
        "scheduling.status": "scheduled",
        "scheduling.sendAt": { $lte: now }
      },
      { $set: { "scheduling.status": "sending" } },
      { new: false }
      // return the pre-update doc to get the _id
    ).lean();
    if (!claimed) break;
    const campaignId = claimed._id.toString();
    console.log(`[poller] Claimed campaign ${campaignId} \u2014 dispatching`);
    try {
      await sendCampaign({ campaignId });
    } catch (err) {
      console.error(`[poller] Campaign ${campaignId} failed:`, err);
      await Campaign.findByIdAndUpdate(campaignId, {
        $set: { "scheduling.status": "failed" }
      });
    }
  } while (claimed);
}
function startCampaignPoller() {
  console.log(
    `[poller] Started \u2014 polling every ${POLL_INTERVAL_MS / 1e3} s`
  );
  tick().catch((err) => console.error("[poller] Tick error:", err));
  const timer = setInterval(() => {
    tick().catch((err) => console.error("[poller] Tick error:", err));
  }, POLL_INTERVAL_MS);
  return () => {
    clearInterval(timer);
    console.log("[poller] Stopped");
  };
}

// src/index.ts
var REQUIRED_ENV = [
  "MONGODB_URI",
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
var stopPoller = null;
(async () => {
  await connectMongo();
  stopPoller = startCampaignPoller();
  console.log("[bootstrap] Marysoll workers started \u2014 polling MongoDB for scheduled campaigns");
})().catch((err) => {
  console.error("[bootstrap] Fatal startup error:", err);
  process.exit(1);
});
async function shutdown(signal) {
  console.log(`[bootstrap] Received ${signal} \u2014 shutting down`);
  if (stopPoller) stopPoller();
  await import_mongoose2.default.disconnect();
  console.log("[bootstrap] Shutdown complete");
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
