import { db } from "./schema.ts";
import { createLogger } from "../utils/logger.ts";
import type { DbPosition, CreatePositionParams, ClosingData } from "../utils/types.ts";

const log = createLogger("db-positions");

/**
 * Create a new position record after a hedge order fills.
 */
export function createPosition(params: CreatePositionParams): string {
  const id = `pos_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  db.run(
    `INSERT INTO positions (id, job_id, buyer_address, market_slug, market_title, token_id, side, action, shares, entry_price, total_cost_usdc, order_id, status, expiry, venue_exchange)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [
      id,
      params.jobId,
      params.buyerAddress,
      params.marketSlug,
      params.marketTitle,
      params.tokenId,
      params.side,
      params.action,
      params.shares,
      params.entryPrice,
      params.totalCostUsdc,
      params.orderId,
      params.expiry,
      params.venueExchange,
    ]
  );

  log.info(`Created position ${id}`, { marketSlug: params.marketSlug, shares: params.shares });
  return id;
}

/**
 * Get all active positions for a specific buyer.
 */
export function getActivePositions(buyerAddress: string): DbPosition[] {
  return db
    .query("SELECT * FROM positions WHERE buyer_address = ? AND status = 'active' ORDER BY created_at DESC")
    .all(buyerAddress) as DbPosition[];
}

/**
 * Get all active positions across all buyers.
 */
export function getAllActivePositions(): DbPosition[] {
  return db
    .query("SELECT * FROM positions WHERE status = 'active' ORDER BY created_at DESC")
    .all() as DbPosition[];
}

/**
 * Get a position by ID.
 */
export function getPosition(positionId: string): DbPosition | null {
  return db
    .query("SELECT * FROM positions WHERE id = ?")
    .get(positionId) as DbPosition | null;
}

/**
 * Update position status (e.g., closed, expired, won, lost).
 */
export function updatePositionStatus(
  positionId: string,
  status: string,
  closingData?: ClosingData
): void {
  if (closingData) {
    db.run(
      "UPDATE positions SET status = ?, closed_at = datetime('now'), close_price = ?, realized_pnl = ? WHERE id = ?",
      [status, closingData.closePrice, closingData.realizedPnl, positionId]
    );
  } else {
    db.run("UPDATE positions SET status = ? WHERE id = ?", [status, positionId]);
  }

  log.info(`Updated position ${positionId} → ${status}`);
}

/**
 * Get positions for a specific market.
 */
export function getPositionsForMarket(marketSlug: string): DbPosition[] {
  return db
    .query("SELECT * FROM positions WHERE market_slug = ? ORDER BY created_at DESC")
    .all(marketSlug) as DbPosition[];
}

/**
 * Get historical (closed/resolved) positions for a specific buyer.
 */
export function getHistoricalPositions(buyerAddress: string): DbPosition[] {
  return db
    .query("SELECT * FROM positions WHERE buyer_address = ? AND status != 'active' ORDER BY closed_at DESC")
    .all(buyerAddress) as DbPosition[];
}

/**
 * Record an order in the history table.
 */
export function recordOrder(params: {
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
}): void {
  const id = `ord_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  db.run(
    `INSERT INTO order_history (id, position_id, order_type, market_slug, side, maker_amount, taker_amount, price, filled_size, order_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.positionId,
      params.orderType,
      params.marketSlug,
      params.side,
      params.makerAmount,
      params.takerAmount,
      params.price,
      params.filledSize,
      params.orderId,
      params.status,
    ]
  );
}
