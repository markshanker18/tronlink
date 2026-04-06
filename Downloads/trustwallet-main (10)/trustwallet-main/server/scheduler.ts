import { storage } from "./storage";
import { getContractForNetwork } from "../shared/contracts";
import { getTronContractForNetwork } from "../shared/tron-contracts";
import { decrypt } from "./crypto";
import { getChainAdapter, type ChainAdapter } from "./chain-adapter";
import { detectChainType, type ChainType } from "../shared/chain";
import { AddressUtils } from "../shared/address-utils";
import { getIntervalMs, getIntervalSeconds } from "../shared/interval";
import os from "node:os";
import { executionQueue } from "./queue";
import type { Plan, Subscription } from "../shared/schema";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const CHECK_INTERVAL_MS = Math.max(
  5000,
  Number.parseInt(process.env.SCHEDULER_CHECK_INTERVAL_MS || "15000", 10) || 15000
);
const SCHEDULER_LOCK_NAME = "scheduler";
// Should comfortably exceed worst-case tick duration (multiple subs + retries + tx confirmations).
const SCHEDULER_LOCK_TTL_MS = 10 * 60 * 1000;
const PENDING_TX_MAX_AGE_MS = Math.max(
  60_000,
  Number.parseInt(process.env.PENDING_TX_MAX_AGE_MS || "1800000", 10) || 1_800_000
);

let schedulerInterval: NodeJS.Timeout | null = null;
let schedulerRunning = false;

const SKIP_LOG_THROTTLE_MS = 30 * 60 * 1000;
const lastSkipLogAtBySubscriptionId = new Map<string, number>();

/**
 * Resolves the deployer private key for on-chain sync operations.
 * TRON plans use a dedicated deployer key with a fallback chain;
 * EVM plans use only DEPLOYER_PRIVATE_KEY.
 */
function resolveDeployerKey(plan: Plan): string | null {
  if (plan.chainType === "tron") {
    return (
      process.env.TRON_DEPLOYER_PRIVATE_KEY ||
      process.env.TRON_EXECUTOR_PRIVATE_KEY ||
      process.env.DEPLOYER_PRIVATE_KEY ||
      null
    );
  }
  return process.env.DEPLOYER_PRIVATE_KEY || null;
}

/**
 * Syncs an on-chain subscription's terms to the current plan before payment execution.
 * Reads on-chain state, compares to plan, and only submits the tx(s) that are needed.
 * Returns true on success (or idempotent no-op), false on any failure.
 */
async function syncSubscriptionToPlan(
  sub: Subscription,
  plan: Plan,
  adapter: ChainAdapter,
  contractAddress: string,
  deployerKey: string
): Promise<boolean> {
  const subId = sub.onChainSubscriptionId!;

  // 1. Read current on-chain state
  let onChainSub: Awaited<ReturnType<ChainAdapter["getSubscription"]>>;
  try {
    onChainSub = await adapter.getSubscription(contractAddress, subId);
  } catch (err: any) {
    console.error(`[Scheduler] syncSubscriptionToPlan: getSubscription failed for sub ${sub.id}:`, err.message);
    await storage.createSchedulerLog(
      sub.id,
      "error",
      undefined,
      `Plan sync failed — could not read on-chain subscription: ${err.message}`
    );
    return false;
  }

  // 2. Compute expected values from plan
  const tokenDecimals = plan.tokenDecimals ?? 6;
  const expectedIntervalSec = getIntervalSeconds(plan.intervalValue, plan.intervalUnit);

  // Parse on-chain amount as bigint; parse expected amount via parseUnits equivalent
  const factor = BigInt(10) ** BigInt(tokenDecimals);
  // plan.recurringAmount is a decimal string (e.g. "10.5")
  const pAmount = plan.recurringAmount || plan.intervalAmount || "0";
  const [intPart, fracPart = ""] = pAmount.split(".");
  const paddedFrac = fracPart.padEnd(tokenDecimals, "0").slice(0, tokenDecimals);
  const expectedAmountWei = BigInt(intPart) * factor + BigInt(paddedFrac);

  const chainType = adapter.chainType;
  const expectedReceiver = AddressUtils.normalize(plan.walletAddress, chainType);
  const onChainReceiver = AddressUtils.normalize(onChainSub.receiver, chainType);

  // 3. Determine what needs updating
  const needsAmountOrIntervalUpdate =
    onChainSub.amount !== expectedAmountWei ||
    onChainSub.interval !== BigInt(expectedIntervalSec);
  const needsReceiverUpdate = onChainReceiver !== expectedReceiver;

  // 4. Idempotent no-op: on-chain already matches plan
  if (!needsAmountOrIntervalUpdate && !needsReceiverUpdate) {
    console.log(`[Scheduler] Sub ${sub.id}: on-chain state already matches plan — clearing pending sync flag`);
    await storage.clearSubscriptionPendingSync(
      sub.id,
      pAmount,
      plan.intervalValue,
      plan.intervalUnit
    );
    return true;
  }

  const oldAmount = sub.recurringAmount ?? pAmount;
  const oldInterval = `${sub.intervalValue ?? plan.intervalValue} ${sub.intervalUnit ?? plan.intervalUnit}`;
  const newInterval = `${plan.intervalValue} ${plan.intervalUnit}`;

  // 5. Apply updateSubscription if needed
  if (needsAmountOrIntervalUpdate) {
    try {
      await adapter.updateSubscription(
        contractAddress,
        subId,
        pAmount,
        expectedIntervalSec,
        deployerKey,
        tokenDecimals
      );
      console.log(`[Scheduler] Sub ${sub.id}: updateSubscription succeeded (amount: ${oldAmount} → ${pAmount}, interval: ${oldInterval} → ${newInterval})`);
    } catch (err: any) {
      console.error(`[Scheduler] syncSubscriptionToPlan: updateSubscription failed for sub ${sub.id}:`, err.message);
      await storage.createSchedulerLog(
        sub.id,
        "error",
        undefined,
        `Plan sync failed — updateSubscription reverted: ${err.message}`
      );
      return false;
    }
  }

  // 6. Apply updateReceiver if needed
  if (needsReceiverUpdate) {
    try {
      await adapter.updateReceiver(contractAddress, subId, plan.walletAddress, deployerKey);
      console.log(`[Scheduler] Sub ${sub.id}: updateReceiver succeeded (${onChainReceiver} → ${expectedReceiver})`);
    } catch (err: any) {
      console.error(`[Scheduler] syncSubscriptionToPlan: updateReceiver failed for sub ${sub.id}:`, err.message);
      await storage.createSchedulerLog(
        sub.id,
        "error",
        undefined,
        `Plan sync failed — updateReceiver reverted: ${err.message}`
      );
      return false;
    }
  }

  // 7. All calls succeeded — clear flag and write sync log
  await storage.clearSubscriptionPendingSync(
    sub.id,
    pAmount,
    plan.intervalValue,
    plan.intervalUnit
  );

  const parts: string[] = [];
  if (needsAmountOrIntervalUpdate) {
    parts.push(`amount: ${oldAmount} → ${pAmount}; interval: ${oldInterval} → ${newInterval}`);
  }
  if (needsReceiverUpdate) {
    parts.push(`receiver: ${onChainReceiver} → ${expectedReceiver}`);
  }
  const summary = parts.join("; ");

  await storage.createSchedulerLog(
    sub.id,
    "sync",
    undefined,
    `Plan sync applied — ${summary}`
  );

  console.log(`[Scheduler] Sub ${sub.id}: plan sync complete — ${summary}`);
  return true;
}

function shouldLogSkip(subscriptionId: string): boolean {
  const now = Date.now();
  const last = lastSkipLogAtBySubscriptionId.get(subscriptionId) || 0;
  if (now - last < SKIP_LOG_THROTTLE_MS) return false;
  lastSkipLogAtBySubscriptionId.set(subscriptionId, now);
  return true;
}

async function executeWithRetry(
  subscriptionId: string,
  contractAddress: string,
  chainId: string,
  chainType: ChainType,
  onChainSubId: string,
  executorKey: string,
  attempt = 1,
  cycleId?: string,
  amount?: string,
  tokenSymbol?: string
): Promise<{ txHash: string; feeConsumed: string; energyUsed?: string; nextPaymentTimeMs: number | null; confirmed: boolean } | null> {
  let sentTxHash: string | null = null;

  try {
    const adapter = await getChainAdapter(chainType, chainId);

    const hasBalance = await adapter.hasMinimumExecutorBalance(executorKey);
    if (!hasBalance) {
      console.log(`[Scheduler] Executor wallet has insufficient balance on ${chainId}`);
      await storage.createSchedulerLog(
        subscriptionId,
        "error",
        undefined,
        `Executor wallet has insufficient native token/TRX. Fund the executor wallet and try again.`,
        undefined,
        undefined,
        cycleId,
        amount,
        tokenSymbol
      );
      return null;
    }

    const isDue = await adapter.isDue(contractAddress, onChainSubId, executorKey);
    if (!isDue) {
      console.log(`[Scheduler] Subscription #${onChainSubId} not yet due`);
      try {
        const onChainSub = await adapter.getSubscription(contractAddress, onChainSubId);
        const nextPaymentTime = Number(onChainSub?.nextPaymentTime ?? 0);
        if (Number.isFinite(nextPaymentTime) && nextPaymentTime > 0) {
          await storage.setNextPaymentDue(subscriptionId, new Date(nextPaymentTime * 1000));
        }
      } catch (syncErr: any) {
        console.log(`[Scheduler] Failed to sync next due for #${onChainSubId}: ${syncErr?.message || syncErr}`);
      }
      return null;
    }

    const hasTokenBalance = await adapter.hasEnoughBalance(contractAddress, onChainSubId, executorKey);
    if (!hasTokenBalance) {
      console.log(`[Scheduler] Subscription #${onChainSubId} insufficient token balance`);
      await storage.updateSubscriptionStatus(subscriptionId, "suspended_balance");
      await storage.createSchedulerLog(subscriptionId, "insufficient_balance", undefined, "Sender has insufficient token balance. Subscription suspended.", undefined, undefined, cycleId, amount, tokenSymbol);
      return null;
    }

    const hasAllowance = await adapter.hasEnoughAllowance(contractAddress, onChainSubId, executorKey);
    if (!hasAllowance) {
      console.log(`[Scheduler] Subscription #${onChainSubId} insufficient allowance`);
      await storage.updateSubscriptionStatus(subscriptionId, "suspended_allowance");
      await storage.createSchedulerLog(subscriptionId, "insufficient_allowance", undefined, "Sender has revoked allowance or has insufficient tokens. Subscription suspended.", undefined, undefined, cycleId, amount, tokenSymbol);
      return null;
    }

    await storage.createSchedulerLog(subscriptionId, "started", undefined, undefined, undefined, undefined, cycleId, amount, tokenSymbol);
    const result = await adapter.executeSubscription(contractAddress, onChainSubId, executorKey);

    // "renting_energy" is a sentinel from TronEnergyManager meaning energy rental was
    // triggered — the tx was NOT sent. Skip marking pending; next cycle will retry.
    if (result.txHash === "renting_energy") {
      console.log(`[Scheduler] Subscription #${onChainSubId} deferred — waiting for energy rental to settle.`);
      await storage.createSchedulerLog(subscriptionId, "pending", undefined, "TRON energy rental in progress. Will retry next cycle.");
      return null;
    }

    sentTxHash = result.txHash;
    await storage.markSubscriptionExecutionPending(subscriptionId, result.txHash, new Date());
    await storage.createSchedulerLog(subscriptionId, "pending", result.txHash, undefined, undefined, undefined, cycleId, amount, tokenSymbol);
    console.log(`[Scheduler] TX sent: ${result.txHash}`);

    return result;
  } catch (err: any) {
    console.error(`[Scheduler] Attempt ${attempt}/${MAX_RETRIES} failed:`, err.message);
    const lowerMsg = String(err?.message || "").toLowerCase();
    const isIntrinsicFundsError =
      lowerMsg.includes("insufficient funds") ||
      lowerMsg.includes("intrinsic transaction cost") ||
      lowerMsg.includes("gas required exceeds allowance") ||
      lowerMsg.includes("base fee exceeds gas limit") ||
      lowerMsg.includes("insufficient trx") ||
      lowerMsg.includes("fee limit") ||
      lowerMsg.includes("out of energy") ||
      lowerMsg.includes("out of bandwidth");

    if (sentTxHash) {
      await storage.createSchedulerLog(
        subscriptionId,
        "error",
        sentTxHash,
        `Transaction broadcast but confirmation failed: ${err.message}`
      );
      // Avoid duplicate submission when tx may still confirm later.
      return null;
    }

    if (isIntrinsicFundsError) {
      await storage.createSchedulerLog(
        subscriptionId,
        "error",
        undefined,
        "Executor wallet does not have enough native coin/TRX for fees. Fund executor and retry."
      );
      return null;
    }

    if (attempt < MAX_RETRIES) {
      const isRetryable = !isIntrinsicFundsError && !lowerMsg.includes("revert");
      if (isRetryable) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
        return executeWithRetry(subscriptionId, contractAddress, chainId, chainType, onChainSubId, executorKey, attempt + 1, cycleId, amount, tokenSymbol);
      }
    }

    await storage.createSchedulerLog(subscriptionId, "failed", undefined, err.message, undefined, undefined, cycleId, amount, tokenSymbol);
    return null;
  }
}


async function reconcilePendingExecutions(): Promise<void> {
  const pendingSubs = await storage.getSubscriptionsWithPendingExecution();
  if (pendingSubs.length === 0) return;

  for (const sub of pendingSubs) {
    if (!sub.pendingTxHash || !sub.planId) continue;
    const plan = await storage.getPlanById(sub.planId);
    if (!plan) continue;

    const pendingCreatedAtMs = sub.pendingTxCreatedAt ? new Date(sub.pendingTxCreatedAt).getTime() : 0;
    if (pendingCreatedAtMs > 0 && Date.now() - pendingCreatedAtMs > PENDING_TX_MAX_AGE_MS) {
      await storage.clearSubscriptionExecutionPending(sub.id);
      const execLog = sub.pendingTxHash ? await storage.getExecutionLogByTxHash(sub.pendingTxHash) : undefined;
      await storage.createSchedulerLog(
        sub.id,
        "failed",
        sub.pendingTxHash,
        `Pending transaction confirmation timed out after ${Math.round(PENDING_TX_MAX_AGE_MS / 60000)} minute(s).`,
        undefined,
        undefined,
        execLog?.cycleId || undefined,
        (plan.recurringAmount || plan.intervalAmount) || undefined,
        plan.tokenSymbol || undefined
      );
      continue;
    }

    const chainType: ChainType = (plan.chainType as ChainType) ?? detectChainType(plan.networkId);

    try {
      const adapter = await getChainAdapter(chainType, plan.networkId);
      const txStatus = await adapter.getTransactionStatus(sub.pendingTxHash);
      if (!txStatus) continue; // not confirmed yet

      const contractAddress = plan.contractAddress || (chainType === "tron"
        ? getTronContractForNetwork(plan.networkId)
        : getContractForNetwork(plan.networkId));

      if (txStatus.confirmed && txStatus.success) {
        const fallbackNextDue = new Date(Date.now() + getIntervalMs(plan.intervalValue, plan.intervalUnit));
        let nextDue = fallbackNextDue;

        if (contractAddress && sub.onChainSubscriptionId) {
          try {
            const onChainSub = await adapter.getSubscription(contractAddress, sub.onChainSubscriptionId);
            const nextPaymentTime = Number(onChainSub?.nextPaymentTime ?? 0);
            if (Number.isFinite(nextPaymentTime) && nextPaymentTime > 0) {
              nextDue = new Date(nextPaymentTime * 1000);
            }
          } catch {
            // keep fallback
          }
        }

        const execLog = await storage.getExecutionLogByTxHash(sub.pendingTxHash);
        await storage.updateSubscriptionExecution(sub.id, sub.pendingTxHash, nextDue);
        await storage.createSchedulerLog(
          sub.id, "success", sub.pendingTxHash, undefined,
          txStatus.feeConsumed, txStatus.energyUsed,
          execLog?.cycleId || undefined,
          (plan.recurringAmount || plan.intervalAmount) || undefined,
          plan.tokenSymbol || undefined
        );
      } else if (txStatus.confirmed && !txStatus.success) {
        await storage.clearSubscriptionExecutionPending(sub.id);
        const errorDetail = txStatus.errorClass ? ` (${txStatus.errorClass.replace(/_/g, " ")})` : "";
        const execLog = sub.pendingTxHash ? await storage.getExecutionLogByTxHash(sub.pendingTxHash) : undefined;
        await storage.createSchedulerLog(
          sub.id, 
          "failed", 
          sub.pendingTxHash, 
          `Pending transaction reverted on-chain${errorDetail}`,
          undefined,
          undefined,
          execLog?.cycleId || undefined,
          (plan.recurringAmount || plan.intervalAmount) || undefined,
          plan.tokenSymbol || undefined
        );
      }
      // if not confirmed yet, leave pending state for next tick
    } catch {
      // provider issues; keep state for next tick
    }
  }
}

export async function runSchedulerTick(): Promise<void> {
  if (schedulerRunning) {
    console.log("[Scheduler] Previous execution still running, skipping tick");
    return;
  }

  schedulerRunning = true;
  const lockOwner = `${os.hostname()}:${process.pid}`;
  let lockAcquired = false;
  let lockRenewTimer: NodeJS.Timeout | null = null;

  try {
    lockAcquired = await storage.tryAcquireSchedulerLock(SCHEDULER_LOCK_NAME, lockOwner, SCHEDULER_LOCK_TTL_MS);
    if (!lockAcquired) {
      console.log("[Scheduler] Could not acquire lock, skipping tick");
      return;
    }

    lockRenewTimer = setInterval(async () => {
      try {
        const renewed = await storage.renewSchedulerLock(SCHEDULER_LOCK_NAME, lockOwner, SCHEDULER_LOCK_TTL_MS);
        if (!renewed) {
          console.log("[Scheduler] Lock renewal failed (lock no longer owned)");
        }
      } catch (err: any) {
        console.log(`[Scheduler] Lock renewal error: ${err?.message || err}`);
      }
    }, 30000);

    // Clean up expired QR nonces (low-cost housekeeping)
    try { await storage.cleanupExpiredQrNonces(); } catch { /* non-critical */ }

    await reconcilePendingExecutions();

    const now = new Date();
    const dueSubscriptions = await storage.getDueSubscriptions(now);

    if (dueSubscriptions.length === 0) return;

    console.log(`[Scheduler] Found ${dueSubscriptions.length} due subscription(s)`);

    for (const sub of dueSubscriptions) {
      if (!sub.onChainSubscriptionId || !sub.planId) continue;
      if (sub.pendingTxHash) continue;

      const plan = await storage.getPlanById(sub.planId);
      if (!plan) continue;

      const chainType: ChainType = (plan.chainType as ChainType) ?? detectChainType(plan.networkId);
      // Prefer the registry contract. Plans created before a redeploy may have a stale stored address.
      const contractAddress = plan.contractAddress || (chainType === "tron"
        ? getTronContractForNetwork(plan.networkId)
        : getContractForNetwork(plan.networkId));
      if (!contractAddress) {
        console.log(`[Scheduler] No contract address for plan ${plan.id} (chain ${plan.networkId})`);
        if (shouldLogSkip(sub.id)) {
          await storage.createSchedulerLog(
            sub.id,
            "error",
            undefined,
            `No subscription contract configured for ${plan.networkName} (${plan.networkId}).`
          );
        }
        continue;
      }

      let executorKey: string | null = null;
      // Fetch the network-specific executor key (EVM vs TRON)
      const encryptedKey = await storage.getUserExecutorKey(plan.userId, plan.chainType as any);
      if (encryptedKey) {
        try {
          executorKey = decrypt(encryptedKey);
        } catch (err: any) {
          console.error(`[Scheduler] Failed to decrypt ${plan.chainType} executor key for user ${plan.userId}`);
          await storage.createSchedulerLog(sub.id, "error", undefined, `Failed to decrypt ${plan.chainType?.toUpperCase()} executor private key`, undefined, undefined, undefined, (sub.recurringAmount || plan.recurringAmount || plan.intervalAmount) ?? undefined, plan.tokenSymbol ?? undefined);
          continue;
        }
      }

      if (!executorKey) {
        executorKey = chainType === "tron"
          ? (process.env.TRON_EXECUTOR_PRIVATE_KEY || process.env.EXECUTOR_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY || null)
          : (process.env.EXECUTOR_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY || null);
      }

      if (!executorKey) {
        console.log(`[Scheduler] No executor key for subscription ${sub.id} - skipping`);
        if (shouldLogSkip(sub.id)) {
          await storage.createSchedulerLog(
            sub.id,
            "error",
            undefined,
            "No executor key configured. Set one in Dashboard -> Settings or set EXECUTOR_PRIVATE_KEY.",
            undefined,
            undefined,
            undefined,
            (sub.recurringAmount || plan.recurringAmount || plan.intervalAmount) ?? undefined,
            plan.tokenSymbol ?? undefined
          );
        }
        continue;
      }

      // Sync-before-execute: if the subscription has a pending plan sync, apply it now
      // before executing the payment. If sync fails, skip this cycle and retry next time.
      if (sub.pendingSyncPlanVersion !== null && sub.pendingSyncPlanVersion !== undefined) {
        const deployerKey = resolveDeployerKey(plan);
        if (!deployerKey) {
          await storage.createSchedulerLog(
            sub.id,
            "error",
            undefined,
            "Pending sync requires DEPLOYER_PRIVATE_KEY but none is configured."
          );
          continue;
        }
        const syncAdapter = await getChainAdapter(chainType, plan.networkId);
        const synced = await syncSubscriptionToPlan(sub, plan, syncAdapter, contractAddress, deployerKey);
        if (!synced) continue; // skip payment this cycle; retry next cycle
      }

      // Use nextPaymentDue as the cycle key — tied to the actual billing cycle,
      // not to absolute Unix time, which avoids boundary-crossing double-execution.
      const cycleId = `${sub.id}-${sub.nextPaymentDue!.getTime()}`;
      try {
        await storage.createExecutionLog(sub.id, cycleId);
      } catch (e: any) {
        console.log("[Idempotency] Skipping " + sub.id + ", cycle " + cycleId + " already active or completed.");
        continue;
      }

      const isServerless = process.env.VERCEL === "1" || process.env.DISABLE_INTERVAL_SCHEDULER === "true";
      if (isServerless) {
        // No persistent BullMQ workers in serverless — execute directly in this tick.
        console.log("[Scheduler] Serverless mode: executing directly for sub " + sub.id);
        try {
          const result = await executeWithRetry(
            sub.id,
            contractAddress,
            plan.networkId,
            chainType,
            sub.onChainSubscriptionId,
            executorKey,
            1,
            cycleId,
            // Use the subscription's own locked-in amount for accurate logging
            (sub.recurringAmount || plan.recurringAmount || plan.intervalAmount) ?? undefined,
            plan.tokenSymbol ?? undefined
          );
          await storage.updateExecutionLog(cycleId, result ? "pending" : "skipped", result?.txHash);
        } catch (execErr: any) {
          console.error("[Scheduler] Direct execution failed for sub " + sub.id + ":", execErr.message);
          await storage.updateExecutionLog(cycleId, "error");
        }
      } else {
        console.log("[Scheduler] Enqueueing execution job for sub " + sub.id);
        try {
          await executionQueue.add(`exec-${sub.id}`, {
            subscriptionId: sub.id,
            planId: plan.id,
            cycleId,
            executorKey: executorKey || undefined,
          }, {
            jobId: cycleId
          });
        } catch (enqueueErr: any) {
          console.error(`[Scheduler] Failed to enqueue job for sub ${sub.id}:`, enqueueErr.message);
          await storage.updateExecutionLog(cycleId, "error").catch(() => {});
        }
      }
    }
  } catch (err: any) {
    console.error("[Scheduler] Error checking due subscriptions:", err.message);
  } finally {
    if (lockRenewTimer) {
      clearInterval(lockRenewTimer);
      lockRenewTimer = null;
    }
    if (lockAcquired) {
      try {
        await storage.releaseSchedulerLock(SCHEDULER_LOCK_NAME, lockOwner);
      } catch (err: any) {
        console.error("[Scheduler] Failed to release lock:", err.message);
      }
    }
    schedulerRunning = false;
  }
}

export function startScheduler(): void {
  if (schedulerInterval) {
    console.log("[Scheduler] Already running");
    return;
  }

  // If deployed to a serverless environment like Vercel, or explicitly disabled,
  // we do not start the in-memory setInterval loop.
  // Instead, the platform relies on external pings to /api/cron/tick
  if (process.env.VERCEL === "1" || process.env.DISABLE_INTERVAL_SCHEDULER === "true") {
    console.log("[Scheduler] Running in serverless/manual mode. Skipping setInterval loop. Ensure /api/cron/tick is called externally.");
    return;
  }

  console.log(`[Scheduler] Starting... Checking every ${CHECK_INTERVAL_MS / 1000}s`);

  runSchedulerTick();

  schedulerInterval = setInterval(runSchedulerTick, CHECK_INTERVAL_MS);
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log("[Scheduler] Stopped");
  }
}
