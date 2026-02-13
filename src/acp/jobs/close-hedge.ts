import type { AcpJob } from "@virtuals-protocol/acp-node";
import { createLogger } from "../../utils/logger.ts";
import type {
  CloseHedgeRequirement,
  CloseHedgeDeliverable,
  PositionClosed,
  DbPosition,
} from "../../utils/types.ts";
import { LimitlessOrderSide, LimitlessOrderType } from "../../utils/types.ts";
import { placeHedgeOrder } from "../../limitless/orders.ts";
import { ensureCtApproval } from "../../limitless/approvals.ts";
import {
  getActivePositions,
  getPosition,
  getAllActivePositions,
  updatePositionStatus,
  recordOrder,
} from "../../db/positions.ts";

const log = createLogger("close-hedge");

function parseRequirement(job: AcpJob): CloseHedgeRequirement {
  const raw = job.requirement;
  const fallback: CloseHedgeRequirement = { close_all: true };

  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  if (raw && typeof raw === "object") {
    return raw as CloseHedgeRequirement;
  }

  return fallback;
}

export async function handleCloseHedge(job: AcpJob): Promise<void> {
  log.info(`Processing close_hedge for job #${job.id}`);

  const req = parseRequirement(job);
  log.info("Requirement parsed", req);

  try {
    // Determine which positions to close
    const buyerAddress = (job as any).clientAddress ?? "unknown";
    let positions: DbPosition[];

    if (req.position_ids && req.position_ids.length > 0) {
      positions = req.position_ids
        .map((id) => getPosition(id))
        .filter((p): p is DbPosition => p !== null && p.status === "active");
    } else if (req.close_all) {
      // Try buyer-specific positions first, fall back to all active
      positions = getActivePositions(buyerAddress);
      if (positions.length === 0) {
        positions = getAllActivePositions();
      }
    } else {
      positions = getActivePositions(buyerAddress);
    }

    if (positions.length === 0) {
      log.info("No active positions to close");
      const deliverable: CloseHedgeDeliverable = {
        positions_closed: [],
        total_returned_usdc: 0,
        return_tx_hash: "no-active-positions",
      };
      await job.deliver(JSON.stringify(deliverable));
      return;
    }

    log.info(`Closing ${positions.length} position(s)`);

    const closedPositions: PositionClosed[] = [];
    let totalReturned = 0;

    for (const pos of positions) {
      try {
        // Ensure CT (Conditional Token) approval for selling
        // The CT contract is typically the collateral token contract for the venue
        await ensureCtApproval(pos.token_id, pos.venue_exchange);

        // Place a SELL order for this position's shares
        const result = await placeHedgeOrder({
          marketSlug: pos.market_slug,
          tokenId: pos.token_id,
          side: LimitlessOrderSide.SELL,
          usdcAmount: pos.shares, // For SELL, this represents shares to sell
          orderType: LimitlessOrderType.FOK,
          venueExchangeAddress: pos.venue_exchange,
        });

        const saleAmount = result.totalCost;
        const pnl = saleAmount - pos.total_cost_usdc;

        // Update position in database
        updatePositionStatus(pos.id, "closed", {
          closePrice: result.avgPrice,
          realizedPnl: Math.round(pnl * 100) / 100,
        });

        recordOrder({
          positionId: pos.id,
          orderType: "close",
          marketSlug: pos.market_slug,
          side: LimitlessOrderSide.SELL,
          makerAmount: String(Math.ceil(pos.shares * 1e6)),
          takerAmount: "1",
          price: result.avgPrice,
          filledSize: result.filledSize,
          orderId: result.orderId,
          status: result.matched ? "filled" : "placed",
        });

        closedPositions.push({
          market_id: pos.market_slug,
          shares_sold: result.filledSize,
          sale_price: result.avgPrice,
          realized_pnl: Math.round(pnl * 100) / 100,
        });

        totalReturned += saleAmount;
        log.info(`Closed position ${pos.id}`, {
          orderId: result.orderId,
          saleAmount,
          pnl: Math.round(pnl * 100) / 100,
        });
      } catch (err) {
        log.error(`Failed to close position ${pos.id}`, err);
        // Mark as error but don't fail the whole job
        updatePositionStatus(pos.id, "close_failed");
      }
    }

    const deliverable: CloseHedgeDeliverable = {
      positions_closed: closedPositions,
      total_returned_usdc: Math.round(totalReturned * 100) / 100,
      return_tx_hash:
        closedPositions.length > 0
          ? `limitless:batch-close-${Date.now()}`
          : "no-fills",
    };

    log.info(`Delivering close_hedge for job #${job.id}`, {
      positionsClosed: closedPositions.length,
      totalReturned,
    });
    await job.deliver(JSON.stringify(deliverable));
    log.info(`Job #${job.id} delivered successfully`);
  } catch (err) {
    log.error(`Failed to process close_hedge for job #${job.id}`, err);
    const errorDeliverable: CloseHedgeDeliverable = {
      positions_closed: [],
      total_returned_usdc: 0,
      return_tx_hash: `error: ${err instanceof Error ? err.message : "unknown"}`,
    };
    await job.deliver(JSON.stringify(errorDeliverable));
  }
}
