import { Wallet, Contract } from "ethers";
import { storage } from "./storage";
import { SUBSCRIPTION_CONTRACT_ABI, getContractForNetwork } from "../shared/contracts";
import { decrypt } from "./crypto";
import { getRpcUrls, makeJsonRpcProvider } from "./rpc";
import { TronWeb } from "tronweb";
import os from "node:os";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const CHECK_INTERVAL_MS = Math.max(
  5000,
  Number.parseInt(process.env.SCHEDULER_CHECK_INTERVAL_MS || "15000", 10) || 15000
);
const SCHEDULER_LOCK_NAME = "scheduler";
// Should comfortably exceed worst-case tick duration (multiple subs + retries + tx confirmations).
const SCHEDULER_LOCK_TTL_MS = 10 * 60 * 1000;
const MIN_EXECUTOR_BALANCE_WEI = BigInt("50000000000000"); // 0.00005 ETH
const TX_CONFIRMATIONS = Math.max(1, Number.parseInt(process.env.TX_CONFIRMATIONS || "3", 10) || 3);
const PENDING_TX_MAX_AGE_MS = Math.max(
  60_000,
  Number.parseInt(process.env.PENDING_TX_MAX_AGE_MS || "1800000", 10) || 1_800_000
);

let schedulerInterval: NodeJS.Timeout | null = null;
let schedulerRunning = false;

const SKIP_LOG_THROTTLE_MS = 30 * 60 * 1000;
const lastSkipLogAtBySubscriptionId = new Map<string, number>();

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
  onChainSubId: string,
  executorKey: string,
  attempt = 1
): Promise<{ txHash: string; gasUsed: string; nextPaymentTimeMs: number | null } | null> {
  let sentTxHash: string | null = null;

  const rpcUrls = getRpcUrls(chainId);
  if (rpcUrls.length === 0) {
    console.log(`[Scheduler] No RPC URL for chain ${chainId}`);
    await storage.createSchedulerLog(subscriptionId, "error", undefined, `No RPC URL for chain ${chainId}`);
    return null;
  }

  try {
    const rpcUrl = rpcUrls[(attempt - 1) % rpcUrls.length];
    const provider = makeJsonRpcProvider(rpcUrl, chainId);
    const wallet = new Wallet(executorKey, provider);
    const contract = new Contract(contractAddress, SUBSCRIPTION_CONTRACT_ABI, wallet);

    const nativeBalance = await provider.getBalance(wallet.address);
    if (nativeBalance < MIN_EXECUTOR_BALANCE_WEI) {
      console.log(`[Scheduler] Executor wallet has insufficient gas on ${chainId}: ${nativeBalance}`);
      await storage.createSchedulerLog(
        subscriptionId,
        "error",
        undefined,
        "Executor wallet has insufficient native token to pay gas. Fund the executor wallet and try again."
      );
      return null;
    }

    const isDue = await contract.isDue(BigInt(onChainSubId));
    if (!isDue) {
      console.log(`[Scheduler] Subscription #${onChainSubId} not yet due`);
      try {
        const onChainSub = await contract.getSubscription(BigInt(onChainSubId));
        const nextPaymentTime = Number(onChainSub?.nextPaymentTime ?? onChainSub?.[5] ?? 0);
        if (Number.isFinite(nextPaymentTime) && nextPaymentTime > 0) {
          await storage.setNextPaymentDue(subscriptionId, new Date(nextPaymentTime * 1000));
        }
      } catch (syncErr: any) {
        console.log(`[Scheduler] Failed to sync next due from chain for #${onChainSubId}: ${syncErr?.message || syncErr}`);
      }
      return null;
    }

    const hasAllowance = await contract.hasEnoughAllowance(BigInt(onChainSubId));
    if (!hasAllowance) {
      console.log(`[Scheduler] Subscription #${onChainSubId} insufficient allowance`);
      await storage.createSchedulerLog(subscriptionId, "insufficient_allowance", undefined, "Sender has insufficient token allowance");
      return null;
    }

    const gasEstimate = await contract.executeSubscription.estimateGas(BigInt(onChainSubId));
    const gasLimit = gasEstimate * BigInt(120) / BigInt(100);

    const tx = await contract.executeSubscription(BigInt(onChainSubId), { gasLimit });
    sentTxHash = tx.hash;
    await storage.markSubscriptionExecutionPending(subscriptionId, tx.hash, new Date());
    await storage.createSchedulerLog(subscriptionId, "pending", tx.hash);
    console.log(`[Scheduler] TX sent: ${tx.hash}`);

    const receipt = await tx.wait(TX_CONFIRMATIONS);
    const gasUsed = receipt.gasUsed.toString();
    let nextPaymentTimeMs: number | null = null;
    try {
      const onChainSub = await contract.getSubscription(BigInt(onChainSubId));
      const nextPaymentTime = Number(onChainSub?.nextPaymentTime ?? onChainSub?.[5] ?? 0);
      if (Number.isFinite(nextPaymentTime) && nextPaymentTime > 0) {
        nextPaymentTimeMs = nextPaymentTime * 1000;
      }
    } catch {
      // ignore; fallback is used by caller
    }

    console.log(`[Scheduler] TX confirmed: ${receipt.hash}, gas: ${gasUsed}`);
    return { txHash: receipt.hash, gasUsed, nextPaymentTimeMs };
  } catch (err: any) {
    console.error(`[Scheduler] Attempt ${attempt}/${MAX_RETRIES} failed:`, err.message);
    const lowerMsg = String(err?.message || "").toLowerCase();
    const isIntrinsicFundsError =
      lowerMsg.includes("insufficient funds") ||
      lowerMsg.includes("intrinsic transaction cost") ||
      lowerMsg.includes("gas required exceeds allowance") ||
      lowerMsg.includes("base fee exceeds gas limit");

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
        "Executor wallet does not have enough native coin for gas (intrinsic transaction cost). Fund executor and retry."
      );
      // No retry until gas is funded.
      return null;
    }

    if (attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
      return executeWithRetry(subscriptionId, contractAddress, chainId, onChainSubId, executorKey, attempt + 1);
    }

    await storage.createSchedulerLog(subscriptionId, "failed", undefined, err.message);
    return null;
  }
}

async function executeTronSubscriptionWithRetry(
  subscriptionId: string,
  contractAddress: string,
  chainId: string,
  onChainSubId: string,
  executorKey: string,
  attempt = 1
): Promise<{ txHash: string; gasUsed: string; nextPaymentTimeMs: number | null } | null> {
  const rpcUrls = getRpcUrls(chainId);
  if (rpcUrls.length === 0) {
    console.log(`[Scheduler] No TRON RPC URL for chain ${chainId}`);
    await storage.createSchedulerLog(subscriptionId, "error", undefined, `No RPC URL for chain ${chainId}`);
    return null;
  }

  try {
    const rpcUrl = rpcUrls[(attempt - 1) % rpcUrls.length];
    const tronWeb = new TronWeb({
      fullHost: rpcUrl,
      privateKey: executorKey,
    });

    const contract = await tronWeb.contract().at(contractAddress);

    // 1. Check if due
    const isDue = await contract.isDue(onChainSubId).call();
    if (!isDue) {
      console.log(`[Scheduler] TRON Subscription #${onChainSubId} not yet due`);
      try {
        const subData = await contract.getSubscription(onChainSubId).call();
        const nextPaymentTime = Number(subData.nextPaymentTime || 0);
        if (nextPaymentTime > 0) {
          await storage.setNextPaymentDue(subscriptionId, new Date(nextPaymentTime * 1000));
        }
      } catch (e) {
        console.log(`[Scheduler] Failed to sync next due for TRON #${onChainSubId}`);
      }
      return null;
    }

    // 2. Check allowance
    const hasAllowance = await contract.hasEnoughAllowance(onChainSubId).call();
    if (!hasAllowance) {
      console.log(`[Scheduler] TRON Subscription #${onChainSubId} insufficient allowance`);
      await storage.createSchedulerLog(subscriptionId, "insufficient_allowance", undefined, "Sender has insufficient TRC-20 allowance");
      return null;
    }

    // 3. Execute
    const txHash = await contract.executeSubscription(onChainSubId).send();
    console.log(`[Scheduler] TRON TX sent: ${txHash}`);

    await storage.markSubscriptionExecutionPending(subscriptionId, txHash, new Date());
    await storage.createSchedulerLog(subscriptionId, "pending", txHash);

    // Wait for confirmation (simple poll for TRON)
    let receipt = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        receipt = await tronWeb.trx.getTransactionInfo(txHash);
        if (receipt && receipt.id) break;
      } catch {}
    }

    if (!receipt || receipt.result === "FAILED") {
      throw new Error(receipt?.resMessage || "TRON transaction failed or timed out");
    }

    let nextPaymentTimeMs: number | null = null;
    try {
      const subData = await contract.getSubscription(onChainSubId).call();
      const nextPaymentTime = Number(subData.nextPaymentTime || 0);
      if (nextPaymentTime > 0) {
        nextPaymentTimeMs = nextPaymentTime * 1000;
      }
    } catch {}

    console.log(`[Scheduler] TRON TX confirmed: ${txHash}`);
    return { txHash, gasUsed: "0", nextPaymentTimeMs }; // TRON gasUsed is in energy/bandwidth, mapping to "0" for now

  } catch (err: any) {
    console.error(`[Scheduler] TRON Attempt ${attempt}/${MAX_RETRIES} failed:`, err.message);
    if (attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
      return executeTronSubscriptionWithRetry(subscriptionId, contractAddress, chainId, onChainSubId, executorKey, attempt + 1);
    }
    await storage.createSchedulerLog(subscriptionId, "failed", undefined, err.message);
    return null;
  }
}

function getIntervalMs(value: number, unit: string): number {
  const multipliers: Record<string, number> = {
    sec: 1000,
    min: 60 * 1000,
    hrs: 3600 * 1000,
    days: 86400 * 1000,
    months: 2592000 * 1000,
  };
  return value * (multipliers[unit] || 1000);
}

async function reconcilePendingExecutions(): Promise<void> {
  const pendingSubs = await storage.getSubscriptionsWithPendingExecution();
  if (pendingSubs.length === 0) return;

  for (const sub of pendingSubs) {
    if (!sub.pendingTxHash || !sub.planId) continue;

    const pendingCreatedAtMs = sub.pendingTxCreatedAt ? new Date(sub.pendingTxCreatedAt).getTime() : 0;
    if (pendingCreatedAtMs > 0 && Date.now() - pendingCreatedAtMs > PENDING_TX_MAX_AGE_MS) {
      await storage.clearSubscriptionExecutionPending(sub.id);
      await storage.createSchedulerLog(
        sub.id,
        "failed",
        sub.pendingTxHash,
        `Pending transaction confirmation timed out after ${Math.round(PENDING_TX_MAX_AGE_MS / 60000)} minute(s).`
      );
      continue;
    }

    const plan = await storage.getPlanById(sub.planId);
    if (!plan) continue;

    const isTron = plan.networkId.startsWith("tron_");
    const rpcUrls = getRpcUrls(plan.networkId);
    if (rpcUrls.length === 0) continue;
    const contractAddress = getContractForNetwork(plan.networkId) || plan.contractAddress;

    let resolved = false;
    for (const rpcUrl of rpcUrls) {
      try {
        if (isTron) {
          const tronWeb = new TronWeb({ fullHost: rpcUrl });
          const txInfo = await tronWeb.trx.getTransactionInfo(sub.pendingTxHash);
          if (!txInfo || !txInfo.id) continue;

          if (txInfo.result !== "FAILED") {
             let nextDue = new Date(Date.now() + getIntervalMs(plan.intervalValue, plan.intervalUnit));
             if (contractAddress && sub.onChainSubscriptionId) {
               try {
                 const contract = await tronWeb.contract().at(contractAddress);
                 const subData = await contract.getSubscription(sub.onChainSubscriptionId).call();
                 const nextPaymentTime = Number(subData.nextPaymentTime || 0);
                 if (nextPaymentTime > 0) {
                   nextDue = new Date(nextPaymentTime * 1000);
                 }
               } catch (e) {
                 console.log(`[Scheduler] TRON reconcile failed to sync next due for #${sub.onChainSubscriptionId}`);
               }
             }
             await storage.updateSubscriptionExecution(sub.id, sub.pendingTxHash, nextDue);
             await storage.createSchedulerLog(sub.id, "success", sub.pendingTxHash, undefined, "0");
          } else {
             await storage.clearSubscriptionExecutionPending(sub.id);
             await storage.createSchedulerLog(sub.id, "failed", sub.pendingTxHash, "TRON transaction failed on-chain");
          }
          resolved = true;
          break;
        }

        const provider = makeJsonRpcProvider(rpcUrl, plan.networkId);
        const receipt = await provider.getTransactionReceipt(sub.pendingTxHash);
        if (!receipt) continue;

        if (receipt.status === 1) {
          const fallbackNextDue = new Date(Date.now() + getIntervalMs(plan.intervalValue, plan.intervalUnit));
          let nextDue = fallbackNextDue;

          if (contractAddress && sub.onChainSubscriptionId) {
            try {
              const contract = new Contract(contractAddress, SUBSCRIPTION_CONTRACT_ABI, provider);
              const onChainSub = await contract.getSubscription(BigInt(sub.onChainSubscriptionId));
              const nextPaymentTime = Number(onChainSub?.nextPaymentTime ?? onChainSub?.[5] ?? 0);
              if (Number.isFinite(nextPaymentTime) && nextPaymentTime > 0) {
                nextDue = new Date(nextPaymentTime * 1000);
              }
            } catch {
              // keep fallback
            }
          }

          await storage.updateSubscriptionExecution(sub.id, receipt.hash, nextDue);
          await storage.createSchedulerLog(sub.id, "success", receipt.hash, undefined, receipt.gasUsed?.toString());
        } else {
          await storage.clearSubscriptionExecutionPending(sub.id);
          await storage.createSchedulerLog(sub.id, "failed", sub.pendingTxHash, "Pending transaction reverted on-chain");
        }

        resolved = true;
        break;
      } catch {
        // try next RPC
      }
    }

    if (!resolved) {
      // still pending or provider issues; keep state for next tick
      continue;
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

      const isTron = plan.networkId.startsWith("tron_");
      
      // Prefer the registry contract (shared/contracts.ts). Plans created before a redeploy may have a stale stored address.
      const contractAddress = getContractForNetwork(plan.networkId) || plan.contractAddress;
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
      const encryptedKey = await storage.getUserExecutorKey(plan.userId);
      if (encryptedKey) {
        try {
          executorKey = decrypt(encryptedKey);
        } catch (err: any) {
          console.error(`[Scheduler] Failed to decrypt executor key for user ${plan.userId}`);
          await storage.createSchedulerLog(sub.id, "error", undefined, "Failed to decrypt executor private key");
          continue;
        }
      }

      if (!executorKey) {
        executorKey = process.env.EXECUTOR_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY || null;
      }

      if (!executorKey) {
        console.log(`[Scheduler] No executor key for subscription ${sub.id} - skipping`);
        if (shouldLogSkip(sub.id)) {
          await storage.createSchedulerLog(
            sub.id,
            "error",
            undefined,
            "No executor key configured. Set one in Dashboard -> Settings or set EXECUTOR_PRIVATE_KEY."
          );
        }
        continue;
      }

      console.log(`[Scheduler] Executing ${isTron ? "TRON " : ""}subscription ${sub.id} (on-chain #${sub.onChainSubscriptionId})`);

      let result: { txHash: string; gasUsed: string; nextPaymentTimeMs: number | null } | null = null;

      if (isTron) {
        result = await executeTronSubscriptionWithRetry(
          sub.id,
          contractAddress,
          plan.networkId,
          sub.onChainSubscriptionId,
          executorKey
        );
      } else {
        result = await executeWithRetry(
          sub.id,
          contractAddress,
          plan.networkId,
          sub.onChainSubscriptionId,
          executorKey
        );
      }

      if (result) {
        const intervalMs = getIntervalMs(plan.intervalValue, plan.intervalUnit);
        const nextDue = result.nextPaymentTimeMs
          ? new Date(result.nextPaymentTimeMs)
          : new Date(now.getTime() + intervalMs);

        await storage.updateSubscriptionExecution(sub.id, result.txHash, nextDue);
        await storage.createSchedulerLog(sub.id, "success", result.txHash, undefined, result.gasUsed);

        console.log(`[Scheduler] Subscription ${sub.id} executed successfully. Next due: ${nextDue.toISOString()}`);
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
