import { eq, lte, and, or } from "drizzle-orm";
import { db } from "../db";
import { webhookDeliveries, webhooks } from "../../shared/schema";
import crypto from "crypto";

const MAX_ATTEMPTS = 5;
const BASE_RETRY_DELAY_MS = 60 * 1000; // 1 minute
const POLL_INTERVAL_MS = 10000; // 10 seconds

/**
 * Robust Webhook Delivery System 
 * - Exponential backoff
 * - HMAC-SHA256 signatures
 * - DB-backed queue
 */
export class WebhookWorker {
  private static interval: NodeJS.Timeout | null = null;
  private static isRunning = false;

  static start() {
    if (this.interval) return;
    console.log("[WebhookWorker] Starting queue consumer...");
    this.interval = setInterval(() => this.processQueue(), POLL_INTERVAL_MS);
    this.processQueue(); // First run immediately
  }

  static stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private static async processQueue() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const now = new Date();
      // Fetch due items
      const pendingDeliveries = await db
        .select({
          delivery: webhookDeliveries,
          webhook: webhooks
        })
        .from(webhookDeliveries)
        .innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
        .where(
          and(
            or(
              eq(webhookDeliveries.status, "pending"),
              eq(webhookDeliveries.status, "retrying")
            ),
            lte(webhookDeliveries.nextAttemptAt, now)
          )
        )
        .limit(50);

      for (const { delivery, webhook } of pendingDeliveries) {
        await this.deliver(delivery, webhook);
      }
    } catch (e: any) {
      console.error("[WebhookWorker] Error processing queue:", e.message);
    } finally {
      this.isRunning = false;
    }
  }

  private static async deliver(delivery: any, webhook: any) {
    const payloadStr = JSON.stringify(delivery.payload);
    
    // Generate signature
    const signature = crypto
      .createHmac("sha256", webhook.secret)
      .update(payloadStr)
      .digest("hex");

    let success = false;
    
    try {
      console.log("[WebhookWorker] Delivering #" + delivery.id + " to " + webhook.url);
      const response = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-cryptopay-signature": signature,
          "x-cryptopay-event": delivery.eventType
        },
        body: payloadStr,
        // Ensure reasonable timeout 
        signal: AbortSignal.timeout(10000)
      });

      if (response.ok) {
        success = true;
      } else {
        console.error("[WebhookWorker] Http Error " + response.status + " from " + webhook.url);
      }
    } catch (e: any) {
      console.error("[WebhookWorker] Network Error delivering to " + webhook.url + ":", e.message);
    }

    if (success) {
      await db
        .update(webhookDeliveries)
        .set({ status: "success" })
        .where(eq(webhookDeliveries.id, delivery.id));
    } else {
      const newAttempts = (delivery.attempts || 0) + 1;
      
      if (newAttempts >= MAX_ATTEMPTS) {
        await db
          .update(webhookDeliveries)
          .set({ status: "failed", attempts: newAttempts })
          .where(eq(webhookDeliveries.id, delivery.id));
        console.log("[WebhookWorker] #" + delivery.id + " permanently failed after " + MAX_ATTEMPTS + " attempts");
      } else {
        const backoffMs = BASE_RETRY_DELAY_MS * Math.pow(2, newAttempts - 1);
        const nextAttempt = new Date(Date.now() + backoffMs);
        
        await db
          .update(webhookDeliveries)
          .set({ 
            status: "retrying", 
            attempts: newAttempts,
            nextAttemptAt: nextAttempt
          })
          .where(eq(webhookDeliveries.id, delivery.id));
      }
    }
  }
}
