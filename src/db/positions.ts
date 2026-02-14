import { getDb } from "./connection.ts";
import { createLogger } from "../utils/logger.ts";
import type { DbPosition, CreatePositionParams, ClosingData } from "../utils/types.ts";

const log = createLogger("db-positions");

function toISOString(val: unknown): string | null {
  if (val instanceof Date) return val.toISOString();
  if (typeof val === "string") return val;
  return null;
}

function normalizePosition(row: Record<string, unknown> | undefined): DbPosition | null {
  if (!row) return null;
  return {
    ...(row as unknown as DbPosition),
    created_at: toISOString(row.created_at) ?? "",
    closed_at: toISOString(row.closed_at),
    expiry: (typeof row.expiry === "string" ? row.expiry : toISOString(row.expiry)) ?? "",
  };
}

function normalizePositions(rows: Record<string, unknown>[]): DbPosition[] {
  return rows.map((r) => normalizePosition(r)!);
}

/**
 * Create a new position record after a hedge order fills.
 */
export async function createPosition(params: CreatePositionParams): Promise<string> {
  const id = `pos_${crypto.randomUUID()}`;

  await getDb()`
    INSERT INTO positions (id, job_id, buyer_address, market_slug, market_title, token_id, side, action, shares, entry_price, total_cost_usdc, order_id, status, expiry, venue_exchange)
    VALUES (${id}, ${params.jobId}, ${params.buyerAddress}, ${params.marketSlug}, ${params.marketTitle}, ${params.tokenId}, ${params.side}, ${params.action}, ${params.shares}, ${params.entryPrice}, ${params.totalCostUsdc}, ${params.orderId}, 'active', ${params.expiry}, ${params.venueExchange})
  `;

  log.info(`Created position ${id}`, { marketSlug: params.marketSlug, shares: params.shares });
  return id;
}

/**
 * Get all active positions for a specific buyer.
 */
export async function getActivePositions(buyerAddress: string): Promise<DbPosition[]> {
  const rows = await getDb()`
    SELECT * FROM positions WHERE buyer_address = ${buyerAddress} AND status = 'active' ORDER BY created_at DESC
  `;
  return normalizePositions(rows as Record<string, unknown>[]);
}

/**
 * Get all active positions across all buyers.
 */
export async function getAllActivePositions(): Promise<DbPosition[]> {
  const rows = await getDb()`
    SELECT * FROM positions WHERE status = 'active' ORDER BY created_at DESC
  `;
  return normalizePositions(rows as Record<string, unknown>[]);
}

/**
 * Get a position by ID.
 */
export async function getPosition(positionId: string): Promise<DbPosition | null> {
  const rows = await getDb()`SELECT * FROM positions WHERE id = ${positionId}`;
  return normalizePosition(rows[0] as Record<string, unknown> | undefined);
}

/**
 * Update position status (e.g., closed, expired, won, lost).
 */
export async function updatePositionStatus(
  positionId: string,
  status: string,
  closingData?: ClosingData
): Promise<void> {
  if (closingData) {
    await getDb()`
      UPDATE positions SET status = ${status}, closed_at = NOW(), close_price = ${closingData.closePrice}, realized_pnl = ${closingData.realizedPnl} WHERE id = ${positionId}
    `;
  } else {
    await getDb()`UPDATE positions SET status = ${status} WHERE id = ${positionId}`;
  }

  log.info(`Updated position ${positionId} → ${status}`);
}

/**
 * Get positions for a specific market.
 */
export async function getPositionsForMarket(marketSlug: string): Promise<DbPosition[]> {
  const rows = await getDb()`
    SELECT * FROM positions WHERE market_slug = ${marketSlug} ORDER BY created_at DESC
  `;
  return normalizePositions(rows as Record<string, unknown>[]);
}

/**
 * Get historical (closed/resolved) positions for a specific buyer.
 */
export async function getHistoricalPositions(buyerAddress: string): Promise<DbPosition[]> {
  const rows = await getDb()`
    SELECT * FROM positions WHERE buyer_address = ${buyerAddress} AND status != 'active' ORDER BY closed_at DESC
  `;
  return normalizePositions(rows as Record<string, unknown>[]);
}

/**
 * Record an order in the history table.
 */
export async function recordOrder(params: {
  positionId: string | null;
  orderType: string;
  marketSlug: string;
  side: number;
  makerAmount: string;
  takerAmount: string;
  price: number;
  filledSize: number | null;
  orderId: string;
  status: string;
}): Promise<void> {
  const id = `ord_${crypto.randomUUID()}`;

  await getDb()`
    INSERT INTO order_history (id, position_id, order_type, market_slug, side, maker_amount, taker_amount, price, filled_size, order_id, status)
    VALUES (${id}, ${params.positionId}, ${params.orderType}, ${params.marketSlug}, ${params.side}, ${params.makerAmount}, ${params.takerAmount}, ${params.price}, ${params.filledSize}, ${params.orderId}, ${params.status})
  `;
}
