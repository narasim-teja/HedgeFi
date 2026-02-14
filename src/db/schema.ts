import { getDb } from "./connection.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("db-schema");

/**
 * Initialize the database schema (creates tables if they don't exist).
 * Must be called once at startup before any DB operations.
 */
export async function initSchema(): Promise<void> {
  const sql = getDb();

  await sql`
    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      buyer_address TEXT NOT NULL,
      market_slug TEXT NOT NULL,
      market_title TEXT NOT NULL,
      token_id TEXT NOT NULL,
      side TEXT NOT NULL,
      action TEXT NOT NULL,
      shares INTEGER NOT NULL,
      entry_price DOUBLE PRECISION NOT NULL,
      total_cost_usdc DOUBLE PRECISION NOT NULL,
      order_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      expiry TEXT NOT NULL,
      venue_exchange TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMP WITH TIME ZONE,
      close_price DOUBLE PRECISION,
      realized_pnl DOUBLE PRECISION
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS order_history (
      id TEXT PRIMARY KEY,
      position_id TEXT,
      order_type TEXT NOT NULL,
      market_slug TEXT NOT NULL,
      side INTEGER NOT NULL,
      maker_amount TEXT NOT NULL,
      taker_amount TEXT NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      filled_size DOUBLE PRECISION,
      order_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      FOREIGN KEY (position_id) REFERENCES positions(id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS job_state (
      job_id TEXT PRIMARY KEY,
      job_name TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'initialized',
      confirmation_sent INTEGER NOT NULL DEFAULT 0,
      confirmation_payload TEXT,
      buyer_address TEXT,
      started_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `;

  log.info("Database schema initialized");
}
