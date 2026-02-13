/**
 * Token bucket rate limiter for API call throttling.
 * Per ACP best practices: implement client-side rate limiting (~5 calls/sec).
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second

  constructor(maxTokens: number = 5, refillRate: number = 5) {
    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  /**
   * Acquire a token before making an API call.
   * Waits if no tokens are available.
   */
  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens < 1) {
      const waitMs = Math.ceil(((1 - this.tokens) / this.refillRate) * 1000);
      await new Promise((r) => setTimeout(r, waitMs));
      this.refill();
    }

    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}
