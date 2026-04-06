CREATE TABLE "billing_proposals" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" varchar NOT NULL,
	"plan_id" varchar NOT NULL,
	"proposed_amount" text NOT NULL,
	"proposed_interval_value" integer NOT NULL,
	"proposed_interval_unit" text NOT NULL,
	"merchant_note" text,
	"deadline" timestamp,
	"status" text DEFAULT 'pending' NOT NULL,
	"accept_tx_hash" text,
	"responded_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "execution_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"subscription_id" varchar NOT NULL,
	"cycle_id" text NOT NULL,
	"status" text NOT NULL,
	"tx_hash" text,
	"fee_consumed" text,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "execution_logs_cycle_id_unique" UNIQUE("cycle_id")
);
--> statement-breakpoint
CREATE TABLE "plan_versions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" varchar NOT NULL,
	"version" integer NOT NULL,
	"snapshot" json NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"plan_name" text NOT NULL,
	"wallet_address" text NOT NULL,
	"network_id" text NOT NULL,
	"network_name" text NOT NULL,
	"token_address" text,
	"token_symbol" text,
	"token_decimals" integer,
	"interval_amount" text NOT NULL,
	"interval_value" integer NOT NULL,
	"interval_unit" text NOT NULL,
	"plan_code" text NOT NULL,
	"recurring_amount" text,
	"contract_address" text,
	"video_url" text,
	"chain_type" text DEFAULT 'evm' NOT NULL,
	"plan_version" integer DEFAULT 1 NOT NULL,
	"qr_nonce" text,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "plans_plan_code_unique" UNIQUE("plan_code")
);
--> statement-breakpoint
CREATE TABLE "qr_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"plan_id" varchar NOT NULL,
	"used_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduler_logs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" varchar NOT NULL,
	"cycle_id" text,
	"status" text NOT NULL,
	"amount" text,
	"token_symbol" text,
	"tx_hash" text,
	"error_message" text,
	"gas_used" text,
	"energy_used" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "scheduler_state" (
	"name" text PRIMARY KEY NOT NULL,
	"locked_until" timestamp DEFAULT '1970-01-01 00:00:00'::timestamp NOT NULL,
	"locked_by" text,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sdk_installations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sdk_key_id" varchar NOT NULL,
	"origin" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"ping_count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sdk_keys" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"api_key" text NOT NULL,
	"label" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"suspended_at" timestamp,
	"suspend_reason" text,
	CONSTRAINT "sdk_keys_api_key_unique" UNIQUE("api_key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" json NOT NULL,
	"expire" timestamp (6) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" varchar NOT NULL,
	"payer_address" text NOT NULL,
	"payer_token_hash" text,
	"payer_token_expires_at" timestamp,
	"first_payment_amount" text NOT NULL,
	"first_payment_tx_hash" text NOT NULL,
	"approval_tx_hash" text,
	"approved_amount" text,
	"on_chain_subscription_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"subscription_status" text DEFAULT 'active' NOT NULL,
	"tx_count" integer DEFAULT 1 NOT NULL,
	"last_tx_hash" text,
	"last_executed_at" timestamp,
	"pending_tx_hash" text,
	"pending_tx_created_at" timestamp,
	"next_payment_due" timestamp,
	"recurring_amount" text,
	"interval_value" integer,
	"interval_unit" text,
	"pending_sync_plan_version" integer,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password" text NOT NULL,
	"wallet_address" text,
	"wallet_network" text,
	"executor_private_key" text,
	"tron_executor_private_key" text,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"address" text NOT NULL,
	"label" text,
	"network_id" text,
	"network_name" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"webhook_id" integer NOT NULL,
	"subscription_id" varchar NOT NULL,
	"event_type" text NOT NULL,
	"payload" json NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0,
	"next_attempt_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "billing_proposals" ADD CONSTRAINT "billing_proposals_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler_logs" ADD CONSTRAINT "scheduler_logs_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sdk_installations" ADD CONSTRAINT "sdk_installations_sdk_key_id_sdk_keys_id_fk" FOREIGN KEY ("sdk_key_id") REFERENCES "public"."sdk_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sdk_keys" ADD CONSTRAINT "sdk_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sdk_installations_key_origin_idx" ON "sdk_installations" USING btree ("sdk_key_id","origin");--> statement-breakpoint
CREATE INDEX "IDX_session_expire" ON "session" USING btree ("expire");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_plan_payer_uq" ON "subscriptions" USING btree ("plan_id","payer_address");