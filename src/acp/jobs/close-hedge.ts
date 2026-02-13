import type { AcpJob } from "@virtuals-protocol/acp-node";
import { FareAmount } from "@virtuals-protocol/acp-node";
import { createLogger } from "../../utils/logger.ts";
import type {
  CloseHedgeRequirement,
  CloseHedgeDeliverable,
  PositionClosed,
  DbPosition,
  ClosePlanConfirmation,
} from "../../utils/types.ts";
import { LimitlessOrderSide, LimitlessOrderType } from "../../utils/types.ts";
import { placeHedgeOrder } from "../../limitless/orders.ts";
import { ensureCtApproval } from "../../limitless/approvals.ts";
import { fetchMarketBySlug } from "../../limitless/client.ts";
import { LIMITLESS_CT_CONTRACT } from "../../utils/constants.ts";
import { formatUsd } from "../../portfolio/analyzer.ts";
import { generateScenarioReasoning } from "../../hedging/reasoning.ts";
import {
  getActivePositions,
  getPosition,
  getAllActivePositions,
  updatePositionStatus,
  recordOrder,
} from "../../db/positions.ts";
import { upsertJobState, setConfirmationSent, setDelivered, setFailed } from "../../db/job-state.ts";

const log = createLogger("close-hedge");

// =============================================
// Helpers
// =============================================

function parseRequirement(job: AcpJob): CloseHedgeRequirement {
  const raw = job.requirement;
  const fallback: CloseHedgeRequirement = { close_all: true };

  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return fallback; }
  }
  if (raw && typeof raw === "object") return raw as CloseHedgeRequirement;
  return fallback;
}

function formatCloseNotification(
  closedPositions: PositionClosed[],
  totalReturned: number
): string {
  if (closedPositions.length === 0) {
    return "No active positions found to close.";
  }
  const netPnl = closedPositions.reduce((s, p) => s + p.realized_pnl, 0);
  const pnlSign = netPnl >= 0 ? "+" : "";
  return [
    `Closed ${closedPositions.length} position(s)`,
    `Returned: $${formatUsd(totalReturned)}`,
    `Net P&L: ${pnlSign}$${formatUsd(netPnl)}`,
  ].join(" | ");
}

/**
 * Format a human-readable time-until string from an ISO expiry date.
 */
function formatExpiryHuman(expiryIso: string): string {
  const expiry = new Date(expiryIso);
  const now = Date.now();
  const diffMs = expiry.getTime() - now;

  if (diffMs <= 0) return "expired";

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  if (hours >= 48) return `in ${Math.floor(hours / 24)} days`;
  if (hours >= 1) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

/**
 * Look up positions to close based on the requirement.
 */
function resolvePositions(req: CloseHedgeRequirement, buyerAddress: string): DbPosition[] {
  if (req.position_ids && req.position_ids.length > 0) {
    return req.position_ids
      .map((id) => getPosition(id))
      .filter((p): p is DbPosition => p !== null && p.status === "active");
  }

  if (req.close_all) {
    const positions = getActivePositions(buyerAddress);
    return positions.length > 0 ? positions : getAllActivePositions();
  }

  return getActivePositions(buyerAddress);
}

/**
 * Format the close plan as a human-readable confirmation message.
 */
function formatCloseConfirmationMessage(plan: ClosePlanConfirmation): string {
  const lines: string[] = [];

  lines.push("CLOSE HEDGE PLAN FOR REVIEW");
  lines.push("============================");
  lines.push(`Positions to close: ${plan.positions.length}`);
  lines.push("");

  for (let i = 0; i < plan.positions.length; i++) {
    const pos = plan.positions[i]!;
    const pnlSign = pos.estimated_pnl >= 0 ? "+" : "";
    lines.push(`${i + 1}. "${pos.market_title}" -- ${pos.side} side`);
    lines.push(`   Shares: ${(pos.shares / 1e6).toFixed(4)} | Entry: $${pos.entry_price.toFixed(4)}`);
    lines.push(`   Cost: $${formatUsd(pos.total_cost_usdc)} | Est. Return: $${formatUsd(pos.estimated_current_value)} | Est. P&L: ${pnlSign}$${formatUsd(pos.estimated_pnl)}`);
    lines.push(`   Expires: ${new Date(pos.expiry).toUTCString()} (${formatExpiryHuman(pos.expiry)})`);
  }

  lines.push("");
  lines.push(`Total Est. Return: $${formatUsd(plan.total_estimated_return)}`);
  const totalPnlSign = plan.total_estimated_pnl >= 0 ? "+" : "";
  lines.push(`Total Est. P&L: ${totalPnlSign}$${formatUsd(plan.total_estimated_pnl)}`);
  lines.push("");
  lines.push("Reply APPROVE to sell these positions or REJECT to keep them open.");

  return lines.join("\n");
}

// =============================================
// Phase A: Preview positions before closing
// =============================================

export async function handleCloseHedgePreview(job: AcpJob): Promise<void> {
  const jlog = log.withJob(job.id);
  jlog.info("Phase A: Previewing positions for close");

  const req = parseRequirement(job);
  jlog.info("Requirement parsed", req);

  upsertJobState(String(job.id), {
    jobName: "close_hedge",
    phase: "initialized",
    buyerAddress: job.clientAddress,
  });

  try {
    const buyerAddress = job.clientAddress ?? "unknown";
    const positions = resolvePositions(req, buyerAddress);

    // No positions to close — skip confirmation, deliver immediately
    if (positions.length === 0) {
      jlog.info("No active positions to close");
      const deliverable: CloseHedgeDeliverable = {
        positions_closed: [],
        total_returned_usdc: 0,
        return_tx_hash: "no-active-positions",
        reasoning: "No active hedge positions were found to close. Positions may have already been closed or expired.",
      };
      await job.deliver(JSON.stringify(deliverable));
      setDelivered(String(job.id));
      try { await job.createNotification("No active positions found to close."); } catch { /* non-fatal */ }
      return;
    }

    // Fetch current market prices for each position
    const planPositions: ClosePlanConfirmation["positions"] = [];

    for (const pos of positions) {
      let currentPrice = pos.entry_price; // fallback to entry price
      try {
        const market = await fetchMarketBySlug(pos.market_slug);
        // Get current price for this side
        if (pos.side === "YES" && market.prices?.[0] !== undefined) {
          currentPrice = market.prices[0];
        } else if (pos.side === "NO" && market.prices?.[1] !== undefined) {
          currentPrice = market.prices[1];
        }
      } catch (err) {
        jlog.warn(`Failed to fetch current price for ${pos.market_slug}, using entry price`, err);
      }

      const humanShares = pos.shares / 1e6;
      const estimatedValue = humanShares * currentPrice;
      const estimatedPnl = estimatedValue - pos.total_cost_usdc;

      planPositions.push({
        position_id: pos.id,
        market_title: pos.market_title,
        side: pos.side,
        shares: pos.shares,
        entry_price: pos.entry_price,
        total_cost_usdc: pos.total_cost_usdc,
        estimated_current_value: Math.round(estimatedValue * 100) / 100,
        estimated_pnl: Math.round(estimatedPnl * 100) / 100,
        expiry: pos.expiry,
      });
    }

    const plan: ClosePlanConfirmation = {
      positions: planPositions,
      total_estimated_return: planPositions.reduce((s, p) => s + p.estimated_current_value, 0),
      total_estimated_pnl: planPositions.reduce((s, p) => s + p.estimated_pnl, 0),
    };

    // Store the plan and send confirmation
    setConfirmationSent(String(job.id), JSON.stringify(plan));

    const confirmationMsg = formatCloseConfirmationMessage(plan);
    await job.createRequirement(confirmationMsg);
    jlog.info("Close plan sent to buyer for confirmation");

  } catch (err) {
    jlog.error("Failed during close hedge preview", err);
    setFailed(String(job.id));
    try {
      const payable = job.netPayableAmount;
      if (payable && payable > 0) {
        const fareAmount = new FareAmount(payable, job.baseFare);
        await job.rejectPayable(
          `Close hedge preview failed: ${err instanceof Error ? err.message : "Unknown error"}`,
          fareAmount
        );
      } else {
        const deliverable: CloseHedgeDeliverable = {
          positions_closed: [],
          total_returned_usdc: 0,
          return_tx_hash: "error",
          reasoning: `Failed to preview positions: ${err instanceof Error ? err.message : "Unknown error"}`,
        };
        await job.deliver(JSON.stringify(deliverable));
      }
    } catch {
      try {
        const deliverable: CloseHedgeDeliverable = {
          positions_closed: [],
          total_returned_usdc: 0,
          return_tx_hash: "error",
          reasoning: `Failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        };
        await job.deliver(JSON.stringify(deliverable));
      } catch { /* truly fatal */ }
    }
  }
}

// =============================================
// Phase B: Execute confirmed close
// =============================================

export async function handleCloseHedgeExecution(job: AcpJob): Promise<void> {
  const jlog = log.withJob(job.id);
  jlog.info("Phase B: Executing confirmed close hedge");

  const req = parseRequirement(job);

  // Retrieve the stored plan
  const { getJobState } = await import("../../db/job-state.ts");
  const state = getJobState(String(job.id));

  // Even without a stored plan, proceed — resolve positions directly
  let positionIds: string[] | undefined;
  if (state?.confirmation_payload) {
    try {
      const plan: ClosePlanConfirmation = JSON.parse(state.confirmation_payload);
      positionIds = plan.positions.map((p) => p.position_id);
    } catch {
      jlog.warn("Failed to parse stored close plan, falling back to live lookup");
    }
  }

  upsertJobState(String(job.id), { jobName: "close_hedge", phase: "executing" });

  try {
    const buyerAddress = job.clientAddress ?? "unknown";
    let positions: DbPosition[];

    if (positionIds && positionIds.length > 0) {
      positions = positionIds
        .map((id) => getPosition(id))
        .filter((p): p is DbPosition => p !== null && p.status === "active");
    } else {
      positions = resolvePositions(req, buyerAddress);
    }

    if (positions.length === 0) {
      jlog.info("No active positions to close");
      const deliverable: CloseHedgeDeliverable = {
        positions_closed: [],
        total_returned_usdc: 0,
        return_tx_hash: "no-active-positions",
        reasoning: "No active hedge positions were found to close. Positions may have already been closed or expired.",
      };
      await job.deliver(JSON.stringify(deliverable));
      setDelivered(String(job.id));
      try { await job.createNotification("No active positions found to close."); } catch { /* non-fatal */ }
      return;
    }

    jlog.info(`Closing ${positions.length} position(s)`);

    const tClose = jlog.time("Close hedge positions");
    const closedPositions: PositionClosed[] = [];
    let totalReturned = 0;

    for (const pos of positions) {
      try {
        await ensureCtApproval(LIMITLESS_CT_CONTRACT, pos.venue_exchange);

        const humanShares = pos.shares / 1e6;
        const result = await placeHedgeOrder({
          marketSlug: pos.market_slug,
          tokenId: pos.token_id,
          side: LimitlessOrderSide.SELL,
          usdcAmount: humanShares,
          orderType: LimitlessOrderType.FOK,
          venueExchangeAddress: pos.venue_exchange,
        });

        const saleAmount = result.totalCost;
        const pnl = saleAmount - pos.total_cost_usdc;

        updatePositionStatus(pos.id, "closed", {
          closePrice: result.avgPrice,
          realizedPnl: Math.round(pnl * 100) / 100,
        });

        recordOrder({
          positionId: pos.id,
          orderType: "close",
          marketSlug: pos.market_slug,
          side: LimitlessOrderSide.SELL,
          makerAmount: String(Math.ceil(pos.shares)),
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
        jlog.info(`Closed position ${pos.id}`, {
          orderId: result.orderId,
          saleAmount,
          pnl: Math.round(pnl * 100) / 100,
        });
      } catch (err) {
        jlog.error(`Failed to close position ${pos.id}`, err);
        updatePositionStatus(pos.id, "close_failed");
      }
    }
    tClose.end();

    // Generate AI reasoning
    const tReasoning = jlog.time("AI reasoning generation");
    let reasoning = "";
    if (closedPositions.length > 0) {
      try {
        reasoning = await generateScenarioReasoning({
          type: "position_close",
          positionsClosed: closedPositions,
          totalReturned: Math.round(totalReturned * 100) / 100,
        });
      } catch (err) {
        jlog.warn("Failed to generate close reasoning", err);
        const netPnl = closedPositions.reduce((s, p) => s + p.realized_pnl, 0);
        reasoning = netPnl >= 0
          ? `Closed ${closedPositions.length} position(s) with net profit of +$${formatUsd(netPnl)}. $${formatUsd(totalReturned)} USDC returned.`
          : `Closed ${closedPositions.length} position(s) with net cost of $${formatUsd(Math.abs(netPnl))}. $${formatUsd(totalReturned)} USDC returned. The hedge cost served as insurance premium.`;
      }
    } else {
      reasoning = "No positions could be closed. All sell orders failed to fill on Limitless Exchange.";
    }
    tReasoning.end();

    const deliverable: CloseHedgeDeliverable = {
      positions_closed: closedPositions,
      total_returned_usdc: Math.round(totalReturned * 100) / 100,
      return_tx_hash:
        closedPositions.length > 0
          ? `limitless:batch-close-${Date.now()}`
          : "no-fills",
      reasoning,
    };

    jlog.info("Delivering close_hedge result", {
      positionsClosed: closedPositions.length,
      totalReturned,
    });
    await job.deliver(JSON.stringify(deliverable));
    setDelivered(String(job.id));
    jlog.info("Delivered successfully");

    // Notification memo
    try {
      if (closedPositions.length > 0 && totalReturned > 0) {
        const notifMsg = formatCloseNotification(closedPositions, deliverable.total_returned_usdc);
        const fareAmount = new FareAmount(totalReturned, job.baseFare);
        await job.createPayableNotification(notifMsg, fareAmount);
        jlog.info(`Payable notification sent ($${totalReturned.toFixed(2)})`);
      } else {
        const notifMsg = formatCloseNotification(closedPositions, deliverable.total_returned_usdc);
        await job.createNotification(notifMsg);
        jlog.info("Notification memo sent");
      }
    } catch (notifErr) {
      jlog.warn("Failed to send notification memo", notifErr);
    }
  } catch (err) {
    jlog.error("Failed during close hedge execution", err);
    setFailed(String(job.id));

    try {
      const payable = job.netPayableAmount;
      if (payable && payable > 0) {
        const fareAmount = new FareAmount(payable, job.baseFare);
        await job.rejectPayable(
          `Close hedge failed: ${err instanceof Error ? err.message : "Unknown error"}`,
          fareAmount
        );
        jlog.info("Refund issued via rejectPayable");
      } else {
        const errorDeliverable: CloseHedgeDeliverable = {
          positions_closed: [],
          total_returned_usdc: 0,
          return_tx_hash: `error: ${err instanceof Error ? err.message : "unknown"}`,
          reasoning: `Failed to close hedge positions: ${err instanceof Error ? err.message : "Unknown error"}. Please try again.`,
        };
        await job.deliver(JSON.stringify(errorDeliverable));
      }
    } catch (rejectErr) {
      jlog.error("Failed to reject/deliver error", rejectErr);
      try {
        const errorDeliverable: CloseHedgeDeliverable = {
          positions_closed: [],
          total_returned_usdc: 0,
          return_tx_hash: "error",
          reasoning: `Failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        };
        await job.deliver(JSON.stringify(errorDeliverable));
      } catch { /* truly fatal */ }
    }

    try {
      await job.createNotification(
        `Close Hedge Failed: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    } catch { /* non-fatal */ }
  }
}
