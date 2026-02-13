import type { AcpJob, AcpMemo } from "@virtuals-protocol/acp-node";
import { AcpJobPhases, FareAmount, MemoType } from "@virtuals-protocol/acp-node";
import { createLogger } from "../utils/logger.ts";
import type { JobName } from "../utils/types.ts";
import { handleHedgeAnalysis } from "./jobs/hedge-analysis.ts";
import {
  handleExecuteHedgeAnalysis,
  handleExecuteHedgeExecution,
} from "./jobs/execute-hedge.ts";
import {
  handleCloseHedgePreview,
  handleCloseHedgeExecution,
} from "./jobs/close-hedge.ts";
import type { ValidationResult } from "./validation.ts";
import {
  validateHedgeAnalysisReq,
  validateExecuteHedgeReq,
  validateCloseHedgeReq,
} from "./validation.ts";
import { withBuyerLock } from "../utils/job-lock.ts";

const log = createLogger("handler");

const VALID_JOBS: JobName[] = ["hedge_analysis", "execute_hedge", "close_hedge"];

function parseRawRequirement(job: AcpJob): Record<string, unknown> {
  const raw = job.requirement;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

export async function handleNewTask(
  job: AcpJob,
  memoToSign?: AcpMemo
): Promise<void> {
  const jobName = job.name as JobName | undefined;
  const jobPhase = job.phase;

  log.info(`Dispatching job #${job.id}`, {
    name: jobName,
    phase: jobPhase,
    memoToSignId: memoToSign?.id,
  });

  // Phase REQUEST: Job just arrived — accept, analyze, and create requirement with plan
  if (jobPhase === AcpJobPhases.REQUEST) {
    if (!jobName || !VALID_JOBS.includes(jobName)) {
      log.warn(`Job #${job.id} has invalid name: ${jobName}, rejecting`);
      await job.reject(`Unknown service: ${jobName ?? "none"}`);
      return;
    }

    log.info(`Accepting job #${job.id} (${jobName})`);
    await job.accept(`HedgeFi accepts ${jobName} job`);

    // For execute_hedge and close_hedge: run analysis/preview BEFORE payment
    // so the buyer sees exactly what they're paying for.
    // Use createPayableRequirement() per ACP best practices for fund-transfer agents.
    const agentAddress = process.env.HEDGEFI_WALLET_ADDRESS as `0x${string}` | undefined;

    if (jobName === "execute_hedge") {
      const planMessage = await handleExecuteHedgeAnalysis(job);
      if (planMessage) {
        const rawReq = parseRawRequirement(job);
        const budget = Number(rawReq.hedge_budget_usdc) || 0;

        if (agentAddress && budget > 0) {
          const fareAmount = new FareAmount(budget, job.baseFare ?? 0);
          await job.createPayableRequirement(planMessage, MemoType.PAYABLE_REQUEST, fareAmount, agentAddress);
        } else {
          await job.createRequirement(planMessage);
        }
        log.info(`Job #${job.id}: hedge plan sent, waiting for buyer review + payment`);
      }
      // If null, the handler already rejected/delivered (edge case)
      return;
    }

    if (jobName === "close_hedge") {
      const previewMessage = await handleCloseHedgePreview(job);
      if (previewMessage) {
        if (agentAddress) {
          const fareAmount = new FareAmount(0, job.baseFare ?? 0);
          await job.createPayableRequirement(previewMessage, MemoType.PAYABLE_REQUEST, fareAmount, agentAddress);
        } else {
          await job.createRequirement(previewMessage);
        }
        log.info(`Job #${job.id}: close preview sent, waiting for buyer review + payment`);
      }
      return;
    }

    // Default for hedge_analysis and others
    await job.createRequirement(`Please confirm payment to proceed with ${jobName}.`);
    log.info(`Job #${job.id}: requirement created, waiting for buyer payment`);
    return;
  }

  // Phase TRANSACTION: Buyer has paid — validate requirement, then execute
  if (jobPhase === AcpJobPhases.TRANSACTION) {
    if (!jobName) {
      log.error(`Job #${job.id} in TRANSACTION phase but no name`);
      return;
    }

    // Validate the requirement before executing
    const rawReq = parseRawRequirement(job);
    let validation: ValidationResult = { valid: true };

    switch (jobName) {
      case "hedge_analysis":
        validation = validateHedgeAnalysisReq(rawReq);
        break;
      case "execute_hedge":
        validation = validateExecuteHedgeReq(rawReq);
        break;
      case "close_hedge":
        validation = validateCloseHedgeReq(rawReq);
        break;
    }

    if (!validation.valid) {
      log.warn(`Job #${job.id} validation failed: ${validation.error}`);
      try {
        if (
          (jobName === "execute_hedge" || jobName === "close_hedge") &&
          job.netPayableAmount && job.netPayableAmount > 0
        ) {
          const fareAmount = new FareAmount(
            job.netPayableAmount,
            job.baseFare ?? 0
          );
          await job.rejectPayable(`Validation failed: ${validation.error}`, fareAmount);
        } else {
          await job.reject(`Validation failed: ${validation.error}`);
        }
      } catch (rejectErr) {
        log.error(`Job #${job.id}: failed to reject after validation`, rejectErr);
        await job.deliver(JSON.stringify({ error: validation.error, status: "validation_failed" }));
      }
      return;
    }

    log.info(`Job #${job.id}: executing ${jobName}`);

    const buyerAddress = job.clientAddress ?? "unknown";

    switch (jobName) {
      case "hedge_analysis":
        await handleHedgeAnalysis(job);
        break;
      case "execute_hedge":
        // Per-buyer lock: serializes fund-transfer jobs for the same buyer
        await withBuyerLock(buyerAddress, () => handleExecuteHedgeExecution(job));
        break;
      case "close_hedge":
        await withBuyerLock(buyerAddress, () => handleCloseHedgeExecution(job));
        break;
      default:
        log.error(`Job #${job.id}: unhandled job name ${jobName}`);
    }
    return;
  }

  // Phase EVALUATION: handled by onEvaluate callback, not here
  if (jobPhase === AcpJobPhases.EVALUATION) {
    log.info(`Job #${job.id} is in EVALUATION phase (handled by onEvaluate callback)`);
    return;
  }

  log.warn(`Job #${job.id}: unhandled phase ${jobPhase}`);
}
