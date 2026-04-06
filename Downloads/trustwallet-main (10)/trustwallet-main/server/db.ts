import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../shared/schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL environment variable is required");
}

export const isMockDb = databaseUrl === "mock";

if (isMockDb && process.env.NODE_ENV === "production") {
  throw new Error("CRITICAL: Cannot use DATABASE_URL=mock in a production environment. This bypasses the database connection entirely.");
}

const pool = isMockDb ? ({} as any) : new pg.Pool({
  connectionString: databaseUrl,
  max: process.env.VERCEL === "1" ? 1 : 10,
});

export const db = isMockDb ? ({} as any) : drizzle(pool, { schema });

let compatibilityEnsured = false;

// Best-effort schema compatibility for older databases that predate recent columns.
// This keeps runtime endpoints working even if `db:push` was not run after an update.
export async function ensureDatabaseCompatibility(): Promise<void> {
  if (compatibilityEnsured || isMockDb) return;

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        username text NOT NULL UNIQUE,
        password text NOT NULL,
        wallet_address text,
        wallet_network text,
        executor_private_key text,
        tron_executor_private_key text
      );
      
      CREATE TABLE IF NOT EXISTS wallets (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        address text NOT NULL,
        label text,
        network_id text,
        network_name text,
        is_default boolean NOT NULL DEFAULT false,
        created_at timestamp DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS plans (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan_name text NOT NULL,
        wallet_address text NOT NULL,
        network_id text NOT NULL,
        network_name text NOT NULL,
        token_address text,
        token_symbol text,
        token_decimals integer,
        interval_amount text NOT NULL,
        interval_value integer NOT NULL,
        interval_unit text NOT NULL,
        plan_code text NOT NULL UNIQUE,
        recurring_amount text,
        contract_address text,
        video_url text,
        chain_type text NOT NULL DEFAULT 'evm',
        plan_version integer NOT NULL DEFAULT 1,
        qr_nonce text,
        created_at timestamp DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        plan_id varchar NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        payer_address text NOT NULL,
        payer_token_hash text,
        payer_token_expires_at timestamp,
        first_payment_amount text NOT NULL,
        first_payment_tx_hash text NOT NULL,
        approval_tx_hash text,
        approved_amount text,
        on_chain_subscription_id text,
        is_active boolean NOT NULL DEFAULT true,
        subscription_status text NOT NULL DEFAULT 'active',
        tx_count integer NOT NULL DEFAULT 1,
        last_tx_hash text,
        last_executed_at timestamp,
        pending_tx_hash text,
        pending_tx_created_at timestamp,
        next_payment_due timestamp,
        created_at timestamp DEFAULT now(),
        UNIQUE(plan_id, payer_address)
      );

      CREATE TABLE IF NOT EXISTS scheduler_logs (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        subscription_id varchar NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
        status text NOT NULL,
        tx_hash text,
        error_message text,
        gas_used text,
        energy_used text,
        created_at timestamp DEFAULT now()
      );
    `);

    // Add columns that might be missing from older deployments
    await client.query(`
      ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS wallet_address text;
      ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS wallet_network text;
      ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS executor_private_key text;
      ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS tron_executor_private_key text;
    `);

    await client.query(`
      ALTER TABLE IF EXISTS subscriptions ADD COLUMN IF NOT EXISTS payer_token_hash text;
      ALTER TABLE IF EXISTS subscriptions ADD COLUMN IF NOT EXISTS payer_token_expires_at timestamp;
      ALTER TABLE IF EXISTS subscriptions ADD COLUMN IF NOT EXISTS approval_tx_hash text;
      ALTER TABLE IF EXISTS subscriptions ADD COLUMN IF NOT EXISTS approved_amount text;
      ALTER TABLE IF EXISTS subscriptions ADD COLUMN IF NOT EXISTS on_chain_subscription_id text;
      ALTER TABLE IF EXISTS subscriptions ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
      ALTER TABLE IF EXISTS subscriptions ADD COLUMN IF NOT EXISTS tx_count integer NOT NULL DEFAULT 1;
      ALTER TABLE IF EXISTS subscriptions ADD COLUMN IF NOT EXISTS last_tx_hash text;
      ALTER TABLE IF EXISTS subscriptions ADD COLUMN IF NOT EXISTS last_executed_at timestamp;
      ALTER TABLE IF EXISTS subscriptions ADD COLUMN IF NOT EXISTS pending_tx_hash text;
      ALTER TABLE IF EXISTS subscriptions ADD COLUMN IF NOT EXISTS pending_tx_created_at timestamp;
      ALTER TABLE IF EXISTS subscriptions ADD COLUMN IF NOT EXISTS next_payment_due timestamp;
      ALTER TABLE IF EXISTS subscriptions ADD COLUMN IF NOT EXISTS recurring_amount text;
      ALTER TABLE IF EXISTS subscriptions ADD COLUMN IF NOT EXISTS interval_value integer;
      ALTER TABLE IF EXISTS subscriptions ADD COLUMN IF NOT EXISTS interval_unit text;
    `);

    await client.query(`
      ALTER TABLE IF EXISTS plans ADD COLUMN IF NOT EXISTS recurring_amount text;
      ALTER TABLE IF EXISTS plans ADD COLUMN IF NOT EXISTS contract_address text;
      ALTER TABLE IF EXISTS plans ADD COLUMN IF NOT EXISTS video_url text;
    `);

    // TRON multi-chain support (additive, all new columns have safe defaults)
    await client.query(`
      ALTER TABLE IF EXISTS plans ADD COLUMN IF NOT EXISTS chain_type text NOT NULL DEFAULT 'evm';
      ALTER TABLE IF EXISTS plans ADD COLUMN IF NOT EXISTS plan_version integer NOT NULL DEFAULT 1;
      ALTER TABLE IF EXISTS plans ADD COLUMN IF NOT EXISTS qr_nonce text;
    `);

    await client.query(`
      ALTER TABLE IF EXISTS scheduler_logs ADD COLUMN IF NOT EXISTS energy_used text;
    `);

    // Modern subscription features
    await client.query(`
      ALTER TABLE IF EXISTS subscriptions ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'active';
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS scheduler_state (
        name text PRIMARY KEY,
        locked_until timestamp NOT NULL DEFAULT '1970-01-01 00:00:00'::timestamp,
        locked_by text,
        updated_at timestamp DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS execution_logs (
        id serial PRIMARY KEY,
        subscription_id varchar NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
        cycle_id text NOT NULL UNIQUE,
        status text NOT NULL,
        tx_hash text,
        fee_consumed text,
        created_at timestamp DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id serial PRIMARY KEY,
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        url text NOT NULL,
        secret text NOT NULL,
        active boolean DEFAULT true,
        created_at timestamp DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id serial PRIMARY KEY,
        webhook_id integer NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
        subscription_id varchar NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
        event_type text NOT NULL,
        payload json NOT NULL,
        status text NOT NULL,
        attempts integer DEFAULT 0,
        next_attempt_at timestamp DEFAULT now(),
        created_at timestamp DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS sdk_keys (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        api_key text NOT NULL UNIQUE,
        label text,
        status text NOT NULL DEFAULT 'active',
        created_at timestamp DEFAULT now(),
        suspended_at timestamp,
        suspend_reason text
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS sdk_installations (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        sdk_key_id varchar NOT NULL REFERENCES sdk_keys(id) ON DELETE CASCADE,
        origin text NOT NULL,
        ip text,
        user_agent text,
        last_seen_at timestamp NOT NULL DEFAULT now(),
        first_seen_at timestamp NOT NULL DEFAULT now(),
        ping_count integer NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS sdk_installations_key_origin_idx ON sdk_installations(sdk_key_id, origin);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS plan_versions (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        plan_id varchar NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        version integer NOT NULL,
        snapshot json NOT NULL,
        created_at timestamp DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_plan_versions_plan_id ON plan_versions(plan_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS qr_nonces (
        nonce text PRIMARY KEY,
        plan_id varchar NOT NULL,
        used_at timestamp NOT NULL DEFAULT now(),
        expires_at timestamp NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_qr_nonces_expires ON qr_nonces(expires_at);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS billing_proposals (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        subscription_id varchar NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
        plan_id varchar NOT NULL,
        proposed_amount text NOT NULL,
        proposed_interval_value integer NOT NULL,
        proposed_interval_unit text NOT NULL,
        merchant_note text,
        deadline timestamp,
        status text NOT NULL DEFAULT 'pending',
        accept_tx_hash text,
        responded_at timestamp,
        created_at timestamp DEFAULT now()
      );
    `);

    compatibilityEnsured = true;
  } finally {
    client.release();
  }
}
