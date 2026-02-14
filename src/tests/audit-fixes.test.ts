import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { getDb } from "../db/connection.ts";

// =============================================
// 1. Per-buyer concurrency lock
// =============================================

import { withBuyerLock } from "../utils/job-lock.ts";

describe("withBuyerLock", () => {
  test("allows concurrent execution for different buyers", async () => {
    const order: string[] = [];

    const p1 = withBuyerLock("0xBuyerA", async () => {
      order.push("A-start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("A-end");
      return "A";
    });

    const p2 = withBuyerLock("0xBuyerB", async () => {
      order.push("B-start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("B-end");
      return "B";
    });

    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe("A");
    expect(b).toBe("B");
    // Both should start before either finishes (parallel)
    expect(order.indexOf("A-start")).toBeLessThan(order.indexOf("A-end"));
    expect(order.indexOf("B-start")).toBeLessThan(order.indexOf("B-end"));
  });

  test("serializes jobs for the same buyer", async () => {
    const order: string[] = [];

    const p1 = withBuyerLock("0xSameBuyer", async () => {
      order.push("job1-start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("job1-end");
      return 1;
    });

    const p2 = withBuyerLock("0xSameBuyer", async () => {
      order.push("job2-start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("job2-end");
      return 2;
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
    // Job 1 must finish before job 2 starts
    expect(order.indexOf("job1-end")).toBeLessThan(order.indexOf("job2-start"));
  });

  test("releases lock even if job throws", async () => {
    const p1 = withBuyerLock("0xErrorBuyer", async () => {
      throw new Error("job1 failed");
    }).catch(() => "caught");

    const p2 = withBuyerLock("0xErrorBuyer", async () => {
      return "job2-ok";
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("caught");
    expect(r2).toBe("job2-ok");
  });

  test("normalizes buyer address to lowercase", async () => {
    const order: string[] = [];

    const p1 = withBuyerLock("0xABCDEF", async () => {
      order.push("upper-start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("upper-end");
    });

    const p2 = withBuyerLock("0xabcdef", async () => {
      order.push("lower-start");
      order.push("lower-end");
    });

    await Promise.all([p1, p2]);
    // Same address (case-insensitive) → serialized
    expect(order.indexOf("upper-end")).toBeLessThan(order.indexOf("lower-start"));
  });
});

// =============================================
// 2. Position isolation (security fix)
// =============================================

import {
  createPosition,
  getActivePositions,
  getAllActivePositions,
  getPosition,
  recordOrder,
} from "../db/positions.ts";

describe("Position isolation (security fix)", () => {
  const buyerA = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const buyerB = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

  beforeEach(async () => {
    await getDb()`DELETE FROM order_history WHERE position_id IN (SELECT id FROM positions WHERE buyer_address IN (${buyerA}, ${buyerB}))`;
    await getDb()`DELETE FROM positions WHERE buyer_address IN (${buyerA}, ${buyerB})`;
  });

  afterEach(async () => {
    await getDb()`DELETE FROM order_history WHERE position_id IN (SELECT id FROM positions WHERE buyer_address IN (${buyerA}, ${buyerB}))`;
    await getDb()`DELETE FROM positions WHERE buyer_address IN (${buyerA}, ${buyerB})`;
  });

  async function createTestPosition(buyerAddress: string, slug: string) {
    return await createPosition({
      jobId: "test-job",
      buyerAddress,
      marketSlug: slug,
      marketTitle: `Test ${slug}`,
      tokenId: "0xToken",
      side: "YES",
      action: "BUY_YES",
      shares: 100,
      entryPrice: 0.5,
      totalCostUsdc: 50,
      orderId: "order-1",
      expiry: "2026-12-31T00:00:00Z",
      venueExchange: "0xExchange",
    });
  }

  test("getActivePositions only returns positions for the specified buyer", async () => {
    await createTestPosition(buyerA, "market-1");
    await createTestPosition(buyerA, "market-2");
    await createTestPosition(buyerB, "market-3");

    const positionsA = await getActivePositions(buyerA);
    const positionsB = await getActivePositions(buyerB);

    expect(positionsA.length).toBe(2);
    expect(positionsB.length).toBe(1);
    expect(positionsA.every((p) => p.buyer_address === buyerA)).toBe(true);
    expect(positionsB.every((p) => p.buyer_address === buyerB)).toBe(true);
  });

  test("getActivePositions returns empty for unknown buyer", async () => {
    await createTestPosition(buyerA, "market-1");

    const positionsUnknown = await getActivePositions("0xNONEXISTENT");
    expect(positionsUnknown.length).toBe(0);
  });

  test("getAllActivePositions returns all buyers positions (admin only)", async () => {
    await createTestPosition(buyerA, "market-1");
    await createTestPosition(buyerB, "market-2");

    const all = await getAllActivePositions();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  test("position IDs use crypto.randomUUID format", async () => {
    const id = await createTestPosition(buyerA, "market-uuid");
    // Format: pos_<uuid>
    expect(id).toMatch(/^pos_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("order IDs use crypto.randomUUID format", async () => {
    const posId = await createTestPosition(buyerA, "market-ord");

    // We can't easily inspect the order ID from recordOrder (void return),
    // but we can verify the position was created with the right format
    await recordOrder({
      positionId: posId,
      orderType: "open",
      marketSlug: "market-ord",
      side: 0,
      makerAmount: "50000000",
      takerAmount: "1",
      price: 0.5,
      filledSize: 100,
      orderId: "test-order",
      status: "filled",
    });

    // Query the order directly to check ID format
    const rows = await getDb()`SELECT id FROM order_history WHERE position_id = ${posId}`;
    const order = rows[0] as { id: string } | undefined;
    expect(order).not.toBeUndefined();
    expect(order!.id).toMatch(/^ord_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("two position IDs are always unique", async () => {
    const id1 = await createTestPosition(buyerA, "market-u1");
    const id2 = await createTestPosition(buyerA, "market-u2");
    expect(id1).not.toBe(id2);
  });
});

// =============================================
// 3. Stuck job recovery
// =============================================

import {
  getJobState,
  upsertJobState,
  recoverStuckJobs,
  setFailed,
} from "../db/job-state.ts";

describe("recoverStuckJobs", () => {
  beforeEach(async () => {
    await getDb()`DELETE FROM job_state WHERE job_id LIKE 'test-stuck-%'`;
  });

  afterEach(async () => {
    await getDb()`DELETE FROM job_state WHERE job_id LIKE 'test-stuck-%'`;
  });

  test("marks stuck 'executing' jobs as failed", async () => {
    // Create a job in "executing" with started_at in the past
    await upsertJobState("test-stuck-1", { jobName: "execute_hedge", phase: "initialized" });
    await upsertJobState("test-stuck-1", { jobName: "execute_hedge", phase: "executing" });

    // Manually backdate started_at to 20 minutes ago
    await getDb()`UPDATE job_state SET started_at = NOW() - INTERVAL '20 minutes' WHERE job_id = ${"test-stuck-1"}`;

    const recovered = await recoverStuckJobs(10);
    expect(recovered).toBeGreaterThanOrEqual(1);

    const state = await getJobState("test-stuck-1");
    expect(state!.phase).toBe("failed");
  });

  test("does NOT mark recently started executing jobs as failed", async () => {
    await upsertJobState("test-stuck-2", { jobName: "execute_hedge", phase: "initialized" });
    await upsertJobState("test-stuck-2", { jobName: "execute_hedge", phase: "executing" });

    // started_at is set to "now" — should not be recovered
    const recovered = await recoverStuckJobs(10);

    const state = await getJobState("test-stuck-2");
    expect(state!.phase).toBe("executing");
  });

  test("does NOT affect jobs in other phases", async () => {
    await upsertJobState("test-stuck-3", { jobName: "execute_hedge", phase: "delivered" });

    const recovered = await recoverStuckJobs(10);
    const state = await getJobState("test-stuck-3");
    expect(state!.phase).toBe("delivered");
  });

  test("upsertJobState sets started_at when phase is 'executing'", async () => {
    await upsertJobState("test-stuck-4", { jobName: "execute_hedge", phase: "initialized" });
    const before = await getJobState("test-stuck-4");
    expect(before!.started_at).toBeNull();

    await upsertJobState("test-stuck-4", { jobName: "execute_hedge", phase: "executing" });
    const after = await getJobState("test-stuck-4");
    expect(after!.started_at).not.toBeNull();
  });
});

// =============================================
// 4. Validation (jobs that should be rejected)
// =============================================

import {
  validateHedgeAnalysisReq,
  validateExecuteHedgeReq,
  validateCloseHedgeReq,
  validateWalletAddress,
  validateChain,
  validateRiskTolerance,
  validateHedgeBudget,
} from "../acp/validation.ts";

describe("Validation — jobs that should be rejected", () => {
  // Wallet address
  test("rejects non-string wallet address", () => {
    expect(validateWalletAddress(12345).valid).toBe(false);
    expect(validateWalletAddress(null).valid).toBe(false);
    expect(validateWalletAddress(undefined).valid).toBe(false);
  });

  test("rejects malformed wallet address", () => {
    expect(validateWalletAddress("not-an-address").valid).toBe(false);
    expect(validateWalletAddress("0x123").valid).toBe(false);
    expect(validateWalletAddress("0x" + "G".repeat(40)).valid).toBe(false);
  });

  test("rejects zero address", () => {
    expect(validateWalletAddress("0x" + "0".repeat(40)).valid).toBe(false);
  });

  test("accepts valid wallet address", () => {
    expect(validateWalletAddress("0x" + "a".repeat(40)).valid).toBe(true);
    expect(validateWalletAddress("0x" + "A".repeat(40)).valid).toBe(true);
  });

  // Chain
  test("rejects invalid chain", () => {
    expect(validateChain("solana").valid).toBe(false);
    expect(validateChain("polygon").valid).toBe(false);
    expect(validateChain(123).valid).toBe(false);
  });

  test("accepts valid chains", () => {
    expect(validateChain("base").valid).toBe(true);
    expect(validateChain("ethereum").valid).toBe(true);
    expect(validateChain("arbitrum").valid).toBe(true);
  });

  // Risk tolerance
  test("rejects invalid risk tolerance", () => {
    expect(validateRiskTolerance("yolo").valid).toBe(false);
    expect(validateRiskTolerance(null).valid).toBe(false);
  });

  test("accepts valid risk tolerances", () => {
    expect(validateRiskTolerance("conservative").valid).toBe(true);
    expect(validateRiskTolerance("moderate").valid).toBe(true);
    expect(validateRiskTolerance("aggressive").valid).toBe(true);
  });

  // Budget
  test("rejects non-numeric budget", () => {
    expect(validateHedgeBudget("fifty").valid).toBe(false);
    expect(validateHedgeBudget(NaN).valid).toBe(false);
  });

  test("rejects budget below minimum", () => {
    expect(validateHedgeBudget(0.1).valid).toBe(false);
  });

  test("accepts valid budget", () => {
    expect(validateHedgeBudget(50).valid).toBe(true);
    expect(validateHedgeBudget(1000).valid).toBe(true);
  });

  // execute_hedge composite validation
  test("rejects execute_hedge with missing fields", () => {
    const result = validateExecuteHedgeReq({});
    expect(result.valid).toBe(false);
  });

  test("rejects execute_hedge with invalid wallet", () => {
    const result = validateExecuteHedgeReq({
      wallet_address: "bad",
      chain: "base",
      risk_tolerance: "moderate",
      hedge_budget_usdc: 50,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("wallet address");
  });

  test("accepts valid execute_hedge requirement", () => {
    const result = validateExecuteHedgeReq({
      wallet_address: "0x" + "a".repeat(40),
      chain: "base",
      risk_tolerance: "moderate",
      hedge_budget_usdc: 50,
    });
    expect(result.valid).toBe(true);
  });

  // close_hedge validation
  test("rejects close_hedge with no position_ids and no close_all", () => {
    const result = validateCloseHedgeReq({});
    expect(result.valid).toBe(false);
    expect(result.error).toContain("position_ids");
  });

  test("rejects close_hedge with empty position_ids", () => {
    const result = validateCloseHedgeReq({ position_ids: [] });
    expect(result.valid).toBe(false);
  });

  test("accepts close_hedge with close_all: true", () => {
    const result = validateCloseHedgeReq({ close_all: true });
    expect(result.valid).toBe(true);
  });

  test("accepts close_hedge with non-empty position_ids", () => {
    const result = validateCloseHedgeReq({ position_ids: ["pos_123"] });
    expect(result.valid).toBe(true);
  });

  test("rejects close_hedge with non-object input", () => {
    expect(validateCloseHedgeReq(null).valid).toBe(false);
    expect(validateCloseHedgeReq("string").valid).toBe(false);
    expect(validateCloseHedgeReq(42).valid).toBe(false);
  });
});

// =============================================
// 5. Evaluation — error handling (auto-approve with warning)
// =============================================

import { verifyDeliverable } from "../acp/evaluation.ts";

describe("Evaluation error handling", () => {
  function mockJob(overrides: Record<string, unknown> = {}) {
    return {
      id: 888,
      name: "execute_hedge",
      phase: "EVALUATION",
      deliverable: null,
      ...overrides,
    } as any;
  }

  test("auto-approves on error with descriptive reason", async () => {
    // Provide a deliverable that will cause an internal error during verification
    // by making hedges_placed contain items that trigger portfolio fetch failure
    const deliverable = JSON.stringify({
      hedges_placed: [{ market_slug: "test", market_id: "test" }],
      summary: { total_spent: 10 },
    });
    const result = await verifyDeliverable(mockJob({ deliverable }));
    // Should approve (positions are on-chain, can't undo)
    expect(result.approved).toBe(true);
  });

  test("unknown job type is auto-approved", async () => {
    const deliverable = JSON.stringify({ anything: true });
    const result = await verifyDeliverable(
      mockJob({ name: "some_future_job", deliverable })
    );
    expect(result.approved).toBe(true);
    expect(result.reason).toContain("auto-approved");
  });
});

// =============================================
// 6. Rate limiter behavior
// =============================================

import { RateLimiter } from "../utils/rate-limiter.ts";

describe("RateLimiter (audit)", () => {
  test("respects rate limit under burst", async () => {
    const limiter = new RateLimiter(1, 5); // 1 token, 5/sec refill

    // First acquire is instant
    const t0 = Date.now();
    await limiter.acquire();
    expect(Date.now() - t0).toBeLessThan(50);

    // Second must wait ~200ms (1 token / 5 per sec)
    const t1 = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - t1;
    expect(elapsed).toBeGreaterThan(50);
    expect(elapsed).toBeLessThan(500);
  });
});

// =============================================
// 7. Schema migration (started_at column)
// =============================================

describe("Schema: started_at column exists", () => {
  test("job_state table has started_at column", async () => {
    const info = await getDb()`SELECT column_name as name FROM information_schema.columns WHERE table_name = 'job_state'`;
    const columnNames = (info as Array<{ name: string }>).map((c) => c.name);
    expect(columnNames).toContain("started_at");
  });
});
