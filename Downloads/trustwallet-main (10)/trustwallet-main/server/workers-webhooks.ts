import { Worker, Job } from "bullmq";
import { connection } from "./queue";
import { storage } from "./storage";
import crypto from "crypto";

const MAX_ATTEMPTS = 5;

export const webhookWorker = new Worker(
  "webhook-delivery",
  async (job: Job) => {
    const { webhookId, subscriptionId, eventType, payload, deliveryId } = job.data;
    
    console.log(`[WebhookWorker] Delivering job #${job.id} for subscription ${subscriptionId}`);
    
    // Refresh delivery object from DB to check status
    const delivery = await storage.getWebhookDeliveryById(deliveryId);
    if (!delivery || delivery.status === "success") {
       return { status: "already_completed" };
    }

    const webhook = await storage.getWebhookById(webhookId);
    if (!webhook || !webhook.active) {
       throw new Error(`Webhook ${webhookId} not found or inactive`);
    }

    const payloadStr = JSON.stringify(payload);
    const signature = crypto
      .createHmac("sha256", webhook.secret)
      .update(payloadStr)
      .digest("hex");

    try {
      const response = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-cryptopay-signature": signature,
          "x-cryptopay-event": eventType,
          "x-cryptopay-subscription-id": subscriptionId,
        },
        body: payloadStr,
        signal: AbortSignal.timeout(10000), // 10s cutoff
      });

      if (response.ok) {
        await storage.updateWebhookDelivery(deliveryId, "success");
        return { status: "success" };
      }

      console.error(`[WebhookWorker] Delivery to ${webhook.url} failed with status ${response.status}`);
      throw new Error(`HTTP ${response.status} from endpoint`);
    } catch (err: any) {
      console.error(`[WebhookWorker] Delivery error for ${webhook.url}:`, err.message);
      await storage.updateWebhookDelivery(deliveryId, "retrying", job.attemptsMade + 1);
      throw err; // Trigger standard BullMQ retry logic
    }
  },
  { 
    connection,
    concurrency: 10, // Handle multiple webhooks in parallel
  }
);

webhookWorker.on("failed", async (job, err) => {
   if (job) {
    console.error(`[WebhookWorker] Job #${job.id} permanently failed: ${err.message}`);
    const { deliveryId } = job.data;
    await storage.updateWebhookDelivery(deliveryId, "failed", job.attemptsMade);
   }
});
