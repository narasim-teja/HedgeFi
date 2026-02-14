import { test, expect, describe, beforeEach, afterEach } from "bun:test";

// =============================================
// 1. Retry utility
// =============================================

import { withRetry } from "../utils/retry.ts";

describe("withRetry", () => {
  test("returns result on first success", async () => {
    const result = await withRetry(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  test("retries on failure then succeeds", async () => {
    let attempt = 0;
    const result = await withRetry(
      () => {
        attempt++;
        if (attempt < 3) throw new Error("fail");
        return Promise.resolve("ok");
      },
      { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50 }
    );
    expect(result).toBe("ok");
    expect(attempt).toBe(3);
  });

  test("throws after max retries exhausted", async () => {
    let attempt = 0;
    try {
      await withRetry(
        () => {
          attempt++;
          throw new Error("always fails");
        },
        { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 }
      );
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect((err as Error).message).toBe("always fails");
      expect(attempt).toBe(3); // initial + 2 retries
    }
  });

  test("respects shouldRetry predicate", async () => {
    let attempt = 0;
    try {
      await withRetry(
        () => {
          attempt++;
          throw new Error("non-retryable");
        },
        {
          maxRetries: 5,
          baseDelayMs: 10,
          maxDelayMs: 50,
          shouldRetry: () => false,
        }
      );
    } catch {
      // shouldRetry returned false on first failure, so only 1 attempt
      expect(attempt).toBe(1);
    }
  });
});

// =============================================
// 2. Rate limiter
// =============================================

import { RateLimiter } from "../utils/rate-limiter.ts";

describe("RateLimiter", () => {
  test("allows immediate acquire when tokens available", async () => {
    const limiter = new RateLimiter(5, 5);
    const start = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  test("drains tokens and waits for refill", async () => {
    const limiter = new RateLimiter(2, 10); // 2 tokens, 10/sec refill
    // Drain both tokens
    await limiter.acquire();
    await limiter.acquire();

    const start = Date.now();
    await limiter.acquire(); // must wait for refill
    const elapsed = Date.now() - start;
    // Should wait ~100ms for 1 token at 10/sec
    expect(elapsed).toBeGreaterThan(20);
    expect(elapsed).toBeLessThan(500);
  });
});

// =============================================
// 3. Env validator
// =============================================

import { validateEnvironment } from "../utils/env-validator.ts";

describe("validateEnvironment", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    process.env.DATABASE_URL = originalEnv.DATABASE_URL;
    process.env.HEDGEFI_PRIVATE_KEY = originalEnv.HEDGEFI_PRIVATE_KEY;
    process.env.HEDGEFI_ENTITY_ID = originalEnv.HEDGEFI_ENTITY_ID;
    process.env.HEDGEFI_WALLET_ADDRESS = originalEnv.HEDGEFI_WALLET_ADDRESS;
    process.env.GEMINI_API_KEY = originalEnv.GEMINI_API_KEY;
  });

  test("passes with valid env vars", () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
    process.env.HEDGEFI_PRIVATE_KEY = "0x" + "a".repeat(64);
    process.env.HEDGEFI_ENTITY_ID = "12345";
    process.env.HEDGEFI_WALLET_ADDRESS = "0x" + "b".repeat(40);
    process.env.GEMINI_API_KEY = "test-key";

    expect(() => validateEnvironment()).not.toThrow();
  });

  test("warns but does not throw on missing GEMINI_API_KEY", () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
    process.env.HEDGEFI_PRIVATE_KEY = "0x" + "a".repeat(64);
    process.env.HEDGEFI_ENTITY_ID = "12345";
    process.env.HEDGEFI_WALLET_ADDRESS = "0x" + "b".repeat(40);
    delete process.env.GEMINI_API_KEY;

    // GEMINI_API_KEY is now optional — should warn but not throw
    expect(() => validateEnvironment()).not.toThrow();
  });

  test("throws on invalid private key format", () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
    process.env.HEDGEFI_PRIVATE_KEY = "not-a-key";
    process.env.HEDGEFI_ENTITY_ID = "12345";
    process.env.HEDGEFI_WALLET_ADDRESS = "0x" + "b".repeat(40);
    process.env.GEMINI_API_KEY = "test-key";

    expect(() => validateEnvironment()).toThrow(/HEDGEFI_PRIVATE_KEY/);
  });

  test("throws on non-numeric entity ID", () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
    process.env.HEDGEFI_PRIVATE_KEY = "0x" + "a".repeat(64);
    process.env.HEDGEFI_ENTITY_ID = "abc";
    process.env.HEDGEFI_WALLET_ADDRESS = "0x" + "b".repeat(40);
    process.env.GEMINI_API_KEY = "test-key";

    expect(() => validateEnvironment()).toThrow(/HEDGEFI_ENTITY_ID/);
  });
});

// =============================================
// 4. Logger withJob
// =============================================

import { createLogger } from "../utils/logger.ts";

describe("Logger.withJob", () => {
  test("returns a scoped logger with all methods", () => {
    const log = createLogger("test-component");
    const jlog = log.withJob(42);

    expect(typeof jlog.info).toBe("function");
    expect(typeof jlog.warn).toBe("function");
    expect(typeof jlog.error).toBe("function");
    expect(typeof jlog.debug).toBe("function");
    expect(typeof jlog.time).toBe("function");
  });

  test("withJob logger can be called without error", () => {
    const log = createLogger("test-component");
    const jlog = log.withJob("test-123");

    // These should not throw
    expect(() => jlog.info("test message")).not.toThrow();
    expect(() => jlog.warn("test warning")).not.toThrow();
    expect(() => jlog.debug("test debug")).not.toThrow();
  });
});

// =============================================
// 5. Job state CRUD
// =============================================

import {
  getJobState,
  upsertJobState,
  setConfirmationSent,
  setConfirmed,
  setDelivered,
  setFailed,
  cleanupOldJobs,
} from "../db/job-state.ts";
import { getDb } from "../db/connection.ts";

describe("Job State CRUD", () => {
  beforeEach(async () => {
    // Clean up any test rows
    await getDb()`DELETE FROM job_state WHERE job_id LIKE 'test-%'`;
  });

  afterEach(async () => {
    await getDb()`DELETE FROM job_state WHERE job_id LIKE 'test-%'`;
  });

  test("upsertJobState creates a new record", async () => {
    await upsertJobState("test-1", { jobName: "execute_hedge", phase: "initialized" });
    const state = await getJobState("test-1");

    expect(state).not.toBeNull();
    expect(state!.job_id).toBe("test-1");
    expect(state!.job_name).toBe("execute_hedge");
    expect(state!.phase).toBe("initialized");
    expect(state!.confirmation_sent).toBe(0);
    expect(state!.confirmation_payload).toBeNull();
  });

  test("upsertJobState updates existing record", async () => {
    await upsertJobState("test-2", { jobName: "execute_hedge", phase: "initialized" });
    await upsertJobState("test-2", { jobName: "execute_hedge", phase: "analysis_complete" });

    const state = await getJobState("test-2");
    expect(state!.phase).toBe("analysis_complete");
  });

  test("setConfirmationSent stores payload and updates phase", async () => {
    await upsertJobState("test-3", { jobName: "execute_hedge", phase: "initialized" });

    const plan = JSON.stringify({ budget: 100, recommendations: [] });
    await setConfirmationSent("test-3", plan);

    const state = await getJobState("test-3");
    expect(state!.confirmation_sent).toBe(1);
    expect(state!.confirmation_payload).toBe(plan);
    expect(state!.phase).toBe("awaiting_confirmation");
  });

  test("setConfirmed updates phase", async () => {
    await upsertJobState("test-4", { jobName: "execute_hedge", phase: "awaiting_confirmation" });
    await setConfirmed("test-4");

    const state = await getJobState("test-4");
    expect(state!.phase).toBe("confirmed");
  });

  test("setDelivered updates phase", async () => {
    await upsertJobState("test-5", { jobName: "execute_hedge", phase: "confirmed" });
    await setDelivered("test-5");

    const state = await getJobState("test-5");
    expect(state!.phase).toBe("delivered");
  });

  test("setFailed updates phase", async () => {
    await upsertJobState("test-6", { jobName: "execute_hedge", phase: "executing" });
    await setFailed("test-6");

    const state = await getJobState("test-6");
    expect(state!.phase).toBe("failed");
  });

  test("getJobState returns null for non-existent job", async () => {
    const state = await getJobState("test-nonexistent");
    expect(state).toBeNull();
  });

  test("cleanupOldJobs does not delete recent records", async () => {
    await upsertJobState("test-7", { jobName: "execute_hedge", phase: "delivered" });

    const deleted = await cleanupOldJobs(30);
    expect(deleted).toBe(0);

    const state = await getJobState("test-7");
    expect(state).not.toBeNull();
  });

  test("upsertJobState stores buyer address", async () => {
    await upsertJobState("test-8", {
      jobName: "close_hedge",
      phase: "initialized",
      buyerAddress: "0xABC123",
    });

    const state = await getJobState("test-8");
    expect(state!.buyer_address).toBe("0xABC123");
  });

  test("full confirmation flow lifecycle", async () => {
    // 1. Initialize
    await upsertJobState("test-flow", { jobName: "execute_hedge", phase: "initialized", buyerAddress: "0xBuyer" });
    expect((await getJobState("test-flow"))!.phase).toBe("initialized");

    // 2. Send confirmation
    const plan = JSON.stringify({ budget: 50 });
    await setConfirmationSent("test-flow", plan);
    const afterConfSent = (await getJobState("test-flow"))!;
    expect(afterConfSent.phase).toBe("awaiting_confirmation");
    expect(afterConfSent.confirmation_sent).toBe(1);
    expect(afterConfSent.confirmation_payload).toBe(plan);

    // 3. Buyer confirms
    await setConfirmed("test-flow");
    expect((await getJobState("test-flow"))!.phase).toBe("confirmed");

    // 4. Delivered
    await setDelivered("test-flow");
    expect((await getJobState("test-flow"))!.phase).toBe("delivered");
  });
});

// =============================================
// 6. Evaluation logic (unit tests with mocked job)
// =============================================

import { verifyDeliverable } from "../acp/evaluation.ts";

function mockJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 999,
    name: "hedge_analysis",
    phase: "EVALUATION",
    deliverable: null,
    ...overrides,
  } as any;
}

describe("verifyDeliverable", () => {
  test("rejects when no deliverable", async () => {
    const result = await verifyDeliverable(mockJob({ deliverable: null }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("No deliverable");
  });

  test("rejects invalid JSON deliverable", async () => {
    const result = await verifyDeliverable(mockJob({ deliverable: "not-json{{{" }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("not valid JSON");
  });

  // hedge_analysis
  test("approves valid hedge_analysis deliverable", async () => {
    const deliverable = JSON.stringify({
      exposure: { total_value_usd: 1000, tokens: [], concentration_risk: "low", top_exposure: "ETH" },
      recommended_hedges: [{ market_id: "m1", action: "BUY_NO", shares: 10, estimated_cost_usd: 5 }],
      reasoning: "This is a valid reasoning string for the hedge analysis.",
    });
    const result = await verifyDeliverable(mockJob({ name: "hedge_analysis", deliverable }));
    expect(result.approved).toBe(true);
    expect(result.reason).toContain("1 recommendations");
  });

  test("rejects hedge_analysis missing exposure", async () => {
    const deliverable = JSON.stringify({
      recommended_hedges: [],
      reasoning: "some reasoning",
    });
    const result = await verifyDeliverable(mockJob({ name: "hedge_analysis", deliverable }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Missing required fields");
  });

  test("rejects hedge_analysis with empty reasoning", async () => {
    const deliverable = JSON.stringify({
      exposure: { total_value_usd: 1000 },
      recommended_hedges: [],
      reasoning: "short",
    });
    const result = await verifyDeliverable(mockJob({ name: "hedge_analysis", deliverable }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("too short");
  });

  // execute_hedge
  test("rejects execute_hedge with no hedges_placed array", async () => {
    const deliverable = JSON.stringify({ summary: { total_spent: 0 } });
    const result = await verifyDeliverable(mockJob({ name: "execute_hedge", deliverable }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("hedges_placed");
  });

  test("approves execute_hedge with zero hedges but reasoning", async () => {
    const deliverable = JSON.stringify({
      hedges_placed: [],
      summary: { total_spent: 0 },
      reasoning: "No suitable markets found",
    });
    const result = await verifyDeliverable(mockJob({ name: "execute_hedge", deliverable }));
    expect(result.approved).toBe(true);
    expect(result.reason).toContain("No hedges placed but reasoning provided");
  });

  test("rejects execute_hedge with zero hedges and no reasoning", async () => {
    const deliverable = JSON.stringify({
      hedges_placed: [],
      summary: { total_spent: 0 },
    });
    const result = await verifyDeliverable(mockJob({ name: "execute_hedge", deliverable }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("No hedges placed and no reasoning");
  });

  // close_hedge
  test("approves close_hedge with no positions to close", async () => {
    const deliverable = JSON.stringify({
      positions_closed: [],
      total_returned_usdc: 0,
    });
    const result = await verifyDeliverable(mockJob({ name: "close_hedge", deliverable }));
    expect(result.approved).toBe(true);
    expect(result.reason).toContain("No positions to close");
  });

  test("approves close_hedge with closed positions", async () => {
    const deliverable = JSON.stringify({
      positions_closed: [{ market_id: "m1", shares_sold: 10, sale_price: 0.6, realized_pnl: 1.5 }],
      total_returned_usdc: 6.0,
    });
    const result = await verifyDeliverable(mockJob({ name: "close_hedge", deliverable }));
    expect(result.approved).toBe(true);
    expect(result.reason).toContain("1 positions closed");
    expect(result.reason).toContain("$6.00");
  });

  test("rejects close_hedge missing positions_closed", async () => {
    const deliverable = JSON.stringify({ total_returned_usdc: 0 });
    const result = await verifyDeliverable(mockJob({ name: "close_hedge", deliverable }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("positions_closed");
  });

  // Unknown job type
  test("auto-approves unknown job type", async () => {
    const deliverable = JSON.stringify({ foo: "bar" });
    const result = await verifyDeliverable(mockJob({ name: "unknown_job", deliverable }));
    expect(result.approved).toBe(true);
    expect(result.reason).toContain("auto-approved");
  });
});
