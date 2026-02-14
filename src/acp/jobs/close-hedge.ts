import type { AcpJob } from "@virtuals-protocol/acp-node";
import { Fare, FareAmount } from "@virtuals-protocol/acp-node";
import { BASE_CHAIN_ID } from "../../utils/constants.ts";

/** Ensure Fare has chainId set (required by deliverPayable to avoid cross-chain routing). */
function ensureFareChainId(fare: InstanceType<typeof Fare>): InstanceType<typeof Fare> {
  if (!fare.chainId) {
    return new Fare(fare.contractAddress, fare.decimals, BASE_CHAIN_ID);
  }
  return fare;
}
import { createLogger } from "../../utils/logger.ts";
import { sanitizeNumber } from "../../utils/math.ts";
import type {
  AnalysisResult,
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
    return getActivePositions(buyerAddress);
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

/**
 * Preview positions for closing. Returns an AnalysisResult:
 * - { type: "plan", message } for a valid close preview
 * - { type: "error", message } when there are no positions to close
 *
 * IMPORTANT: This function NEVER calls job.reject() because it runs
 * AFTER accept(). Calling reject() post-accept causes "Already signed"
 * nonce conflicts on the Alchemy proxy. The caller handles the result.
 *
 * Called during REQUEST phase so buyer sees the preview before paying.
 */
export async function handleCloseHedgePreview(job: AcpJob): Promise<AnalysisResult> {
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

    // No positions to close
    if (positions.length === 0) {
      jlog.info("No active positions to close");
      return { type: "error", message: "No active hedge positions were found to close. Positions may have already been closed or expired." };
    }

    // Fetch current market prices for each position
    const planPositions: ClosePlanConfirmation["positions"] = [];

    for (const pos of positions) {
      let currentPrice = pos.entry_price; // fallback to entry price
      try {
        const market = await fetchMarketBySlug(pos.market_slug);
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

    // Store the plan for execution after buyer pays
    setConfirmationSent(String(job.id), JSON.stringify(plan));

    // Return the formatted preview text — caller will pass to createRequirement
    const confirmationMsg = formatCloseConfirmationMessage(plan);
    jlog.info("Close preview built, returning to caller");
    return { type: "plan", message: confirmationMsg };

  } catch (err) {
    jlog.error("Failed during close hedge preview", err);
    setFailed(String(job.id));
    return {
      type: "error",
      message: `Close hedge preview failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    };
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
      const lookups = positionIds.map((id) => ({ id, pos: getPosition(id) }));
      const notFound = lookups.filter((l) => l.pos === null);
      const alreadyClosed = lookups.filter((l) => l.pos !== null && l.pos.status !== "active");

      if (notFound.length > 0) {
        jlog.warn(`${notFound.length} position ID(s) not found: ${notFound.map((l) => l.id).join(", ")}`);
      }
      if (alreadyClosed.length > 0) {
        jlog.warn(`${alreadyClosed.length} position(s) already closed: ${alreadyClosed.map((l) => l.id).join(", ")}`);
      }

      positions = lookups
        .map((l) => l.pos)
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

    // Deduplicate positions on the same market/token FOR THE SAME BUYER — sell once per group
    // to avoid "Insufficient conditional token balance" errors from sequential sells.
    // buyer_address is included so positions from different traders are never merged.
    const groupKey = (p: DbPosition) => `${p.buyer_address}|${p.market_slug}|${p.token_id}|${p.venue_exchange}`;
    const grouped = new Map<string, DbPosition[]>();
    for (const pos of positions) {
      const key = groupKey(pos);
      const existing = grouped.get(key);
      if (existing) {
        existing.push(pos);
      } else {
        grouped.set(key, [pos]);
      }
    }

    jlog.info(`Closing ${positions.length} position(s) across ${grouped.size} market group(s)`);

    const tClose = jlog.time("Close hedge positions");
    const closedPositions: PositionClosed[] = [];
    let totalReturned = 0;

    for (const [, group] of grouped) {
      const representative = group[0]!;
      const totalShares = group.reduce((s, p) => s + p.shares, 0);
      const totalCost = group.reduce((s, p) => s + p.total_cost_usdc, 0);

      if (totalShares <= 0) {
        jlog.warn(`Position group on ${representative.market_slug} has zero total shares, skipping`);
        for (const pos of group) {
          updatePositionStatus(pos.id, "close_failed");
        }
        continue;
      }

      try {
        await ensureCtApproval(LIMITLESS_CT_CONTRACT, representative.venue_exchange);

        const humanShares = totalShares / 1e6;
        jlog.info(`Selling ${humanShares.toFixed(4)} shares on ${representative.market_slug} (${group.length} position(s) merged)`);

        const result = await placeHedgeOrder({
          marketSlug: representative.market_slug,
          tokenId: representative.token_id,
          side: LimitlessOrderSide.SELL,
          usdcAmount: humanShares,
          orderType: LimitlessOrderType.FOK,
          venueExchangeAddress: representative.venue_exchange,
        });

        const saleAmount = result.totalCost;
        const groupPnl = saleAmount - totalCost;

        // Distribute sale proceeds proportionally to each position in the group
        for (const pos of group) {
          const sharesFraction = sanitizeNumber(pos.shares / totalShares);
          const posReturn = sanitizeNumber(saleAmount * sharesFraction);
          const posPnl = sanitizeNumber(posReturn - pos.total_cost_usdc);

          updatePositionStatus(pos.id, "closed", {
            closePrice: result.avgPrice,
            realizedPnl: Math.round(posPnl * 100) / 100,
          });

          recordOrder({
            positionId: pos.id,
            orderType: "close",
            marketSlug: pos.market_slug,
            side: LimitlessOrderSide.SELL,
            makerAmount: String(Math.ceil(pos.shares)),
            takerAmount: "1",
            price: result.avgPrice,
            filledSize: Math.round(result.filledSize * sharesFraction),
            orderId: result.orderId,
            status: result.matched ? "filled" : "placed",
          });

          jlog.info(`Closed position ${pos.id}`, {
            orderId: result.orderId,
            sharesFraction: `${(sharesFraction * 100).toFixed(1)}%`,
            posReturn: Math.round(posReturn * 100) / 100,
            pnl: Math.round(posPnl * 100) / 100,
          });
        }

        // Single entry in deliverable per market group
        closedPositions.push({
          market_id: representative.market_slug,
          shares_sold: result.filledSize,
          sale_price: result.avgPrice,
          realized_pnl: Math.round(sanitizeNumber(groupPnl) * 100) / 100,
        });

        totalReturned += saleAmount;
      } catch (err) {
        jlog.error(`Failed to close ${group.length} position(s) on ${representative.market_slug}`, err);
        for (const pos of group) {
          updatePositionStatus(pos.id, "close_failed");
        }
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

    // Use deliverPayable to atomically deliver result + return funds when there are proceeds
    if (closedPositions.length > 0 && totalReturned > 0) {
      const fareAmount = new FareAmount(totalReturned, ensureFareChainId(job.baseFare));
      await job.deliverPayable(JSON.stringify(deliverable), fareAmount);
      jlog.info(`Delivered with fund return ($${totalReturned.toFixed(2)})`);
    } else {
      await job.deliver(JSON.stringify(deliverable));
      jlog.info("Delivered (no funds to return)");
    }
    setDelivered(String(job.id));

    // Post-delivery notification memo (summary only, funds already returned above)
    try {
      const notifMsg = formatCloseNotification(closedPositions, deliverable.total_returned_usdc);
      await job.createNotification(notifMsg);
      jlog.info("Notification memo sent");
    } catch (notifErr) {
      jlog.warn("Failed to send notification memo", notifErr);
    }
  } catch (err) {
    jlog.error("Failed during close hedge execution", err);
    setFailed(String(job.id));

    try {
      const payable = job.netPayableAmount;
      if (payable && payable > 0) {
        const fareAmount = new FareAmount(payable, ensureFareChainId(job.baseFare));
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
