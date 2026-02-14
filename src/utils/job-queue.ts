import { createLogger } from "./logger.ts";

const log = createLogger("job-queue");

export interface QueueStats {
  activeJobs: number;
  pendingJobs: number;
  maxConcurrency: number;
  totalProcessed: number;
  totalFailed: number;
}

/**
 * Concurrency-controlled async job queue for ACP jobs.
 *
 * Limits the number of simultaneously executing jobs (across all buyers)
 * while buffering overflow into a FIFO queue. Returns false from enqueue()
 * when the queue is full, signaling the caller to reject with backpressure.
 *
 * Works alongside the per-buyer lock (job-lock.ts) which serializes
 * fund-transfer jobs per buyer within the concurrency pool.
 */
export class JobQueue {
  private active = 0;
  private queue: Array<{ run: () => Promise<void>; jobId: string }> = [];
  private readonly maxConcurrency: number;
  private readonly maxQueueSize: number;
  private totalProcessed = 0;
  private totalFailed = 0;

  constructor(maxConcurrency = 5, maxQueueSize = 20) {
    this.maxConcurrency = maxConcurrency;
    this.maxQueueSize = maxQueueSize;
  }

  /**
   * Enqueue a job for execution. Returns false if queue is full (backpressure).
   * The caller should reject the ACP job with an "agent busy" message.
   */
  enqueue(jobId: string, fn: () => Promise<void>): boolean {
    if (this.queue.length >= this.maxQueueSize && this.active >= this.maxConcurrency) {
      log.warn(`Queue full (pending: ${this.queue.length}/${this.maxQueueSize}, active: ${this.active}/${this.maxConcurrency}), rejecting job #${jobId}`);
      return false;
    }

    this.queue.push({ run: fn, jobId });
    log.info(`Job #${jobId} enqueued (active: ${this.active}/${this.maxConcurrency}, pending: ${this.queue.length})`);
    this.processNext();
    return true;
  }

  private processNext(): void {
    if (this.active >= this.maxConcurrency || this.queue.length === 0) return;

    const item = this.queue.shift()!;
    this.active++;
    log.info(`Job #${item.jobId} starting (active: ${this.active}/${this.maxConcurrency})`);

    // Execute async without blocking the caller
    this.executeJob(item);
  }

  private async executeJob(item: { run: () => Promise<void>; jobId: string }): Promise<void> {
    try {
      await item.run();
      this.totalProcessed++;
    } catch (err) {
      this.totalFailed++;
      log.error(`Job #${item.jobId} failed in queue`, err);
    } finally {
      this.active--;
      log.info(`Job #${item.jobId} complete (active: ${this.active}/${this.maxConcurrency}, pending: ${this.queue.length})`);
      this.processNext();
    }
  }

  getStats(): QueueStats {
    return {
      activeJobs: this.active,
      pendingJobs: this.queue.length,
      maxConcurrency: this.maxConcurrency,
      totalProcessed: this.totalProcessed,
      totalFailed: this.totalFailed,
    };
  }

  /**
   * For graceful shutdown — clears pending queue and waits for active jobs to finish.
   * Returns once all active jobs complete or timeoutMs elapses.
   */
  async drain(timeoutMs = 10_000): Promise<void> {
    const pendingCount = this.queue.length;
    this.queue.length = 0; // clear pending queue
    if (pendingCount > 0) {
      log.info(`Cleared ${pendingCount} pending jobs from queue`);
    }

    if (this.active === 0) return;

    log.info(`Draining ${this.active} active job(s)...`);
    await Promise.race([
      new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (this.active === 0) {
            clearInterval(check);
            resolve();
          }
        }, 200);
      }),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);

    if (this.active > 0) {
      log.warn(`Drain timeout: ${this.active} job(s) still active after ${timeoutMs}ms`);
    } else {
      log.info("All active jobs drained successfully");
    }
  }
}
