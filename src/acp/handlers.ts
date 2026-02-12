import type { AcpJob, AcpMemo } from "@virtuals-protocol/acp-node";
import { AcpJobPhases } from "@virtuals-protocol/acp-node";
import { createLogger } from "../utils/logger.ts";
import type { JobName } from "../utils/types.ts";
import { handleHedgeAnalysis } from "./jobs/hedge-analysis.ts";
import { handleExecuteHedge } from "./jobs/execute-hedge.ts";
import { handleCloseHedge } from "./jobs/close-hedge.ts";

const log = createLogger("handler");

const VALID_JOBS: JobName[] = ["hedge_analysis", "execute_hedge", "close_hedge"];

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

  // Phase REQUEST: Job just arrived — accept and create requirement for payment
  if (jobPhase === AcpJobPhases.REQUEST) {
    if (!jobName || !VALID_JOBS.includes(jobName)) {
      log.warn(`Job #${job.id} has invalid name: ${jobName}, rejecting`);
      await job.reject(`Unknown service: ${jobName ?? "none"}`);
      return;
    }

    log.info(`Accepting job #${job.id} (${jobName})`);
    await job.accept(`HedgeFi accepts ${jobName} job`);
    await job.createRequirement(`Please confirm payment to proceed with ${jobName}.`);
    log.info(`Job #${job.id}: requirement created, waiting for buyer payment`);
    return;
  }

  // Phase TRANSACTION: Buyer has paid — execute the work and deliver
  if (jobPhase === AcpJobPhases.TRANSACTION) {
    if (!jobName) {
      log.error(`Job #${job.id} in TRANSACTION phase but no name`);
      return;
    }

    log.info(`Job #${job.id}: executing ${jobName}`);

    switch (jobName) {
      case "hedge_analysis":
        await handleHedgeAnalysis(job);
        break;
      case "execute_hedge":
        await handleExecuteHedge(job);
        break;
      case "close_hedge":
        await handleCloseHedge(job);
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
