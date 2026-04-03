import IORedis from "ioredis";

// ---------------------------------------------------------------------------
// Redis connection for BullMQ
//
// Configure via environment:
//   REDIS_URL=rediss://:password@hostname:port   (Upstash TLS — recommended)
//   REDIS_URL=redis://:password@hostname:port    (plain, for local dev)
//
// BullMQ requires:
//   maxRetriesPerRequest: null  — lets BullMQ manage retries itself
//   enableReadyCheck:    false  — avoids blocking startup on READONLY replicas
// ---------------------------------------------------------------------------

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error(
    "[redis] REDIS_URL is not set. " +
    "Set it to your Upstash Redis URL: rediss://:token@hostname:port"
  );
}

export const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  // Enable TLS when the URL scheme is rediss:// (Upstash default)
  tls: redisUrl.startsWith("rediss://") ? {} : undefined,
});

connection.on("connect", () => console.log("[redis] Connected"));
connection.on("error", (err: Error) =>
  console.error("[redis] Connection error:", err.message)
);
