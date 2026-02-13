import { Database } from "bun:sqlite";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("db-schema");

const db = new Database("hedgefi.sqlite");

// Enable WAL mode for better concurrent performance
db.run("PRAGMA journal_mode = WAL");

db.run(`
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
    entry_price REAL NOT NULL,
    total_cost_usdc REAL NOT NULL,
    order_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    expiry TEXT NOT NULL,
    venue_exchange TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT,
    close_price REAL,
    realized_pnl REAL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS order_history (
    id TEXT PRIMARY KEY,
    position_id TEXT,
    order_type TEXT NOT NULL,
    market_slug TEXT NOT NULL,
    side INTEGER NOT NULL,
    maker_amount TEXT NOT NULL,
    taker_amount TEXT NOT NULL,
    price REAL NOT NULL,
    filled_size REAL,
    order_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (position_id) REFERENCES positions(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS job_state (
    job_id TEXT PRIMARY KEY,
    job_name TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'initialized',
    confirmation_sent INTEGER NOT NULL DEFAULT 0,
    confirmation_payload TEXT,
    buyer_address TEXT,
    started_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migration: add started_at column if it doesn't exist (for existing databases)
try {
  db.run("ALTER TABLE job_state ADD COLUMN started_at TEXT");
} catch {
  // Column already exists — safe to ignore
}

log.info("Database schema initialized");

export { db };
