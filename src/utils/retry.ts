import { createLogger } from "./logger.ts";

const log = createLogger("retry");

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Optional predicate to decide whether to retry a specific error. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
};

/**
 * Execute an async function with exponential backoff retry.
 * Per ACP best practices: SDK has no built-in retry, agents must implement their own.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt === opts.maxRetries) break;
      if (opts.shouldRetry && !opts.shouldRetry(err, attempt)) break;

      const jitter = Math.random() * 1000;
      const delay = Math.min(
        opts.baseDelayMs * Math.pow(2, attempt) + jitter,
        opts.maxDelayMs
      );

      log.warn(`Attempt ${attempt + 1} failed, retrying in ${Math.round(delay)}ms`, {
        error: err instanceof Error ? err.message : String(err),
      });

      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}
