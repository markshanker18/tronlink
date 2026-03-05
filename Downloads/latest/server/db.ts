import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../shared/schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL environment variable is required");
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: process.env.VERCEL === "1" ? 1 : 10,
});

export const db = drizzle(pool, { schema });

let compatibilityEnsured = false;

// Best-effort schema compatibility for older databases that predate recent columns.
// This keeps runtime endpoints working even if `db:push` was not run after an update.
export async function ensureDatabaseCompatibility(): Promise<void> {
  if (compatibilityEnsured) return;

  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS wallet_address text;
      ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS wallet_network text;
      ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS executor_private_key text;
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
    `);

    await client.query(`
      ALTER TABLE IF EXISTS plans ADD COLUMN IF NOT EXISTS recurring_amount text;
      ALTER TABLE IF EXISTS plans ADD COLUMN IF NOT EXISTS contract_address text;
      ALTER TABLE IF EXISTS plans ADD COLUMN IF NOT EXISTS video_url text;
    `);

    compatibilityEnsured = true;
  } finally {
    client.release();
  }
}
