import type { AcpJob, AcpMemo } from "@virtuals-protocol/acp-node";
import { AcpJobPhases, Fare, FareAmount, MemoType } from "@virtuals-protocol/acp-node";
import { BASE_CHAIN_ID } from "../utils/constants.ts";

/** Ensure Fare has chainId set (required by deliverPayable/createPayableRequirement). */
function ensureFareChainId(fare: InstanceType<typeof Fare>): InstanceType<typeof Fare> {
  if (!fare.chainId) {
    return new Fare(fare.contractAddress, fare.decimals, BASE_CHAIN_ID);
  }
  return fare;
}
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
import { JobQueue } from "../utils/job-queue.ts";
import { MAX_CONCURRENT_JOBS, MAX_QUEUE_SIZE } from "../utils/constants.ts";

const log = createLogger("handler");

// Global job queue — limits concurrent job processing across all buyers.
// Works alongside per-buyer lock (job-lock.ts) for fund-transfer serialization.
export const jobQueue = new JobQueue(MAX_CONCURRENT_JOBS, MAX_QUEUE_SIZE);

/** Small delay to let UserOperation nonces settle on the RPC proxy. */
function settleDelay(ms: number = 2000): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const VALID_JOBS: JobName[] = ["hedge_analysis", "execute_hedge", "close_hedge"];

// Deduplication: track jobs we're already processing to prevent
// duplicate socket events from causing "Already signed" RPC errors.
const processingJobs = new Set<string>();

function jobKey(jobId: number | string, phase: number | string): string {
  return `${jobId}:${phase}`;
}

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

  // Dedup: skip if we're already processing this exact job+phase
  const key = jobKey(job.id, jobPhase);
  if (processingJobs.has(key)) {
    log.debug(`Job #${job.id} phase ${jobPhase} already in progress, skipping duplicate`);
    return;
  }
  processingJobs.add(key);

  // Safety cap: prevent unbounded dedup set growth under extreme load
  if (processingJobs.size > 1000) {
    log.warn(`Processing dedup set reached ${processingJobs.size} entries, clearing stale entries`);
    processingJobs.clear();
    processingJobs.add(key);
  }

  log.info(`Dispatching job #${job.id}`, {
    name: jobName,
    phase: jobPhase,
    memoToSignId: memoToSign?.id,
    queueStats: jobQueue.getStats(),
  });

  // Route through the concurrency-controlled job queue.
  // If queue is full, reject with backpressure signal.
  const enqueued = jobQueue.enqueue(String(job.id), async () => {
    await processJob(job, memoToSign);
  });

  if (!enqueued) {
    log.warn(`Job #${job.id}: agent queue full, rejecting with backpressure`);
    try {
      await job.reject("Agent is currently at capacity. Please try again in a few minutes.");
    } catch (err) {
      log.error(`Failed to reject overloaded job #${job.id}`, err);
    }
    // Clean up dedup entry immediately since we're not processing
    processingJobs.delete(key);
    return;
  }
}

/**
 * Core job processing logic, executed within the JobQueue concurrency pool.
 */
async function processJob(
  job: AcpJob,
  memoToSign?: AcpMemo
): Promise<void> {
  const jobName = job.name as JobName | undefined;
  const jobPhase = job.phase;
  const key = jobKey(job.id, jobPhase);

  try {

  // Phase REQUEST: Job just arrived — validate, analyze, then accept only if viable
  //
  // IMPORTANT: reject() is only safe BEFORE accept(). After accept() it causes
  // "Already signed" nonce conflicts on the Alchemy proxy. So we do ALL
  // validation and analysis BEFORE calling accept(). Only accept if we have
  // a viable plan to send as a requirement.
  if (jobPhase === AcpJobPhases.REQUEST) {
    if (!jobName || !VALID_JOBS.includes(jobName)) {
      log.warn(`Job #${job.id} has invalid name: ${jobName}, rejecting`);
      await job.reject(`Unknown service: ${jobName ?? "none"}`);
      return;
    }

    // Step 1: Pre-validate requirement inputs
    const rawReq = parseRawRequirement(job);
    let preValidation: ValidationResult = { valid: true };

    switch (jobName) {
      case "execute_hedge":
        preValidation = validateExecuteHedgeReq(rawReq);
        break;
      case "hedge_analysis":
        preValidation = validateHedgeAnalysisReq(rawReq);
        break;
      case "close_hedge":
        preValidation = validateCloseHedgeReq(rawReq);
        break;
    }

    if (!preValidation.valid) {
      log.warn(`Job #${job.id} pre-validation failed: ${preValidation.error}`);
      await job.reject(`Invalid request: ${preValidation.error}`);
      return;
    }

    const agentAddress = process.env.HEDGEFI_WALLET_ADDRESS as `0x${string}` | undefined;

    // Step 2: For execute_hedge and close_hedge, run analysis/preview BEFORE
    // accepting so we can cleanly reject() if the request isn't viable.
    if (jobName === "execute_hedge") {
      const result = await handleExecuteHedgeAnalysis(job);

      if (result.type === "error") {
        log.info(`Job #${job.id}: analysis failed, rejecting — ${result.message.substring(0, 100)}`);
        await job.reject(result.message);
        return;
      }

      // Plan is viable — accept, then send as payable requirement
      log.info(`Accepting job #${job.id} (${jobName})`);
      await job.accept(`HedgeFi accepts ${jobName} job`);
      await settleDelay();

      const budget = Number(rawReq.hedge_budget_usdc) || 0;
      if (agentAddress && budget > 0) {
        const fareAmount = new FareAmount(budget, ensureFareChainId(job.baseFare));
        await job.createPayableRequirement(result.message, MemoType.PAYABLE_REQUEST, fareAmount, agentAddress);
      } else {
        await job.createRequirement(result.message);
      }
      log.info(`Job #${job.id}: hedge plan sent, waiting for buyer review + payment`);
      return;
    }

    if (jobName === "close_hedge") {
      const result = await handleCloseHedgePreview(job);

      if (result.type === "error") {
        log.info(`Job #${job.id}: close preview failed, rejecting — ${result.message.substring(0, 100)}`);
        await job.reject(result.message);
        return;
      }

      // Preview is viable — accept, then send as payable requirement
      log.info(`Accepting job #${job.id} (${jobName})`);
      await job.accept(`HedgeFi accepts ${jobName} job`);
      await settleDelay();

      // close_hedge has no upfront cost — use plain requirement (RPC rejects FareAmount(0))
      await job.createRequirement(result.message);
      log.info(`Job #${job.id}: close preview sent, waiting for buyer approval`);
      return;
    }

    // Default for hedge_analysis and others — accept then create requirement
    log.info(`Accepting job #${job.id} (${jobName})`);
    await job.accept(`HedgeFi accepts ${jobName} job`);
    await settleDelay();
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
            ensureFareChainId(job.baseFare)
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

  } finally {
    // Clean up dedup entry after a delay (allows late duplicates to be caught)
    setTimeout(() => processingJobs.delete(key), 60_000);
  }
}
