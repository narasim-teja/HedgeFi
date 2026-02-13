import { createLogger } from "./logger.ts";

const log = createLogger("job-lock");

/**
 * Per-buyer concurrency lock for fund-transfer jobs.
 * Serializes execute_hedge and close_hedge jobs per buyer address
 * so two jobs from the same buyer never run simultaneously
 * (avoids double-sell, race conditions on positions).
 *
 * Different buyers can still run in parallel.
 */

const locks = new Map<string, Promise<void>>();

/**
 * Execute `fn` while holding a per-buyer lock.
 * If another job for the same buyer is already running, this waits until it completes.
 */
export function withBuyerLock<T>(
  buyerAddress: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = buyerAddress.toLowerCase();
  const prev = locks.get(key) ?? Promise.resolve();

  let resolve: () => void;
  const gate = new Promise<void>((r) => { resolve = r; });
  locks.set(key, gate);

  return prev.then(
    () => runAndRelease(),
    () => runAndRelease() // run even if previous job failed
  );

  async function runAndRelease(): Promise<T> {
    log.debug(`Lock acquired for ${key}`);
    try {
      return await fn();
    } finally {
      resolve!();
      // Clean up if no other job is queued behind us
      if (locks.get(key) === gate) {
        locks.delete(key);
      }
      log.debug(`Lock released for ${key}`);
    }
  }
}
