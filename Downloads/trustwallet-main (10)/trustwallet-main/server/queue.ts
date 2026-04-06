import { Queue, Worker, Job } from "bullmq";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

const connection = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const executionQueue = new Queue("billing-execution", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

export const webhookQueue = new Queue("webhook-delivery", {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 60000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

export { connection };
