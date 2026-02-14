import { getDb } from "./connection.ts";
import { createLogger } from "../utils/logger.ts";
import type { JobState, JobInternalPhase } from "../utils/types.ts";

const log = createLogger("db-job-state");

function toISOString(val: unknown): string | null {
  if (val instanceof Date) return val.toISOString();
  if (typeof val === "string") return val;
  return null;
}

function normalizeJobState(row: Record<string, unknown> | undefined): JobState | null {
  if (!row) return null;
  return {
    ...(row as unknown as JobState),
    started_at: toISOString(row.started_at),
    created_at: toISOString(row.created_at) ?? "",
    updated_at: toISOString(row.updated_at) ?? "",
  };
}

/**
 * Get the current state of a job by ID.
 */
export async function getJobState(jobId: string): Promise<JobState | null> {
  const rows = await getDb()`SELECT * FROM job_state WHERE job_id = ${jobId}`;
  return normalizeJobState(rows[0]);
}

/**
 * Create or update a job state record.
 */
export async function upsertJobState(
  jobId: string,
  data: {
    jobName: string;
    phase?: JobInternalPhase;
    buyerAddress?: string;
  }
): Promise<void> {
  const phase = data.phase ?? "initialized";
  const buyerAddress = data.buyerAddress ?? null;
  const sql = getDb();

  await sql`
    INSERT INTO job_state (job_id, job_name, phase, buyer_address, started_at, created_at, updated_at)
    VALUES (
      ${jobId},
      ${data.jobName},
      ${phase},
      ${buyerAddress},
      ${phase === "executing" ? sql`NOW()` : null},
      NOW(),
      NOW()
    )
    ON CONFLICT (job_id) DO UPDATE SET
      phase = COALESCE(${data.phase ?? null}, job_state.phase),
      buyer_address = COALESCE(${buyerAddress}, job_state.buyer_address),
      started_at = CASE WHEN ${data.phase ?? null} = 'executing' THEN NOW() ELSE job_state.started_at END,
      updated_at = NOW()
  `;

  log.debug(`Upserted job state for ${jobId}`, { phase: data.phase });
}

/**
 * Mark a job's confirmation as sent and store the frozen plan payload.
 */
export async function setConfirmationSent(jobId: string, payload: string): Promise<void> {
  await getDb()`
    UPDATE job_state
    SET confirmation_sent = 1,
        confirmation_payload = ${payload},
        phase = 'awaiting_confirmation',
        updated_at = NOW()
    WHERE job_id = ${jobId}
  `;
  log.info(`Job ${jobId}: confirmation sent, plan stored`);
}

/**
 * Mark a job as confirmed by the buyer.
 */
export async function setConfirmed(jobId: string): Promise<void> {
  await getDb()`
    UPDATE job_state SET phase = 'confirmed', updated_at = NOW() WHERE job_id = ${jobId}
  `;
  log.info(`Job ${jobId}: confirmed by buyer`);
}

/**
 * Mark a job as delivered.
 */
export async function setDelivered(jobId: string): Promise<void> {
  await getDb()`
    UPDATE job_state SET phase = 'delivered', updated_at = NOW() WHERE job_id = ${jobId}
  `;
}

/**
 * Mark a job as failed.
 */
export async function setFailed(jobId: string): Promise<void> {
  await getDb()`
    UPDATE job_state SET phase = 'failed', updated_at = NOW() WHERE job_id = ${jobId}
  `;
}

/**
 * Clean up old job state records to prevent DB bloat.
 */
export async function cleanupOldJobs(olderThanDays: number): Promise<number> {
  const deleted = await getDb()`
    DELETE FROM job_state
    WHERE created_at < NOW() - ${olderThanDays + " days"}::INTERVAL
    RETURNING job_id
  `;
  if (deleted.length > 0) {
    log.info(`Cleaned up ${deleted.length} old job state records (>${olderThanDays} days)`);
  }
  return deleted.length;
}

/**
 * Detect and mark stuck jobs that have been "executing" for too long.
 * Typically run once on agent startup to recover from crashes.
 */
export async function recoverStuckJobs(stuckMinutes: number = 10): Promise<number> {
  const recovered = await getDb()`
    UPDATE job_state
    SET phase = 'failed', updated_at = NOW()
    WHERE phase = 'executing'
      AND started_at IS NOT NULL
      AND started_at < NOW() - ${stuckMinutes + " minutes"}::INTERVAL
    RETURNING job_id
  `;
  if (recovered.length > 0) {
    log.warn(`Recovered ${recovered.length} stuck jobs (executing >${stuckMinutes}min)`);
  }
  return recovered.length;
}
