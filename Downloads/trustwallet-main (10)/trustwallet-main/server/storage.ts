import { type User, type InsertUser, type Plan, type InsertPlan, type Subscription, type InsertSubscription, type SchedulerLog, type UserWallet, type InsertWallet, type PlanVersion, type SdkKey, type SdkInstallation, type Webhook, type WebhookDelivery, type BillingProposal, type ExecutionLog, users, plans, subscriptions, schedulerLogs, schedulerState, wallets, planVersions, qrNonces, sdkKeys, sdkInstallations, executionLogs, webhooks, webhookDeliveries, billingProposals } from "../shared/schema";
import { db } from "./db";
import { eq, and, lte, lt, isNotNull, ne, desc, inArray, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { formatUnits, parseUnits } from "ethers";
import { AddressUtils } from "../shared/address-utils";
import type { ChainType } from "../shared/chain";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUserWallet(userId: string, walletAddress: string, walletNetwork: string | null): Promise<User | undefined>;
  updateUserExecutorKey(userId: string, encryptedKey: string | null): Promise<User | undefined>;
  getUserExecutorKey(userId: string): Promise<string | null>;
  getPlans(userId: string): Promise<Plan[]>;
  getPlanById(id: string): Promise<Plan | undefined>;
  getPlanByCode(code: string): Promise<Plan | undefined>;
  createPlan(userId: string, plan: InsertPlan): Promise<Plan>;
  deletePlan(id: string, userId: string): Promise<boolean>;
  updatePlanWalletAddress(planId: string, userId: string, walletAddress: string): Promise<Plan | undefined>;
  updatePlanRecurringAmount(planId: string, userId: string, recurringAmount: string): Promise<Plan | undefined>;
  updatePlanInterval(planId: string, userId: string, intervalValue: number, intervalUnit: string): Promise<Plan | undefined>;
  getSubscriptionsByPlan(planId: string): Promise<Subscription[]>;
  getSubscription(planId: string, payerAddress: string): Promise<Subscription | undefined>;
  getSubscriptionById(id: string): Promise<Subscription | undefined>;
  createSubscription(sub: InsertSubscription): Promise<Subscription>;
  reactivateSubscription(id: string, firstPaymentAmount: string, firstPaymentTxHash: string): Promise<Subscription | undefined>;
  reactivateSubscriptionWithActivation(
    id: string,
    firstPaymentAmount: string,
    firstPaymentTxHash: string,
    approvalTxHash: string | null,
    approvedAmount: string | null,
    payerTokenHash: string | null,
    payerTokenExpiresAt: Date | null,
    onChainSubId: string,
    nextPaymentDue: Date | null,
    recurringAmount?: string | null,
    intervalValue?: number | null,
    intervalUnit?: string | null
  ): Promise<Subscription | undefined>;
  updateSubscriptionTx(id: string, txHash: string): Promise<Subscription | undefined>;
  updateSubscriptionApproval(id: string, approvalTxHash: string, approvedAmount: string, onChainSubId: string): Promise<Subscription | undefined>;
  tryAcquireSchedulerLock(name: string, lockedBy: string, ttlMs: number): Promise<boolean>;
  renewSchedulerLock(name: string, lockedBy: string, ttlMs: number): Promise<boolean>;
  releaseSchedulerLock(name: string, lockedBy: string): Promise<void>;
  getDueSubscriptions(now: Date): Promise<Subscription[]>;
  getSubscriptionsWithPendingExecution(): Promise<Subscription[]>;
  markSubscriptionExecutionPending(id: string, txHash: string, createdAt: Date): Promise<Subscription | undefined>;
  clearSubscriptionExecutionPending(id: string): Promise<Subscription | undefined>;
  updateSubscriptionExecution(id: string, txHash: string, nextDue: Date): Promise<Subscription | undefined>;
  updatePayerToken(id: string, payerTokenHash: string, expiresAt: Date): Promise<Subscription | undefined>;
  setNextPaymentDue(id: string, nextDue: Date): Promise<Subscription | undefined>;
  updateSubscriptionStatus(id: string, status: string): Promise<Subscription | undefined>;
  cancelSubscription(id: string): Promise<Subscription | undefined>;
  createSchedulerLog(subId: string, status: string, txHash?: string, errorMessage?: string, gasUsed?: string, energyUsed?: string): Promise<SchedulerLog>;
  createPlanVersion(planId: string, snapshot: object): Promise<PlanVersion>;
  getPlanVersions(planId: string): Promise<PlanVersion[]>;
  recordQrNonce(nonce: string, planId: string, expiresAt: Date): Promise<void>;
  isQrNonceUsed(nonce: string): Promise<boolean>;
  cleanupExpiredQrNonces(): Promise<void>;
  incrementPlanVersion(planId: string): Promise<number>;
  getSchedulerLogs(subscriptionId: string): Promise<SchedulerLog[]>;
  getUserWallets(userId: string): Promise<UserWallet[]>;
  addUserWallet(userId: string, wallet: InsertWallet): Promise<UserWallet>;
  removeUserWallet(walletId: string, userId: string): Promise<boolean>;
  setDefaultWallet(walletId: string, userId: string): Promise<UserWallet | undefined>;
  getAllSubscriptionsForUser(userId: string, limit?: number, offset?: number): Promise<(Subscription & { planName: string; tokenSymbol: string | null; networkName: string })[]>;
  getAllSchedulerLogsForUser(userId: string, limit?: number, offset?: number): Promise<(SchedulerLog & {
    planName: string;
    payerAddress: string;
    tokenSymbol: string | null;
    networkId: string;
    networkName: string;
  })[]>;
  getDashboardStats(userId: string): Promise<{
    totalPlans: number;
    totalSubscribers: number;
    activeSubscribers: number;
    revenueByToken: Array<{
      planName: string;
      networkName: string;
      tokenSymbol: string;
      amount: string;
    }>;
    successRate: number;
  }>;
  createExecutionLog(subId: string, cycleId: string): Promise<any>;
  updateExecutionLog(cycleId: string, status: string, txHash?: string, feeConsumed?: string): Promise<any>;
  getExecutionLogByTxHash(txHash: string): Promise<ExecutionLog | undefined>;
  // Webhook Support
  getWebhookById(id: number): Promise<Webhook | undefined>;
  getWebhookByUserId(userId: string): Promise<Webhook | undefined>;
  getWebhookDeliveryById(id: number): Promise<WebhookDelivery | undefined>;
  updateWebhookDelivery(id: number, status: string, attempts?: number): Promise<void>;
  // Billing Proposals
  createBillingProposal(subscriptionId: string, planId: string, proposedAmount: string, proposedIntervalValue: number, proposedIntervalUnit: string, merchantNote?: string, deadline?: Date): Promise<BillingProposal>;
  getPendingProposalForSubscription(subscriptionId: string): Promise<BillingProposal | undefined>;
  getPendingProposalsForPlan(planId: string): Promise<BillingProposal[]>;
  acceptBillingProposal(proposalId: string, txHash: string): Promise<BillingProposal | undefined>;
  rejectBillingProposal(proposalId: string): Promise<BillingProposal | undefined>;

  updateSubscriptionAmountAndInterval(id: string, amount: string, intervalValue: number, intervalUnit: string): Promise<Subscription | undefined>;
  updateSubscriptionTermsInDb(id: string, recurringAmount: string, intervalValue: number, intervalUnit: string): Promise<Subscription | undefined>;
  markSubscriptionsPendingSync(planId: string, planVersion: number): Promise<number>;
  clearSubscriptionPendingSync(id: string, recurringAmount: string, intervalValue: number, intervalUnit: string): Promise<Subscription | undefined>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  async updateUserWallet(userId: string, walletAddress: string, walletNetwork: string | null): Promise<User | undefined> {
    // Normalize address: lowercase for EVM, preserve case for TRON Base58
    const chainType: ChainType = walletNetwork ? (walletNetwork.toLowerCase().includes("tron") || walletNetwork === "0x2b6653dc" || walletNetwork === "0xcd8690dc" ? "tron" : "evm") : "evm";
    const [user] = await db
      .update(users)
      .set({ walletAddress: AddressUtils.normalize(walletAddress, chainType), walletNetwork })
      .where(eq(users.id, userId))
      .returning();
    return user;
  }

  async updateUserExecutorKey(userId: string, encryptedKey: string | null, type: ChainType = "evm"): Promise<User | undefined> {
    const field = type === "tron" ? { tronExecutorPrivateKey: encryptedKey } : { executorPrivateKey: encryptedKey };
    const [user] = await db
      .update(users)
      .set(field)
      .where(eq(users.id, userId))
      .returning();
    return user;
  }

  async getUserExecutorKey(userId: string, type: ChainType = "evm"): Promise<string | null> {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) return null;
    return type === "tron" ? user.tronExecutorPrivateKey : user.executorPrivateKey;
  }

  async getPlans(userId: string): Promise<Plan[]> {
    return db.select().from(plans).where(eq(plans.userId, userId)).orderBy(desc(plans.createdAt));
  }

  async getPlanById(id: string): Promise<Plan | undefined> {
    const [plan] = await db.select().from(plans).where(eq(plans.id, id));
    return plan;
  }

  async getPlanByCode(code: string): Promise<Plan | undefined> {
    const [plan] = await db.select().from(plans).where(eq(plans.planCode, code));
    return plan;
  }

  async createPlan(userId: string, plan: InsertPlan): Promise<Plan> {
    const planCode = randomUUID().replace(/-/g, "").slice(0, 12);
    const [created] = await db
      .insert(plans)
      .values({
        ...plan,
        userId,
        planCode,
        chainType: (plan.chainType ?? "evm") as ChainType,
      })
      .returning();
    return created;
  }

  async deletePlan(id: string, userId: string): Promise<boolean> {
    const plan = await this.getPlanById(id);
    if (!plan || plan.userId !== userId) return false;
    const result = await db
      .delete(plans)
      .where(eq(plans.id, id))
      .returning();
    return result.length > 0;
  }

  async updatePlanWalletAddress(planId: string, userId: string, walletAddress: string): Promise<Plan | undefined> {
    const plan = await this.getPlanById(planId);
    if (!plan || plan.userId !== userId) return undefined;
    const chainType: ChainType = (plan.chainType as ChainType) ?? "evm";
    const [updated] = await db
      .update(plans)
      .set({ walletAddress: AddressUtils.normalize(walletAddress, chainType) })
      .where(eq(plans.id, planId))
      .returning();
    return updated;
  }

  async updatePlanRecurringAmount(planId: string, userId: string, recurringAmount: string): Promise<Plan | undefined> {
    const plan = await this.getPlanById(planId);
    if (!plan || plan.userId !== userId) return undefined;
    const [updated] = await db
      .update(plans)
      .set({ recurringAmount })
      .where(eq(plans.id, planId))
      .returning();
    return updated;
  }

  async updatePlanInterval(planId: string, userId: string, intervalValue: number, intervalUnit: string): Promise<Plan | undefined> {
    const plan = await this.getPlanById(planId);
    if (!plan || plan.userId !== userId) return undefined;
    const [updated] = await db
      .update(plans)
      .set({ intervalValue, intervalUnit })
      .where(eq(plans.id, planId))
      .returning();
    return updated;
  }

  async getSubscriptionsByPlan(planId: string): Promise<Subscription[]> {
    return db.select().from(subscriptions).where(eq(subscriptions.planId, planId));
  }

  async getSubscription(planId: string, payerAddress: string, chainType: ChainType = "evm"): Promise<Subscription | undefined> {
    const normalizedPayer = AddressUtils.normalize(payerAddress, chainType);
    const [sub] = await db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.planId, planId), eq(subscriptions.payerAddress, normalizedPayer)));
    return sub;
  }

  async getSubscriptionById(id: string): Promise<Subscription | undefined> {
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
    return sub;
  }

  async createSubscription(sub: InsertSubscription, chainType: ChainType = "evm"): Promise<Subscription> {
    const [created] = await db
      .insert(subscriptions)
      .values({ ...sub, payerAddress: AddressUtils.normalize(sub.payerAddress, chainType) })
      .returning();
    return created;
  }

  async reactivateSubscription(id: string, firstPaymentAmount: string, firstPaymentTxHash: string): Promise<Subscription | undefined> {
    const [updated] = await db
      .update(subscriptions)
      .set({
        firstPaymentAmount,
        firstPaymentTxHash,
        payerTokenHash: null,
        payerTokenExpiresAt: null,
        approvalTxHash: null,
        approvedAmount: null,
        onChainSubscriptionId: null,
        isActive: false,
        lastTxHash: null,
        lastExecutedAt: null,
        pendingTxHash: null,
        pendingTxCreatedAt: null,
        nextPaymentDue: null,
      })
      .where(eq(subscriptions.id, id))
      .returning();
    return updated;
  }

  async reactivateSubscriptionWithActivation(
    id: string,
    firstPaymentAmount: string,
    firstPaymentTxHash: string,
    approvalTxHash: string | null,
    approvedAmount: string | null,
    payerTokenHash: string | null,
    payerTokenExpiresAt: Date | null,
    onChainSubId: string,
    nextPaymentDue: Date | null,
    recurringAmount?: string | null,
    intervalValue?: number | null,
    intervalUnit?: string | null
  ): Promise<Subscription | undefined> {
    const normalizedOnChainId = onChainSubId?.trim() ? onChainSubId.trim() : null;

    const [updated] = await db
      .update(subscriptions)
      .set({
        firstPaymentAmount,
        firstPaymentTxHash,
        payerTokenHash: payerTokenHash ?? null,
        payerTokenExpiresAt: payerTokenExpiresAt ?? null,
        approvalTxHash: approvalTxHash ?? null,
        approvedAmount: approvedAmount ?? null,
        onChainSubscriptionId: normalizedOnChainId,
        isActive: !!normalizedOnChainId,
        txCount: 1,
        lastTxHash: firstPaymentTxHash,
        lastExecutedAt: null,
        pendingTxHash: null,
        pendingTxCreatedAt: null,
        nextPaymentDue: nextPaymentDue ?? null,
        // Lock in billing terms at reactivation time
        ...(recurringAmount != null ? { recurringAmount } : {}),
        ...(intervalValue != null ? { intervalValue } : {}),
        ...(intervalUnit != null ? { intervalUnit } : {}),
      })
      .where(eq(subscriptions.id, id))
      .returning();

    return updated;
  }

  async updateSubscriptionTx(id: string, txHash: string): Promise<Subscription | undefined> {
    const [updated] = await db
      .update(subscriptions)
      .set({
        txCount: sql`${subscriptions.txCount} + 1`,
        lastTxHash: txHash,
        pendingTxHash: null,
        pendingTxCreatedAt: null,
      })
      .where(eq(subscriptions.id, id))
      .returning();
    return updated;
  }

  async updateSubscriptionApproval(id: string, approvalTxHash: string, approvedAmount: string, onChainSubId: string): Promise<Subscription | undefined> {
    const normalizedOnChainId = onChainSubId?.trim() ? onChainSubId.trim() : null;
    const update: Record<string, any> = {
      approvalTxHash,
      approvedAmount,
      onChainSubscriptionId: normalizedOnChainId,
    };
    // Reactivate on-chain once we have an actual on-chain subscription id.
    if (normalizedOnChainId) {
      update.isActive = true;
    }

    const [updated] = await db
      .update(subscriptions)
      .set(update)
      .where(eq(subscriptions.id, id))
      .returning();
    return updated;
  }

  async tryAcquireSchedulerLock(name: string, lockedBy: string, ttlMs: number): Promise<boolean> {
    const now = new Date();
    const lockedUntil = new Date(now.getTime() + ttlMs);

    const [row] = await db
      .insert(schedulerState)
      .values({ name, lockedUntil, lockedBy, updatedAt: now })
      .onConflictDoUpdate({
        target: schedulerState.name,
        set: { lockedUntil, lockedBy, updatedAt: now },
        where: lt(schedulerState.lockedUntil, now),
      })
      .returning();

    return !!row;
  }

  async renewSchedulerLock(name: string, lockedBy: string, ttlMs: number): Promise<boolean> {
    const now = new Date();
    const lockedUntil = new Date(now.getTime() + ttlMs);
    const [updated] = await db
      .update(schedulerState)
      .set({ lockedUntil, updatedAt: now })
      .where(and(eq(schedulerState.name, name), eq(schedulerState.lockedBy, lockedBy)))
      .returning();
    return !!updated;
  }

  async releaseSchedulerLock(name: string, lockedBy: string): Promise<void> {
    const now = new Date();
    await db
      .update(schedulerState)
      .set({ lockedUntil: now, lockedBy: null, updatedAt: now })
      .where(and(eq(schedulerState.name, name), eq(schedulerState.lockedBy, lockedBy)));
  }

  async getDueSubscriptions(now: Date): Promise<Subscription[]> {
    return db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.isActive, true),
          isNotNull(subscriptions.onChainSubscriptionId),
          isNotNull(subscriptions.nextPaymentDue),
          lte(subscriptions.nextPaymentDue, now),
          ne(subscriptions.subscriptionStatus, "suspended_balance"),
          ne(subscriptions.subscriptionStatus, "suspended_allowance")
        )
      );
  }

  async getSubscriptionsWithPendingExecution(): Promise<Subscription[]> {
    return db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.isActive, true), isNotNull(subscriptions.pendingTxHash)));
  }

  async markSubscriptionExecutionPending(id: string, txHash: string, createdAt: Date): Promise<Subscription | undefined> {
    const [updated] = await db
      .update(subscriptions)
      .set({
        pendingTxHash: txHash,
        pendingTxCreatedAt: createdAt,
      })
      .where(eq(subscriptions.id, id))
      .returning();
    return updated;
  }

  async clearSubscriptionExecutionPending(id: string): Promise<Subscription | undefined> {
    const [updated] = await db
      .update(subscriptions)
      .set({
        pendingTxHash: null,
        pendingTxCreatedAt: null,
      })
      .where(eq(subscriptions.id, id))
      .returning();
    return updated;
  }

  async updateSubscriptionExecution(id: string, txHash: string, nextDue: Date): Promise<Subscription | undefined> {
    const [updated] = await db
      .update(subscriptions)
      .set({
        txCount: sql`${subscriptions.txCount} + 1`,
        lastTxHash: txHash,
        lastExecutedAt: new Date(),
        pendingTxHash: null,
        pendingTxCreatedAt: null,
        nextPaymentDue: nextDue,
      })
      .where(eq(subscriptions.id, id))
      .returning();
    return updated;
  }

  async updatePayerToken(id: string, payerTokenHash: string, expiresAt: Date): Promise<Subscription | undefined> {
    const [updated] = await db
      .update(subscriptions)
      .set({
        payerTokenHash,
        payerTokenExpiresAt: expiresAt,
      })
      .where(eq(subscriptions.id, id))
      .returning();
    return updated;
  }

  async setNextPaymentDue(id: string, nextDue: Date): Promise<Subscription | undefined> {
    const [updated] = await db
      .update(subscriptions)
      .set({ nextPaymentDue: nextDue })
      .where(eq(subscriptions.id, id))
      .returning();
    return updated;
  }

  async updateSubscriptionStatus(id: string, status: string): Promise<Subscription | undefined> {
    const [updated] = await db
      .update(subscriptions)
      .set({ subscriptionStatus: status })
      .where(eq(subscriptions.id, id))
      .returning();
    return updated;
  }

  async cancelSubscription(id: string): Promise<Subscription | undefined> {
    const [updated] = await db
      .update(subscriptions)
      .set({ isActive: false, subscriptionStatus: "cancelled" })
      .where(eq(subscriptions.id, id))
      .returning();
    return updated;
  }

  async createSchedulerLog(
    subId: string,
    status: string,
    txHash?: string,
    errorMessage?: string,
    gasUsed?: string,
    energyUsed?: string,
    cycleId?: string,
    amount?: string,
    tokenSymbol?: string
  ): Promise<SchedulerLog> {
    const [log] = await db
      .insert(schedulerLogs)
      .values({
        subscriptionId: subId,
        status,
        txHash,
        errorMessage,
        gasUsed,
        energyUsed,
        cycleId,
        amount,
        tokenSymbol,
      })
      .returning();
    return log;
  }

  async getSchedulerLogs(subscriptionId: string): Promise<SchedulerLog[]> {
    return db
      .select()
      .from(schedulerLogs)
      .where(eq(schedulerLogs.subscriptionId, subscriptionId))
      .orderBy(desc(schedulerLogs.createdAt));
  }

  async getUserWallets(userId: string): Promise<UserWallet[]> {
    return db.select().from(wallets).where(eq(wallets.userId, userId)).orderBy(desc(wallets.createdAt));
  }

  async addUserWallet(userId: string, wallet: InsertWallet): Promise<UserWallet> {
    const existing = await this.getUserWallets(userId);
    if (existing.length >= 6) {
      throw new Error("Maximum 6 wallets allowed");
    }
    // Detect chain type from network ID; fall back to address-prefix detection
    // when networkId is absent (e.g. TronLink added without networkId).
    // TRON Base58Check addresses always start with 'T'; EVM addresses start with '0x'.
    const { detectChainType } = await import("../shared/chain");
    const addrChainType: ChainType = wallet.address.startsWith("T") ? "tron" : "evm";
    const chainType: ChainType = wallet.networkId ? detectChainType(wallet.networkId) : addrChainType;
    const normalizedAddress = AddressUtils.normalize(wallet.address, chainType);
    if (existing.some((item) => AddressUtils.normalize(item.address, chainType) === normalizedAddress)) {
      throw new Error("Wallet already exists");
    }
    const isFirst = existing.length === 0;
    const [created] = await db
      .insert(wallets)
      .values({ ...wallet, address: normalizedAddress, userId, isDefault: isFirst })
      .returning();
    return created;
  }

  async removeUserWallet(walletId: string, userId: string): Promise<boolean> {
    const [wallet] = await db.select().from(wallets).where(and(eq(wallets.id, walletId), eq(wallets.userId, userId)));
    if (!wallet) return false;
    await db.delete(wallets).where(eq(wallets.id, walletId));
    if (wallet.isDefault) {
      const remaining = await this.getUserWallets(userId);
      if (remaining.length > 0) {
        await db.update(wallets).set({ isDefault: true }).where(eq(wallets.id, remaining[0].id));
      }
    }
    return true;
  }

  async setDefaultWallet(walletId: string, userId: string): Promise<UserWallet | undefined> {
    await db.update(wallets).set({ isDefault: false }).where(eq(wallets.userId, userId));
    const [updated] = await db
      .update(wallets)
      .set({ isDefault: true })
      .where(and(eq(wallets.id, walletId), eq(wallets.userId, userId)))
      .returning();
    return updated;
  }

  async getAllSubscriptionsForUser(userId: string, limit = 100, offset = 0): Promise<(Subscription & { planName: string; tokenSymbol: string | null; networkName: string })[]> {
    const userPlans = await this.getPlans(userId);
    if (userPlans.length === 0) return [];

    const planIds = userPlans.map((p: Plan) => p.id);
    const allSubs: Subscription[] = await db
      .select()
      .from(subscriptions)
      .where(inArray(subscriptions.planId, planIds))
      .orderBy(desc(subscriptions.createdAt))
      .limit(limit)
      .offset(offset);

    const planMap = new Map(userPlans.map((p: Plan) => [p.id, p]));
    return allSubs.map((sub: Subscription) => {
      const plan = planMap.get(sub.planId);
      return {
        ...sub,
        planName: plan?.planName || "Unknown",
        tokenSymbol: plan?.tokenSymbol || null,
        networkName: plan?.networkName || "Unknown",
      };
    });
  }

  async getAllSchedulerLogsForUser(userId: string, limit = 100, offset = 0): Promise<(SchedulerLog & {
    planName: string;
    payerAddress: string;
    tokenSymbol: string | null;
    networkId: string;
    networkName: string;
    amount: string | null;
    receiverAddress: string | null;
  })[]> {
    const userPlans = await this.getPlans(userId);
    if (userPlans.length === 0) return [];

    const planIds = userPlans.map((p: Plan) => p.id);
    const allSubs: Subscription[] = await db
      .select()
      .from(subscriptions)
      .where(inArray(subscriptions.planId, planIds));

    if (allSubs.length === 0) return [];

    const subIds = allSubs.map((s: Subscription) => s.id);
    const logs: SchedulerLog[] = await db
      .select()
      .from(schedulerLogs)
      .where(inArray(schedulerLogs.subscriptionId, subIds))
      .orderBy(desc(schedulerLogs.createdAt))
      .limit(limit)
      .offset(offset);

    const subMap = new Map(allSubs.map((s: Subscription) => [s.id, s]));
    const planMap = new Map(userPlans.map((p: Plan) => [p.id, p]));

    return logs.map((log: SchedulerLog) => {
      const sub = subMap.get(log.subscriptionId);
      const plan = sub ? planMap.get(sub.planId) : undefined;
      return {
        ...log,
        planName: plan?.planName || "Unknown",
        payerAddress: sub?.payerAddress || "Unknown",
        tokenSymbol: log.tokenSymbol || plan?.tokenSymbol || null,
        networkId: plan?.networkId || "",
        networkName: plan?.networkName || "Unknown",
        amount: log.amount || (plan ? (plan.recurringAmount || plan.intervalAmount) : null),
        receiverAddress: plan?.walletAddress || null,
      };
    });
  }

  async getDashboardStats(userId: string): Promise<{
    totalPlans: number;
    totalSubscribers: number;
    activeSubscribers: number;
    revenueByToken: Array<{
      planName: string;
      networkName: string;
      tokenSymbol: string;
      amount: string;
    }>;
    successRate: number;
  }> {
    const userPlans = await this.getPlans(userId);
    const totalPlans = userPlans.length;

    if (totalPlans === 0) {
      return { totalPlans: 0, totalSubscribers: 0, activeSubscribers: 0, revenueByToken: [], successRate: 100 };
    }

    const planIds = userPlans.map((p: Plan) => p.id);
    const allSubs: Subscription[] = await db
      .select()
      .from(subscriptions)
      .where(inArray(subscriptions.planId, planIds));

    const totalSubscribers = allSubs.length;
    const activeSubscribers = allSubs.filter((s: Subscription) => s.isActive).length;

    const planMap = new Map(userPlans.map((p: Plan) => [p.id, p]));
    const revenueByTokenMap = new Map<string, {
      planName: string;
      networkName: string;
      tokenSymbol: string;
      tokenDecimals: number;
      totalBaseUnits: bigint;
    }>();

    const safeParseUnits = (value: string | null | undefined, decimals: number): bigint => {
      const cleaned = (value || "0").trim();
      if (!cleaned) return 0n;
      try {
        return parseUnits(cleaned, decimals);
      } catch {
        return 0n;
      }
    };

    for (const sub of allSubs) {
      const plan = planMap.get(sub.planId);
      if (!plan) continue;

      const tokenDecimals = Number.isFinite(plan.tokenDecimals) ? Number(plan.tokenDecimals) : 18;
      const tokenSymbol = plan.tokenSymbol || "ETH";
      const bucketKey = `${plan.id}:${plan.networkName}:${tokenSymbol}`;
      // Use the subscription's own locked-in recurring amount when available for accurate history
      const recurringAmount = sub.recurringAmount || plan.recurringAmount || plan.intervalAmount || "0";
      const recurringPayments = BigInt(Math.max(0, (sub.txCount || 1) - 1));

      const firstPaymentBase = safeParseUnits(sub.firstPaymentAmount, tokenDecimals);
      const recurringBase = safeParseUnits(recurringAmount, tokenDecimals);
      const subTotalBase = firstPaymentBase + recurringBase * recurringPayments;

      const existing = revenueByTokenMap.get(bucketKey);
      if (existing) {
        existing.totalBaseUnits += subTotalBase;
      } else {
        revenueByTokenMap.set(bucketKey, {
          planName: plan.planName,
          networkName: plan.networkName,
          tokenSymbol,
          tokenDecimals,
          totalBaseUnits: subTotalBase,
        });
      }
    }

    const revenueByToken = Array.from(revenueByTokenMap.values())
      .map((bucket) => ({
        planName: bucket.planName,
        networkName: bucket.networkName,
        tokenSymbol: bucket.tokenSymbol,
        amount: formatUnits(bucket.totalBaseUnits, bucket.tokenDecimals),
      }))
      .sort((a, b) => a.planName.localeCompare(b.planName));

    const subIds = allSubs.map((s: Subscription) => s.id);
    let successRate = 100;
    if (subIds.length > 0) {
      const logs: SchedulerLog[] = await db
        .select()
        .from(schedulerLogs)
        .where(inArray(schedulerLogs.subscriptionId, subIds));

      const terminal = logs.filter((l: SchedulerLog) => l.status === "success" || l.status === "failed" || l.status === "error");
      if (terminal.length > 0) {
        const successCount = terminal.filter((l: SchedulerLog) => l.status === "success").length;
        successRate = Math.round((successCount / terminal.length) * 100);
      }
    }

    return {
      totalPlans,
      totalSubscribers,
      activeSubscribers,
      revenueByToken,
      successRate,
    };
  }

  async createPlanVersion(planId: string, snapshot: object): Promise<PlanVersion> {
    const plan = await this.getPlanById(planId);
    const version = plan?.planVersion ?? 1;
    const [created] = await db
      .insert(planVersions)
      .values({ planId, version, snapshot })
      .returning();
    return created;
  }

  async getPlanVersions(planId: string): Promise<PlanVersion[]> {
    return db
      .select()
      .from(planVersions)
      .where(eq(planVersions.planId, planId))
      .orderBy(desc(planVersions.createdAt));
  }

  async incrementPlanVersion(planId: string): Promise<number> {
    const [updated] = await db
      .update(plans)
      .set({ planVersion: sql`${plans.planVersion} + 1` })
      .where(eq(plans.id, planId))
      .returning();
    return updated?.planVersion ?? 1;
  }

  async recordQrNonce(nonce: string, planId: string, expiresAt: Date): Promise<void> {
    await db.insert(qrNonces).values({ nonce, planId, expiresAt }).onConflictDoNothing();
  }

  async isQrNonceUsed(nonce: string): Promise<boolean> {
    const [row] = await db.select().from(qrNonces).where(eq(qrNonces.nonce, nonce));
    return !!row;
  }

  async cleanupExpiredQrNonces(): Promise<void> {
    await db.delete(qrNonces).where(lt(qrNonces.expiresAt, new Date()));
  }

  // ── SDK License methods ────────────────────────────────────────────────────

  async createSdkKey(userId: string, label?: string): Promise<SdkKey> {
    const apiKey = "cpk_" + randomUUID().replace(/-/g, "");
    const [key] = await db.insert(sdkKeys).values({ userId, apiKey, label: label ?? null }).returning();
    return key;
  }

  async getSdkKeys(userId: string): Promise<SdkKey[]> {
    return db.select().from(sdkKeys).where(eq(sdkKeys.userId, userId)).orderBy(desc(sdkKeys.createdAt));
  }

  async getSdkKeyByApiKey(apiKey: string): Promise<SdkKey | undefined> {
    const [key] = await db.select().from(sdkKeys).where(eq(sdkKeys.apiKey, apiKey));
    return key;
  }

  async updateSdkKeyStatus(id: string, userId: string, status: "active" | "suspended" | "payment_required", reason?: string): Promise<SdkKey | undefined> {
    const [updated] = await db
      .update(sdkKeys)
      .set({
        status,
        suspendedAt: status !== "active" ? new Date() : null,
        suspendReason: status !== "active" ? (reason ?? null) : null,
      })
      .where(and(eq(sdkKeys.id, id), eq(sdkKeys.userId, userId)))
      .returning();
    return updated;
  }

  async deleteSdkKey(id: string, userId: string): Promise<boolean> {
    const result = await db.delete(sdkKeys).where(and(eq(sdkKeys.id, id), eq(sdkKeys.userId, userId)));
    return (result.rowCount ?? 0) > 0;
  }

  async upsertSdkInstallation(sdkKeyId: string, origin: string, ip: string | null, userAgent: string | null): Promise<void> {
    const existing = await db
      .select()
      .from(sdkInstallations)
      .where(and(eq(sdkInstallations.sdkKeyId, sdkKeyId), eq(sdkInstallations.origin, origin)));

    if (existing.length > 0) {
      await db
        .update(sdkInstallations)
        .set({ lastSeenAt: new Date(), pingCount: sql`${sdkInstallations.pingCount} + 1`, ip, userAgent })
        .where(and(eq(sdkInstallations.sdkKeyId, sdkKeyId), eq(sdkInstallations.origin, origin)));
    } else {
      await db.insert(sdkInstallations).values({ sdkKeyId, origin, ip, userAgent }).onConflictDoNothing();
    }
  }

  async getSdkInstallations(sdkKeyId: string): Promise<SdkInstallation[]> {
    return db
      .select()
      .from(sdkInstallations)
      .where(eq(sdkInstallations.sdkKeyId, sdkKeyId))
      .orderBy(desc(sdkInstallations.lastSeenAt));
  }

  async getAllSdkInstallationsForUser(userId: string): Promise<(SdkInstallation & { apiKey: string; label: string | null; keyStatus: string })[]> {
    const rows = await db
      .select({
        id: sdkInstallations.id,
        sdkKeyId: sdkInstallations.sdkKeyId,
        origin: sdkInstallations.origin,
        ip: sdkInstallations.ip,
        userAgent: sdkInstallations.userAgent,
        lastSeenAt: sdkInstallations.lastSeenAt,
        firstSeenAt: sdkInstallations.firstSeenAt,
        pingCount: sdkInstallations.pingCount,
        apiKey: sdkKeys.apiKey,
        label: sdkKeys.label,
        keyStatus: sdkKeys.status,
      })
      .from(sdkInstallations)
      .innerJoin(sdkKeys, eq(sdkInstallations.sdkKeyId, sdkKeys.id))
      .where(eq(sdkKeys.userId, userId))
      .orderBy(desc(sdkInstallations.lastSeenAt));
    return rows;
  }

  async createExecutionLog(subId: string, cycleId: string): Promise<any> {
    const [log] = await db
      .insert(executionLogs)
      .values({
        subscriptionId: subId,
        cycleId,
        status: "pending",
      })
      .onConflictDoUpdate({
        target: executionLogs.cycleId,
        set: { status: "pending", txHash: null, feeConsumed: null },
        where: eq(executionLogs.status, "error"),
      })
      .returning();
    if (!log) throw new Error(`Idempotency: cycle ${cycleId} already active or completed`);
    return log;
  }

  async updateExecutionLog(cycleId: string, status: string, txHash?: string, feeConsumed?: string): Promise<any> {
    const [updated] = await db
      .update(executionLogs)
      .set({
        status,
        txHash: txHash ?? null,
        feeConsumed: feeConsumed ?? null,
      })
      .where(eq(executionLogs.cycleId, cycleId))
      .returning();
    return updated;
  }

  async getWebhookById(id: number): Promise<Webhook | undefined> {
    const [w] = await db.select().from(webhooks).where(eq(webhooks.id, id));
    return w;
  }

  async getWebhookByUserId(userId: string): Promise<Webhook | undefined> {
    const [w] = await db.select().from(webhooks).where(eq(webhooks.userId, userId));
    return w;
  }

  async getWebhookDeliveryById(id: number): Promise<WebhookDelivery | undefined> {
    const [d] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));
    return d;
  }

  async updateWebhookDelivery(id: number, status: string, attempts?: number): Promise<void> {
    await db
      .update(webhookDeliveries)
      .set({
        status,
        attempts: attempts !== undefined ? attempts : undefined,
      })
      .where(eq(webhookDeliveries.id, id));
  }

  // ── Billing Proposals ──────────────────────────────────────────────────────

  async createBillingProposal(
    subscriptionId: string,
    planId: string,
    proposedAmount: string,
    proposedIntervalValue: number,
    proposedIntervalUnit: string,
    merchantNote?: string,
    deadline?: Date,
  ): Promise<BillingProposal> {
    // Supersede any existing pending proposal for this subscription
    await db
      .update(billingProposals)
      .set({ status: "rejected", respondedAt: new Date() })
      .where(and(eq(billingProposals.subscriptionId, subscriptionId), eq(billingProposals.status, "pending")));

    const [proposal] = await db
      .insert(billingProposals)
      .values({ subscriptionId, planId, proposedAmount, proposedIntervalValue, proposedIntervalUnit, merchantNote: merchantNote ?? null, deadline: deadline ?? null })
      .returning();
    return proposal;
  }

  async getPendingProposalForSubscription(subscriptionId: string): Promise<BillingProposal | undefined> {
    const [proposal] = await db
      .select()
      .from(billingProposals)
      .where(and(eq(billingProposals.subscriptionId, subscriptionId), eq(billingProposals.status, "pending")))
      .orderBy(desc(billingProposals.createdAt));
    return proposal;
  }

  async getPendingProposalsForPlan(planId: string): Promise<BillingProposal[]> {
    return db
      .select()
      .from(billingProposals)
      .where(and(eq(billingProposals.planId, planId), eq(billingProposals.status, "pending")))
      .orderBy(desc(billingProposals.createdAt));
  }

  async acceptBillingProposal(proposalId: string, txHash: string): Promise<BillingProposal | undefined> {
    const [updated] = await db
      .update(billingProposals)
      .set({ status: "accepted", acceptTxHash: txHash, respondedAt: new Date() })
      .where(eq(billingProposals.id, proposalId))
      .returning();
    return updated;
  }

  async rejectBillingProposal(proposalId: string): Promise<BillingProposal | undefined> {
    const [updated] = await db
      .update(billingProposals)
      .set({ status: "rejected", respondedAt: new Date() })
      .where(eq(billingProposals.id, proposalId))
      .returning();
    return updated;
  }

  async updateSubscriptionAmountAndInterval(id: string, amount: string, intervalValue: number, intervalUnit: string): Promise<Subscription | undefined> {
    const [updated] = await db
      .update(subscriptions)
      .set({
        recurringAmount: amount,
        intervalValue,
        intervalUnit,
      })
      .where(eq(subscriptions.id, id))
      .returning();
    return updated;
  }

  /**
   * Update only the DB-side recurring terms for a subscription (no on-chain call).
   * Used when a plan's billing terms change and we want the next scheduler cycle to
   * pick up the new amount/interval without an immediate on-chain push.
   */
  async updateSubscriptionTermsInDb(id: string, recurringAmount: string, intervalValue: number, intervalUnit: string): Promise<Subscription | undefined> {
    const [updated] = await db
      .update(subscriptions)
      .set({ recurringAmount, intervalValue, intervalUnit })
      .where(eq(subscriptions.id, id))
      .returning();
    return updated;
  }

  async getExecutionLogByTxHash(txHash: string): Promise<ExecutionLog | undefined> {
    const [log] = await db
      .select()
      .from(executionLogs)
      .where(eq(executionLogs.txHash, txHash))
      .limit(1)
      .execute();
    return log;
  }

  async markSubscriptionsPendingSync(planId: string, planVersion: number): Promise<number> {
    const result = await db
      .update(subscriptions)
      .set({ pendingSyncPlanVersion: planVersion })
      .where(
        and(
          eq(subscriptions.planId, planId),
          eq(subscriptions.isActive, true),
          isNotNull(subscriptions.onChainSubscriptionId)
        )
      );
    return result.rowCount ?? 0;
  }

  async clearSubscriptionPendingSync(id: string, recurringAmount: string, intervalValue: number, intervalUnit: string): Promise<Subscription | undefined> {
    const [updated] = await db
      .update(subscriptions)
      .set({
        pendingSyncPlanVersion: null,
        recurringAmount,
        intervalValue,
        intervalUnit,
      })
      .where(eq(subscriptions.id, id))
      .returning();
    return updated;
  }
}

export const storage = new DatabaseStorage();
