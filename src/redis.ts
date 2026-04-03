import IORedis from "ioredis";

// BullMQ requires maxRetriesPerRequest: null and enableReadyCheck: false
export const connection = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
