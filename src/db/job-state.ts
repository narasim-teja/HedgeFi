import { db } from "./schema.ts";
import { createLogger } from "../utils/logger.ts";
import type { JobState, JobInternalPhase } from "../utils/types.ts";

const log = createLogger("db-job-state");

/**
 * Get the current state of a job by ID.
 */
export function getJobState(jobId: string): JobState | null {
  return db
    .query("SELECT * FROM job_state WHERE job_id = ?")
    .get(jobId) as JobState | null;
}

/**
 * Create or update a job state record.
 */
export function upsertJobState(
  jobId: string,
  data: {
    jobName: string;
    phase?: JobInternalPhase;
    buyerAddress?: string;
  }
): void {
  const existing = getJobState(jobId);

  if (existing) {
    const updates: string[] = ["updated_at = datetime('now')"];
    const values: (string | number | null)[] = [];

    if (data.phase) {
      updates.push("phase = ?");
      values.push(data.phase);
      // Record started_at when entering execution
      if (data.phase === "executing") {
        updates.push("started_at = datetime('now')");
      }
    }
    if (data.buyerAddress) {
      updates.push("buyer_address = ?");
      values.push(data.buyerAddress);
    }

    values.push(jobId);
    db.run(`UPDATE job_state SET ${updates.join(", ")} WHERE job_id = ?`, values);
  } else {
    db.run(
      `INSERT INTO job_state (job_id, job_name, phase, buyer_address)
       VALUES (?, ?, ?, ?)`,
      [jobId, data.jobName, data.phase ?? "initialized", data.buyerAddress ?? null]
    );
  }

  log.debug(`Upserted job state for ${jobId}`, { phase: data.phase });
}

/**
 * Mark a job's confirmation as sent and store the frozen plan payload.
 */
export function setConfirmationSent(jobId: string, payload: string): void {
  db.run(
    `UPDATE job_state
     SET confirmation_sent = 1,
         confirmation_payload = ?,
         phase = 'awaiting_confirmation',
         updated_at = datetime('now')
     WHERE job_id = ?`,
    [payload, jobId]
  );
  log.info(`Job ${jobId}: confirmation sent, plan stored`);
}

/**
 * Mark a job as confirmed by the buyer.
 */
export function setConfirmed(jobId: string): void {
  db.run(
    `UPDATE job_state SET phase = 'confirmed', updated_at = datetime('now') WHERE job_id = ?`,
    [jobId]
  );
  log.info(`Job ${jobId}: confirmed by buyer`);
}

/**
 * Mark a job as delivered.
 */
export function setDelivered(jobId: string): void {
  db.run(
    `UPDATE job_state SET phase = 'delivered', updated_at = datetime('now') WHERE job_id = ?`,
    [jobId]
  );
}

/**
 * Mark a job as failed.
 */
export function setFailed(jobId: string): void {
  db.run(
    `UPDATE job_state SET phase = 'failed', updated_at = datetime('now') WHERE job_id = ?`,
    [jobId]
  );
}

/**
 * Clean up old job state records to prevent DB bloat.
 */
export function cleanupOldJobs(olderThanDays: number): number {
  const result = db.run(
    `DELETE FROM job_state WHERE created_at < datetime('now', ? || ' days')`,
    [`-${olderThanDays}`]
  );
  const deleted = result.changes;
  if (deleted > 0) {
    log.info(`Cleaned up ${deleted} old job state records (>${olderThanDays} days)`);
  }
  return deleted;
}

/**
 * Detect and mark stuck jobs that have been "executing" for too long.
 * Typically run once on agent startup to recover from crashes.
 */
export function recoverStuckJobs(stuckMinutes: number = 10): number {
  const result = db.run(
    `UPDATE job_state
     SET phase = 'failed', updated_at = datetime('now')
     WHERE phase = 'executing'
       AND started_at IS NOT NULL
       AND started_at < datetime('now', ? || ' minutes')`,
    [`-${stuckMinutes}`]
  );
  const recovered = result.changes;
  if (recovered > 0) {
    log.warn(`Recovered ${recovered} stuck jobs (executing >${stuckMinutes}min)`);
  }
  return recovered;
}
