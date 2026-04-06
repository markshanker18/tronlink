import { Contract, JsonRpcProvider, WebSocketProvider } from "ethers";
import { SUBSCRIPTION_CONTRACT_ABI } from "../../shared/contracts";
import { storage } from "../storage";
import { db } from "../db";
import { subscriptions, executionLogs, webhookDeliveries, webhooks } from "../../shared/schema";
import { eq, and, desc } from "drizzle-orm";
import { webhookQueue } from "../queue";

/**
 * Replaces HTTP polling with real-time WebSocket listeners for deterministic finality.
 * Streams core contract events directly to the Database and triggers webhook dispatchers.
 */
export class BlockchainIndexer {
  private static providers = new Map<string, WebSocketProvider | JsonRpcProvider>();
  private static wsRpcUrls = new Map<string, string>();
  private static wsContracts = new Map<string, string>();
  private static wsReconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Tracks the last-seen TRON event timestamp per (networkId, contractAddress) key to
   * prevent duplicate webhook deliveries from the polling loop.
   */
  private static tronLastProcessedTimestamp = new Map<string, number>();

  /**
   * Initializes listeners for all recognized smart contracts.
   */
  static async startTracking(networkId: string, contractAddress: string, rpcUrl: string): Promise<void> {
    const isTron = networkId.startsWith("0x2b") || networkId.startsWith("0xcd"); // Simple TRON check

    if (isTron) {
      this.startTronTracking(networkId, contractAddress);
      return;
    }

    this.wsRpcUrls.set(networkId, rpcUrl);
    this.wsContracts.set(networkId, contractAddress);
    this._connectEvm(networkId, contractAddress, rpcUrl);
  }

  /** Internal: (re)connect a WebSocket/HTTP provider for an EVM network. */
  private static _connectEvm(networkId: string, contractAddress: string, rpcUrl: string): void {
    // Clean up any existing provider
    const existing = this.providers.get(networkId);
    if (existing) {
      try { existing.destroy(); } catch { /* ignore */ }
    }

    const isWss = rpcUrl.startsWith("wss");
    const provider = isWss ? new WebSocketProvider(rpcUrl) : new JsonRpcProvider(rpcUrl);
    this.providers.set(networkId, provider);

    const contract = new Contract(contractAddress, SUBSCRIPTION_CONTRACT_ABI as any, provider);

    // Listen to PaymentExecuted events (subId, sender, receiver, amount, timestamp)
    contract.on("PaymentExecuted", async (subIdRaw, sender, receiver, amount, timestamp, event) => {
      const subIdStr = subIdRaw.toString();
      const txHash = event.log ? event.log.transactionHash : (event.transactionHash || "");
      await this.handlePaymentEvent(subIdStr, txHash, amount.toString(), undefined, networkId);
    });

    if (isWss) {
      // Reconnect on WebSocket close or error so event listeners are never permanently lost.
      const wsProvider = provider as WebSocketProvider;
      const ws = (wsProvider as any).websocket ?? (wsProvider as any)._websocket;
      const attachHandlers = (socket: any) => {
        if (!socket) return;
        const reconnect = () => {
          if (this.wsReconnectTimers.has(networkId)) return; // already scheduled
          console.warn("[Indexer] WebSocket disconnected for " + networkId + ". Reconnecting in 5s...");
          const timer = setTimeout(() => {
            this.wsReconnectTimers.delete(networkId);
            const latestRpc = this.wsRpcUrls.get(networkId) ?? rpcUrl;
            const latestContract = this.wsContracts.get(networkId) ?? contractAddress;
            this._connectEvm(networkId, latestContract, latestRpc);
          }, 5000);
          this.wsReconnectTimers.set(networkId, timer);
        };
        socket.addEventListener("close", reconnect);
        socket.addEventListener("error", reconnect);
      };
      attachHandlers(ws);
      // Also attach on the provider's websocket-ready event if available
      wsProvider.on("error", () => {
        const timer = setTimeout(() => {
          this.wsReconnectTimers.delete(networkId);
          const latestRpc = this.wsRpcUrls.get(networkId) ?? rpcUrl;
          const latestContract = this.wsContracts.get(networkId) ?? contractAddress;
          this._connectEvm(networkId, latestContract, latestRpc);
        }, 5000);
        if (!this.wsReconnectTimers.has(networkId)) {
          this.wsReconnectTimers.set(networkId, timer);
        }
      });
    }

    console.log("[Indexer] Listening to EVM network " + networkId + " for " + contractAddress);
  }

  /**
   * TRON Specific Event Indexer
   * Uses Polling because most public TRON nodes have fragile WebSocket support.
   */
  private static async startTronTracking(networkId: string, contractAddress: string) {
    const { makeTronWebInstance } = await import("../tron-rpc");
    const tronWeb = await makeTronWebInstance(networkId);
    const dedupKey = `${networkId}:${contractAddress}`;

    // Initialize the dedup cursor to now so we don't replay old events on startup.
    if (!this.tronLastProcessedTimestamp.has(dedupKey)) {
      this.tronLastProcessedTimestamp.set(dedupKey, Date.now());
    }

    console.log("[Indexer] Starting TRON Poller for " + networkId + " (" + contractAddress + ")");

    // Simple polling loop (every 15s)
    setInterval(async () => {
      try {
        // Fetch the last N confirmed events; deduplication prevents reprocessing.
        const events = await tronWeb.getEventResult(contractAddress, {
          eventName: "PaymentExecuted",
          size: 10,
          onlyConfirmed: true
        });

        const lastTs = this.tronLastProcessedTimestamp.get(dedupKey) ?? 0;
        let maxTs = lastTs;

        for (const event of (events || [])) {
          // event.timestamp is in milliseconds on TronGrid
          const eventTs: number = event.timestamp ?? 0;
          if (eventTs <= lastTs) continue; // already processed

          const subId = event.result.subscriptionId;
          const txHash = event.transaction;
          const amount = event.result.amount;
          const token = event.result.token;
          await this.handlePaymentEvent(subId, txHash, amount, token, networkId);

          if (eventTs > maxTs) maxTs = eventTs;
        }

        if (maxTs > lastTs) {
          this.tronLastProcessedTimestamp.set(dedupKey, maxTs);
        }
      } catch (err: any) {
        console.error("[Indexer] TRON poll error for " + networkId + ":", err?.message ?? err);
      }
    }, 15000);
  }

  private static async handlePaymentEvent(
    onChainSubId: string,
    txHash: string,
    amount: string,
    token?: string,
    networkId?: string,
  ) {
    console.log("[Indexer] Finalizing sub #" + onChainSubId + " via Tx " + txHash);

    const { plans } = await import("../../shared/schema");

    // Include networkId in the lookup when available to prevent cross-chain
    // subscription ID collisions (on-chain IDs are per-contract incrementing integers).
    let subQuery;
    if (networkId) {
      subQuery = db
        .select()
        .from(subscriptions)
        .innerJoin(plans, eq(subscriptions.planId, plans.id))
        .where(
          and(
            eq(subscriptions.onChainSubscriptionId, onChainSubId),
            eq(plans.networkId, networkId),
          )
        );
    } else {
      subQuery = db.select().from(subscriptions).where(eq(subscriptions.onChainSubscriptionId, onChainSubId));
    }

    const rows = await subQuery;
    const sub = rows.length > 0 ? (networkId ? (rows[0] as any).subscriptions : rows[0]) : undefined;

    if (sub) {
       let resolvedToken = token;

       // If token wasn't in the event (EVM case), lookup from plan
       if (!resolvedToken) {
          const [plan] = await db.select().from(plans).where(eq(plans.id, sub.planId));
          resolvedToken = plan?.tokenAddress;
       }

       const activeCycleId = await this.getActiveCycle(sub.id);
       if (activeCycleId) {
          await storage.updateExecutionLog(activeCycleId, "success", txHash, "0");
       }

       await this.enqueueWebhook(sub.planId, sub.id, "subscription.paid", {
          onChainSubscriptionId: onChainSubId,
          txHash,
          amount,
          token: resolvedToken
       });
    }
  }

  private static async handleFailureEvent(onChainSubId: string, txHash: string, reason: string) {
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.onChainSubscriptionId, onChainSubId));
    if (sub) {
        const activeCycleId = await this.getActiveCycle(sub.id);
        if (activeCycleId) {
            await storage.updateExecutionLog(activeCycleId, "failed", txHash);
        }
        await this.enqueueWebhook(sub.planId, sub.id, "subscription.failed", { onChainSubscriptionId: onChainSubId, txHash, reason });
    }
  }

  private static async getActiveCycle(subscriptionId: string): Promise<string | null> {
    const rows = await db.select().from(executionLogs)
       .where(and(eq(executionLogs.subscriptionId, subscriptionId), eq(executionLogs.status, "pending")))
       .orderBy(desc(executionLogs.createdAt))
       .limit(1);
    return rows.length > 0 ? rows[0].cycleId : null;
  }

  public static async enqueueWebhook(planId: string, subscriptionId: string, eventType: string, payload: any): Promise<void> {
    // Lookup user from plan
    const { plans } = await import("../../shared/schema");
    const [plan] = await db.select().from(plans).where(eq(plans.id, planId));
    if (!plan) return;

    // Find active webhook routing
    const [webhook] = await db.select().from(webhooks).where(and(eq(webhooks.userId, plan.userId), eq(webhooks.active, true)));

    if (webhook) {
       const [delivery] = await db.insert(webhookDeliveries).values({
         webhookId: webhook.id,
         subscriptionId: subscriptionId,
         eventType,
         payload,
         status: "pending"
       }).returning();

       await webhookQueue.add(`webhook-${delivery.id}`, {
         webhookId: webhook.id,
         subscriptionId,
         eventType,
         payload,
         deliveryId: delivery.id,
       }, {
         jobId: `delivery-${delivery.id}`,
       });

       console.log("[Indexer] Webhook " + eventType + " queued for delivery via BullMQ (" + webhook.url + ")");
    }
  }
}
