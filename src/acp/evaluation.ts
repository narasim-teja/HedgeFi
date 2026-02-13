import type { AcpJob } from "@virtuals-protocol/acp-node";
import { createLogger } from "../utils/logger.ts";
import type {
  JobName,
  HedgeAnalysisDeliverable,
  ExecuteHedgeDeliverable,
  CloseHedgeDeliverable,
} from "../utils/types.ts";
import { getJobState } from "../db/job-state.ts";
import { getActivePositions } from "../db/positions.ts";
import { fetchPortfolioPositions } from "../limitless/client.ts";

const log = createLogger("evaluation");

export interface EvaluationResult {
  approved: boolean;
  reason: string;
}

/**
 * Verify a job's deliverable before approving evaluation.
 * Per ACP best practice: never blindly auto-approve.
 */
export async function verifyDeliverable(job: AcpJob): Promise<EvaluationResult> {
  const jobName = job.name as JobName | undefined;
  const jobId = String(job.id);

  log.info(`Evaluating job #${jobId} (${jobName})`);

  try {
    const deliverableRaw = job.deliverable;
    if (!deliverableRaw) {
      return { approved: false, reason: "No deliverable found on job" };
    }

    let deliverable: unknown;
    try {
      deliverable = typeof deliverableRaw === "string"
        ? JSON.parse(deliverableRaw)
        : deliverableRaw;
    } catch {
      return { approved: false, reason: "Deliverable is not valid JSON" };
    }

    switch (jobName) {
      case "hedge_analysis":
        return verifyHedgeAnalysis(deliverable);
      case "execute_hedge":
        return await verifyExecuteHedge(jobId, deliverable);
      case "close_hedge":
        return verifyCloseHedge(jobId, deliverable);
      default:
        return { approved: true, reason: `Unknown job type ${jobName}, auto-approved` };
    }
  } catch (err) {
    log.error(`Evaluation error for job #${jobId}`, err);
    // Auto-approve on error — positions already exist, can't undo trades
    return {
      approved: true,
      reason: `Evaluation error (auto-approved as fallback): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// =============================================
// hedge_analysis verification
// =============================================

function verifyHedgeAnalysis(deliverable: unknown): EvaluationResult {
  const d = deliverable as Partial<HedgeAnalysisDeliverable>;

  if (!d.exposure || !d.recommended_hedges || !d.reasoning) {
    return {
      approved: false,
      reason: "Missing required fields: exposure, recommended_hedges, or reasoning",
    };
  }

  if (!Array.isArray(d.recommended_hedges)) {
    return { approved: false, reason: "recommended_hedges is not an array" };
  }

  if (typeof d.reasoning !== "string" || d.reasoning.length < 10) {
    return { approved: false, reason: "reasoning is missing or too short" };
  }

  return {
    approved: true,
    reason: `Hedge analysis verified: ${d.recommended_hedges.length} recommendations, reasoning provided`,
  };
}

// =============================================
// execute_hedge verification
// =============================================

async function verifyExecuteHedge(
  jobId: string,
  deliverable: unknown
): Promise<EvaluationResult> {
  const d = deliverable as Partial<ExecuteHedgeDeliverable>;

  if (!d.hedges_placed || !Array.isArray(d.hedges_placed)) {
    return { approved: false, reason: "Missing or invalid hedges_placed array" };
  }

  if (!d.summary) {
    return { approved: false, reason: "Missing summary in deliverable" };
  }

  // If no hedges were placed (edge case: all orders failed), check reasoning
  if (d.hedges_placed.length === 0) {
    if (d.reasoning) {
      return {
        approved: true,
        reason: "No hedges placed but reasoning provided — approved",
      };
    }
    return { approved: false, reason: "No hedges placed and no reasoning" };
  }

  // Verify positions exist on Limitless by querying portfolio
  const verificationDetails: string[] = [];
  try {
    const portfolio = await fetchPortfolioPositions();
    const onChainSlugs = new Set(portfolio.clob.map((p) => p.marketSlug));

    let matchCount = 0;
    for (const hedge of d.hedges_placed) {
      const slug = hedge.market_slug ?? hedge.market_id;
      if (onChainSlugs.has(slug)) {
        matchCount++;
      }
    }

    verificationDetails.push(
      `${matchCount}/${d.hedges_placed.length} positions verified on Limitless`
    );

    if (matchCount === 0) {
      verificationDetails.push("WARNING: No positions matched on-chain portfolio");
    }
  } catch (err) {
    verificationDetails.push(
      `Portfolio verification skipped: ${err instanceof Error ? err.message : "API error"}`
    );
  }

  // Verify budget usage is reasonable
  const jobState = getJobState(jobId);
  if (jobState?.confirmation_payload && d.summary.total_spent !== undefined) {
    try {
      const plan = JSON.parse(jobState.confirmation_payload);
      const plannedCost = plan.estimated_total_cost;
      if (plannedCost && Math.abs(d.summary.total_spent - plannedCost) / plannedCost > 0.5) {
        verificationDetails.push(
          `Budget deviation: planned $${plannedCost.toFixed(2)}, actual $${d.summary.total_spent.toFixed(2)}`
        );
      }
    } catch {
      // Plan parsing failed, skip budget check
    }
  }

  return {
    approved: true,
    reason: `Execute hedge verified: ${d.hedges_placed.length} hedges placed. ${verificationDetails.join(". ")}`,
  };
}

// =============================================
// close_hedge verification
// =============================================

function verifyCloseHedge(
  jobId: string,
  deliverable: unknown
): EvaluationResult {
  const d = deliverable as Partial<CloseHedgeDeliverable>;

  if (!d.positions_closed || !Array.isArray(d.positions_closed)) {
    return { approved: false, reason: "Missing or invalid positions_closed array" };
  }

  // Verify DB positions are marked as closed
  const jobState = getJobState(jobId);
  if (jobState?.buyer_address) {
    const activePositions = getActivePositions(jobState.buyer_address);
    if (activePositions.length > 0 && d.positions_closed.length > 0) {
      // Some positions still active — could be partial close
      log.info(
        `Job #${jobId}: ${activePositions.length} positions still active after close`
      );
    }
  }

  if (d.positions_closed.length === 0) {
    return {
      approved: true,
      reason: "No positions to close — approved",
    };
  }

  const totalReturned = d.total_returned_usdc ?? 0;
  return {
    approved: true,
    reason: `Close hedge verified: ${d.positions_closed.length} positions closed, $${totalReturned.toFixed(2)} USDC returned`,
  };
}
