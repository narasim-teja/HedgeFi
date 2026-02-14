import { SQL } from "bun";

/**
 * Lazy database connection — only initialized on first use.
 * This prevents cryptic errors when DATABASE_URL is missing,
 * since the connection isn't created at import time (before env validation).
 */

let _sql: InstanceType<typeof SQL> | null = null;

export function getDb(): InstanceType<typeof SQL> {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set. Cannot connect to database.");
    }
    _sql = new SQL(url);
  }
  return _sql;
}

export function closeDb(): void {
  if (_sql) {
    _sql.close();
    _sql = null;
  }
}
