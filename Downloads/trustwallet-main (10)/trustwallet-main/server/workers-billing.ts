import { Worker, Job } from "bullmq";
import { connection } from "./queue";
import { storage } from "./storage";
import { getChainAdapter } from "./chain-adapter";
import { decrypt, decryptKms } from "./crypto";
import { getContractForNetwork } from "../shared/contracts";
import { getTronContractForNetwork } from "../shared/tron-contracts";
import { detectChainType, type ChainType } from "../shared/chain";

export const billingWorker = new Worker(
  "billing-execution",
  async (job: Job) => {
    const { subscriptionId, planId, cycleId, executorKey: jobExecutorKey } = job.data;
    
    console.log(`[BillingWorker] Executing job #${job.id} for subscription ${subscriptionId}`);
    
    const plan = await storage.getPlanById(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);

    const chainType: ChainType = (plan.chainType as ChainType) ?? detectChainType(plan.networkId);
    const contractAddress = plan.contractAddress || (chainType === "tron"
      ? getTronContractForNetwork(plan.networkId)
      : getContractForNetwork(plan.networkId));
    
    if (!contractAddress) throw new Error(`No contract configured for ${plan.networkId}`);

    const sub = await storage.getSubscriptionById(subscriptionId);
    if (!sub || !sub.onChainSubscriptionId) throw new Error(`Subscription ${subscriptionId} not found or not active`);

    let executorKey = jobExecutorKey;
    if (!executorKey) {
      const encryptedKey = await storage.getUserExecutorKey(plan.userId, plan.chainType as any);
      if (encryptedKey) {
          executorKey = await decryptKms(encryptedKey);
      }
    }

    if (!executorKey) {
      executorKey = chainType === "tron"
        ? (process.env.TRON_EXECUTOR_PRIVATE_KEY || process.env.EXECUTOR_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY)
        : (process.env.EXECUTOR_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY);
    }

    if (!executorKey) throw new Error(`No executor key found for subscription ${subscriptionId}`);

    const adapter = await getChainAdapter(chainType, plan.networkId);
    
    try {
      // Pre-flight checks
      const isDue = await adapter.isDue(contractAddress, sub.onChainSubscriptionId, executorKey);
      if (!isDue) {
          console.log(`[BillingWorker] Sub #${sub.onChainSubscriptionId} not due, skipping.`);
          await storage.updateExecutionLog(cycleId, "skipped");
          return { status: "not_due" };
      }

      const hasBalance = await adapter.hasMinimumExecutorBalance(executorKey);
      if (!hasBalance) {
          throw new Error("Executor wallet has insufficient balance");
      }

      await storage.createSchedulerLog(subscriptionId, "started", undefined, undefined, undefined, undefined, cycleId, (plan.recurringAmount || plan.intervalAmount) ?? undefined, plan.tokenSymbol ?? undefined);
      const result = await adapter.executeSubscription(contractAddress, sub.onChainSubscriptionId, executorKey);

      if (result.txHash === "renting_energy") {
        await storage.updateExecutionLog(cycleId, "failed");
        return { status: "renting_energy" };
      }

      await storage.markSubscriptionExecutionPending(subscriptionId, result.txHash, new Date());
      await storage.createSchedulerLog(subscriptionId, "pending", result.txHash, undefined, undefined, undefined, cycleId, (plan.recurringAmount || plan.intervalAmount) ?? undefined, plan.tokenSymbol ?? undefined);
      
      // Update execution log for internal tracking
      await storage.updateExecutionLog(cycleId, "pending", result.txHash);

      return { txHash: result.txHash, status: "broadcast" };
    } catch (err: any) {
      console.error(`[BillingWorker] Job #${job.id} failed:`, err.message);
      await storage.createSchedulerLog(subscriptionId, "failed", undefined, err.message, undefined, undefined, cycleId, (plan?.recurringAmount || plan?.intervalAmount) ?? undefined, plan?.tokenSymbol ?? undefined);
      await storage.updateExecutionLog(cycleId, "error");
      throw err; // Allow BullMQ to retry
    }
  },
  { connection }
);

billingWorker.on("failed", (job, err) => {
  console.error(`[BillingWorker] Job #${job?.id} permanently failed: ${err.message}`);
});
