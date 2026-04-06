import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, boolean, json, index, uniqueIndex, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import type { ChainType } from "./chain";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  walletAddress: text("wallet_address"),
  walletNetwork: text("wallet_network"),
  executorPrivateKey: text("executor_private_key"),
  tronExecutorPrivateKey: text("tron_executor_private_key"),
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
  // Multi-chain support
  chainType: text("chain_type").notNull().default("evm").$type<ChainType>(),
  planVersion: integer("plan_version").notNull().default(1),
  qrNonce: text("qr_nonce"),
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
  chainType: true,
  recurringAmount: true,
});

export type InsertPlan = z.infer<typeof insertPlanSchema>;
export type Plan = typeof plans.$inferSelect;

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    planId: varchar("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
    payerAddress: text("payer_address").notNull(),
    payerTokenHash: text("payer_token_hash"),
    payerTokenExpiresAt: timestamp("payer_token_expires_at"),
    firstPaymentAmount: text("first_payment_amount").notNull(),
    firstPaymentTxHash: text("first_payment_tx_hash").notNull(),
    approvalTxHash: text("approval_tx_hash"),
    approvedAmount: text("approved_amount"),
    onChainSubscriptionId: text("on_chain_subscription_id"),
    isActive: boolean("is_active").notNull().default(true),
    subscriptionStatus: text("subscription_status").notNull().default("active"),
    txCount: integer("tx_count").notNull().default(1),
    lastTxHash: text("last_tx_hash"),
    lastExecutedAt: timestamp("last_executed_at"),
    pendingTxHash: text("pending_tx_hash"),
    pendingTxCreatedAt: timestamp("pending_tx_created_at"),
    nextPaymentDue: timestamp("next_payment_due"),
    recurringAmount: text("recurring_amount"),
    intervalValue: integer("interval_value"),
    intervalUnit: text("interval_unit"),
    pendingSyncPlanVersion: integer("pending_sync_plan_version"),
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
  recurringAmount: true,
  intervalValue: true,
  intervalUnit: true,
});

export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;
export type Subscription = typeof subscriptions.$inferSelect;

export const schedulerLogs = pgTable("scheduler_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  subscriptionId: varchar("subscription_id").notNull().references(() => subscriptions.id, { onDelete: "cascade" }),
  cycleId: text("cycle_id"),
  status: text("status").notNull(),
  amount: text("amount"),
  tokenSymbol: text("token_symbol"),
  txHash: text("tx_hash"),
  errorMessage: text("error_message"),
  gasUsed: text("gas_used"),
  energyUsed: text("energy_used"), // TRON-specific: energy consumed (null for EVM rows)
  createdAt: timestamp("created_at").defaultNow(),
});

export type SchedulerLog = typeof schedulerLogs.$inferSelect;

// Stores immutable snapshots of plan parameters whenever plan terms change.
// Allows auditing what billing terms were in effect at each version.
export const planVersions = pgTable("plan_versions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  planId: varchar("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  snapshot: json("snapshot").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export type PlanVersion = typeof planVersions.$inferSelect;

// QR nonce registry — prevents replay of signed QR payloads.
export const qrNonces = pgTable("qr_nonces", {
  nonce: text("nonce").primaryKey(),
  planId: varchar("plan_id").notNull(),
  usedAt: timestamp("used_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
});

export type QrNonce = typeof qrNonces.$inferSelect;

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

// ── SDK License System ────────────────────────────────────────────────────────

/** API keys issued to merchants for embedding the SDK script on external sites. */
export const sdkKeys = pgTable("sdk_keys", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  apiKey: text("api_key").notNull().unique(),   // public key embedded in <script data-key="">
  label: text("label"),                          // human-readable name
  status: text("status").notNull().default("active"), // active | suspended | payment_required
  createdAt: timestamp("created_at").defaultNow(),
  suspendedAt: timestamp("suspended_at"),
  suspendReason: text("suspend_reason"),
});

export type SdkKey = typeof sdkKeys.$inferSelect;

/** Every heartbeat ping from the embedded script is recorded here. */
export const sdkInstallations = pgTable("sdk_installations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sdkKeyId: varchar("sdk_key_id").notNull().references(() => sdkKeys.id, { onDelete: "cascade" }),
  origin: text("origin").notNull(),    // the site embedding the script (e.g. https://myshop.com)
  ip: text("ip"),
  userAgent: text("user_agent"),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
  pingCount: integer("ping_count").notNull().default(1),
}, (table) => ({
  keyOriginIdx: index("sdk_installations_key_origin_idx").on(table.sdkKeyId, table.origin),
}));

export type SdkInstallation = typeof sdkInstallations.$inferSelect;

// ── Login / Register schemas ──────────────────────────────────────────────────

export const loginSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const registerSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters"),
  password: z.string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[0-9]/, "Password must contain at least one number"),
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;

// ── Webhooks & Logs Payload System ────────────────────────────────────────────────────────

// Idempotency & Execution Logs
export const executionLogs = pgTable("execution_logs", {
  id: serial("id").primaryKey(),
  subscriptionId: varchar("subscription_id").notNull().references(() => subscriptions.id, { onDelete: "cascade" }),
  cycleId: text("cycle_id").notNull().unique(), // e.g., "${subId}-${timestamp_truncated_to_interval}"
  status: text("status").notNull(), // 'pending', 'success', 'failed', 'skipped'
  txHash: text("tx_hash"),
  feeConsumed: text("fee_consumed"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type ExecutionLog = typeof executionLogs.$inferSelect;

// Webhooks Config
export const webhooks = pgTable("webhooks", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  active: boolean("active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export type Webhook = typeof webhooks.$inferSelect;

// Webhook Delivery Queue
export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: serial("id").primaryKey(),
  webhookId: integer("webhook_id").notNull().references(() => webhooks.id, { onDelete: "cascade" }),
  subscriptionId: varchar("subscription_id").notNull().references(() => subscriptions.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  payload: json("payload").notNull(),
  status: text("status").notNull(), // 'pending', 'success', 'failed'
  attempts: integer("attempts").default(0),
  nextAttemptAt: timestamp("next_attempt_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;

// ── Billing Proposals ─────────────────────────────────────────────────────────
// Merchant proposes new billing terms; subscriber accepts/rejects from the pay page.

export const billingProposals = pgTable("billing_proposals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  subscriptionId: varchar("subscription_id").notNull().references(() => subscriptions.id, { onDelete: "cascade" }),
  planId: varchar("plan_id").notNull(),
  proposedAmount: text("proposed_amount").notNull(),
  proposedIntervalValue: integer("proposed_interval_value").notNull(),
  proposedIntervalUnit: text("proposed_interval_unit").notNull(),
  merchantNote: text("merchant_note"),
  deadline: timestamp("deadline"),
  status: text("status").notNull().default("pending"), // pending | accepted | rejected
  acceptTxHash: text("accept_tx_hash"),
  respondedAt: timestamp("responded_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type BillingProposal = typeof billingProposals.$inferSelect;
