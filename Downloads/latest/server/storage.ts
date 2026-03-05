import { type User, type InsertUser, type Plan, type InsertPlan, type Subscription, type InsertSubscription, type SchedulerLog, type UserWallet, type InsertWallet, users, plans, subscriptions, schedulerLogs, schedulerState, wallets, normalizeAddress, compareAddresses } from "../shared/schema";
import { db } from "./db";
import { eq, and, lte, lt, isNotNull, desc, inArray, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { formatUnits, getAddress, parseUnits } from "ethers";

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
    nextPaymentDue: Date | null
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
  cancelSubscription(id: string): Promise<Subscription | undefined>;
  createSchedulerLog(subId: string, status: string, txHash?: string, errorMessage?: string, gasUsed?: string): Promise<SchedulerLog>;
  getSchedulerLogs(subscriptionId: string): Promise<SchedulerLog[]>;
  getUserWallets(userId: string): Promise<UserWallet[]>;
  addUserWallet(userId: string, wallet: InsertWallet): Promise<UserWallet>;
  removeUserWallet(walletId: string, userId: string): Promise<boolean>;
  setDefaultWallet(walletId: string, userId: string): Promise<UserWallet | undefined>;
  getAllSubscriptionsForUser(userId: string): Promise<(Subscription & { planName: string; tokenSymbol: string | null; networkName: string })[]>;
  getAllSchedulerLogsForUser(userId: string): Promise<(SchedulerLog & {
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
    const [user] = await db
      .update(users)
      .set({ walletAddress: normalizeAddress(walletAddress), walletNetwork })
      .where(eq(users.id, userId))
      .returning();
    return user;
  }

  async updateUserExecutorKey(userId: string, encryptedKey: string | null): Promise<User | undefined> {
    const [user] = await db
      .update(users)
      .set({ executorPrivateKey: encryptedKey })
      .where(eq(users.id, userId))
      .returning();
    return user;
  }

  async getUserExecutorKey(userId: string): Promise<string | null> {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    return user?.executorPrivateKey || null;
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
    const [updated] = await db
      .update(plans)
      .set({ walletAddress: normalizeAddress(walletAddress) })
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

  async getSubscription(planId: string, payerAddress: string): Promise<Subscription | undefined> {
    const normalized = normalizeAddress(payerAddress);
    const [sub] = await db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.planId, planId), eq(subscriptions.payerAddress, normalized)));
    return sub;
  }

  async getSubscriptionById(id: string): Promise<Subscription | undefined> {
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
    return sub;
  }

  async createSubscription(sub: InsertSubscription): Promise<Subscription> {
    const normalized = normalizeAddress(sub.payerAddress);
    const [created] = await db
      .insert(subscriptions)
      .values({ ...sub, payerAddress: normalized })
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
    nextPaymentDue: Date | null
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
          lte(subscriptions.nextPaymentDue, now)
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

  async cancelSubscription(id: string): Promise<Subscription | undefined> {
    const [updated] = await db
      .update(subscriptions)
      .set({ isActive: false })
      .where(eq(subscriptions.id, id))
      .returning();
    return updated;
  }

  async createSchedulerLog(subId: string, status: string, txHash?: string, errorMessage?: string, gasUsed?: string): Promise<SchedulerLog> {
    const [log] = await db
      .insert(schedulerLogs)
      .values({ subscriptionId: subId, status, txHash, errorMessage, gasUsed })
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
    // We rely on compareAddresses (which handles both TRON and EVM correctly) 
    // to check for existing wallets without mangling the address here.
    if (existing.some((item) => compareAddresses(item.address, wallet.address))) {
      throw new Error("Wallet already exists");
    }
    const isFirst = existing.length === 0;
    const [created] = await db
      .insert(wallets)
      .values({ ...wallet, address: wallet.address, userId, isDefault: isFirst })
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

  async getAllSubscriptionsForUser(userId: string): Promise<(Subscription & { planName: string; tokenSymbol: string | null; networkName: string })[]> {
    const userPlans = await this.getPlans(userId);
    if (userPlans.length === 0) return [];

    const planIds = userPlans.map((p: Plan) => p.id);
    const allSubs: Subscription[] = await db
      .select()
      .from(subscriptions)
      .where(inArray(subscriptions.planId, planIds))
      .orderBy(desc(subscriptions.createdAt));

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

  async getAllSchedulerLogsForUser(userId: string): Promise<(SchedulerLog & {
    planName: string;
    payerAddress: string;
    tokenSymbol: string | null;
    networkId: string;
    networkName: string;
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
      .orderBy(desc(schedulerLogs.createdAt));

    const subMap = new Map(allSubs.map((s: Subscription) => [s.id, s]));
    const planMap = new Map(userPlans.map((p: Plan) => [p.id, p]));

    return logs.map((log: SchedulerLog) => {
      const sub = subMap.get(log.subscriptionId);
      const plan = sub ? planMap.get(sub.planId) : undefined;
      return {
        ...log,
        planName: plan?.planName || "Unknown",
        payerAddress: sub?.payerAddress || "Unknown",
        tokenSymbol: plan?.tokenSymbol || null,
        networkId: plan?.networkId || "",
        networkName: plan?.networkName || "Unknown",
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
      const recurringAmount = plan.recurringAmount || plan.intervalAmount || "0";
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
}

export const storage = new DatabaseStorage();
