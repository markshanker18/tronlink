import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, boolean, json, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

/** Normalize an address for storage — preserves original casing for display. */
export function normalizeAddress(value: string | null | undefined): string {
  if (!value) return "";
  return value.trim();
}

export const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
export const TRON_ADDRESS_REGEX = /^[Tt][a-zA-Z0-9]{33}$/;

/** Check if a string is a valid EVM or TRON address. */
export function isValidAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  const s = addr.trim();
  return EVM_ADDRESS_REGEX.test(s) || TRON_ADDRESS_REGEX.test(s);
}

/** Check if two addresses are effectively the same based on their format. */
export function compareAddresses(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return a === b;
  const s1 = a.trim();
  const s2 = b.trim();
  
  // TRON addresses (34 chars, starts with T/t) are case-sensitive
  const isTron = (addr: string) => /^[Tt]/.test(addr) && addr.length === 34;
  if (isTron(s1) || isTron(s2)) {
    return s1 === s2;
  }
  console.log(s1,s2,"-----------------------------");
  // EVM addresses are case-insensitive
  return s1.toLowerCase() === s2.toLowerCase();
}

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  walletAddress: text("wallet_address"),
  walletNetwork: text("wallet_network"),
  executorPrivateKey: text("executor_private_key"),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const wallets = pgTable("wallets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  address: text("address").notNull(),
  label: text("label"),
  networkId: text("network_id"),
  networkName: text("network_name"),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertWalletSchema = createInsertSchema(wallets).pick({
  address: true,
  label: true,
  networkId: true,
  networkName: true,
});

export type InsertWallet = z.infer<typeof insertWalletSchema>;
export type UserWallet = typeof wallets.$inferSelect;

export const plans = pgTable("plans", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  planName: text("plan_name").notNull(),
  walletAddress: text("wallet_address").notNull(),
  networkId: text("network_id").notNull(),
  networkName: text("network_name").notNull(),
  tokenAddress: text("token_address"),
  tokenSymbol: text("token_symbol"),
  tokenDecimals: integer("token_decimals"),
  intervalAmount: text("interval_amount").notNull(),
  intervalValue: integer("interval_value").notNull(),
  intervalUnit: text("interval_unit").notNull(),
  planCode: text("plan_code").notNull().unique(),
  recurringAmount: text("recurring_amount"),
  contractAddress: text("contract_address"),
  videoUrl: text("video_url"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertPlanSchema = createInsertSchema(plans).pick({
  planName: true,
  walletAddress: true,
  networkId: true,
  networkName: true,
  intervalAmount: true,
  intervalValue: true,
  intervalUnit: true,
  tokenAddress: true,
  tokenSymbol: true,
  tokenDecimals: true,
  contractAddress: true,
  videoUrl: true,
});

export type InsertPlan = z.infer<typeof insertPlanSchema>;
export type Plan = typeof plans.$inferSelect;

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    planId: varchar("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
    payerAddress: text("payer_address").notNull(),
    // Random secret (stored as sha256 hash) used to authorize payer actions without wallet prompts.
    payerTokenHash: text("payer_token_hash"),
    payerTokenExpiresAt: timestamp("payer_token_expires_at"),
    firstPaymentAmount: text("first_payment_amount").notNull(),
    firstPaymentTxHash: text("first_payment_tx_hash").notNull(),
    approvalTxHash: text("approval_tx_hash"),
    approvedAmount: text("approved_amount"),
    onChainSubscriptionId: text("on_chain_subscription_id"),
    isActive: boolean("is_active").notNull().default(true),
    txCount: integer("tx_count").notNull().default(1),
    lastTxHash: text("last_tx_hash"),
    lastExecutedAt: timestamp("last_executed_at"),
    pendingTxHash: text("pending_tx_hash"),
    pendingTxCreatedAt: timestamp("pending_tx_created_at"),
    nextPaymentDue: timestamp("next_payment_due"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    uniqPlanPayer: uniqueIndex("subscriptions_plan_payer_uq").on(table.planId, table.payerAddress),
  }),
);

export const insertSubscriptionSchema = createInsertSchema(subscriptions).pick({
  planId: true,
  payerAddress: true,
  payerTokenHash: true,
  payerTokenExpiresAt: true,
  firstPaymentAmount: true,
  firstPaymentTxHash: true,
  approvalTxHash: true,
  approvedAmount: true,
  onChainSubscriptionId: true,
});

export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;
export type Subscription = typeof subscriptions.$inferSelect;

export const schedulerLogs = pgTable("scheduler_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  subscriptionId: varchar("subscription_id").notNull().references(() => subscriptions.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  txHash: text("tx_hash"),
  errorMessage: text("error_message"),
  gasUsed: text("gas_used"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type SchedulerLog = typeof schedulerLogs.$inferSelect;

// Used as a simple distributed lock to avoid multiple scheduler runners executing concurrently.
export const schedulerState = pgTable("scheduler_state", {
  name: text("name").primaryKey(),
  lockedUntil: timestamp("locked_until").notNull().default(sql`'1970-01-01 00:00:00'::timestamp`),
  lockedBy: text("locked_by"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Used by `connect-pg-simple` session store.
// Keeping this in the Drizzle schema prevents `drizzle-kit push` from trying to drop it.
export const session = pgTable(
  "session",
  {
    sid: varchar("sid").primaryKey(),
    sess: json("sess").notNull(),
    expire: timestamp("expire", { precision: 6 }).notNull(),
  },
  (table) => ({
    expireIdx: index("IDX_session_expire").on(table.expire),
  }),
);

export const loginSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters"),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

export const registerSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
