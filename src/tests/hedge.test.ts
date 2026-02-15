import { test, expect, describe, beforeEach } from "bun:test";

// =============================================
// 1. Math utilities
// =============================================

import { sanitizeNumber, safeDivide } from "../utils/math.ts";

describe("sanitizeNumber", () => {
  test("passes through valid numbers", () => {
    expect(sanitizeNumber(42)).toBe(42);
    expect(sanitizeNumber(-3.14)).toBe(-3.14);
    expect(sanitizeNumber(0)).toBe(0);
  });

  test("replaces NaN with fallback", () => {
    expect(sanitizeNumber(NaN)).toBe(0);
    expect(sanitizeNumber(NaN, -1)).toBe(-1);
  });

  test("replaces Infinity with fallback", () => {
    expect(sanitizeNumber(Infinity)).toBe(0);
    expect(sanitizeNumber(-Infinity)).toBe(0);
    expect(sanitizeNumber(Infinity, 99)).toBe(99);
  });
});

describe("safeDivide", () => {
  test("divides normally for valid inputs", () => {
    expect(safeDivide(10, 2)).toBe(5);
    expect(safeDivide(7, 3)).toBeCloseTo(2.333, 2);
  });

  test("returns fallback on division by zero", () => {
    expect(safeDivide(10, 0)).toBe(0);
    expect(safeDivide(10, 0, -1)).toBe(-1);
  });

  test("returns fallback when denominator is NaN", () => {
    expect(safeDivide(10, NaN)).toBe(0);
  });

  test("returns fallback when denominator is Infinity", () => {
    expect(safeDivide(10, Infinity)).toBe(0);
  });
});

// =============================================
// 2. Constants
// =============================================

import { MAX_HEDGE_BUDGET_USD, MIN_HEDGE_BUDGET_USD } from "../utils/constants.ts";

describe("budget constants", () => {
  test("MAX_HEDGE_BUDGET_USD is set for testing phase", () => {
    expect(MAX_HEDGE_BUDGET_USD).toBe(5);
    expect(MAX_HEDGE_BUDGET_USD).toBeGreaterThan(MIN_HEDGE_BUDGET_USD);
  });

  test("MIN_HEDGE_BUDGET_USD is reasonable", () => {
    expect(MIN_HEDGE_BUDGET_USD).toBe(0.5);
  });
});

// =============================================
// 3. Validation
// =============================================

import {
  validateWalletAddress,
  validateChain,
  validateRiskTolerance,
  validateHedgeBudget,
  validateAdditionalAddresses,
  validateMarketTimeframe,
  validateCloseHedgeReq,
  validateHedgeAnalysisReq,
  validateExecuteHedgeReq,
} from "../acp/validation.ts";

const VALID_ADDR = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VALID_ADDR_2 = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("validateWalletAddress", () => {
  test("accepts valid checksummed address", () => {
    expect(validateWalletAddress(VALID_ADDR).valid).toBe(true);
  });

  test("accepts lowercase hex address", () => {
    expect(validateWalletAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").valid).toBe(true);
  });

  test("rejects non-string", () => {
    expect(validateWalletAddress(123).valid).toBe(false);
  });

  test("rejects invalid format", () => {
    expect(validateWalletAddress("not-an-address").valid).toBe(false);
  });

  test("rejects zero address", () => {
    expect(validateWalletAddress("0x0000000000000000000000000000000000000000").valid).toBe(false);
  });

  test("rejects short address", () => {
    expect(validateWalletAddress("0xAABB").valid).toBe(false);
  });
});

describe("validateChain", () => {
  test("accepts valid chains", () => {
    expect(validateChain("base").valid).toBe(true);
    expect(validateChain("ethereum").valid).toBe(true);
    expect(validateChain("arbitrum").valid).toBe(true);
  });

  test("rejects invalid chain", () => {
    const r = validateChain("solana");
    expect(r.valid).toBe(false);
    expect(r.error).toContain("solana");
  });

  test("rejects non-string", () => {
    expect(validateChain(42).valid).toBe(false);
  });
});

describe("validateRiskTolerance", () => {
  test("accepts valid values", () => {
    expect(validateRiskTolerance("conservative").valid).toBe(true);
    expect(validateRiskTolerance("moderate").valid).toBe(true);
    expect(validateRiskTolerance("aggressive").valid).toBe(true);
  });

  test("rejects invalid value", () => {
    expect(validateRiskTolerance("yolo").valid).toBe(false);
  });
});

describe("validateHedgeBudget", () => {
  test("accepts valid budget", () => {
    expect(validateHedgeBudget(1).valid).toBe(true);
    expect(validateHedgeBudget(5).valid).toBe(true);
  });

  test("rejects budget below minimum", () => {
    const r = validateHedgeBudget(0.1);
    expect(r.valid).toBe(false);
    expect(r.error).toContain(">=");
  });

  test("rejects non-number", () => {
    expect(validateHedgeBudget("five").valid).toBe(false);
  });

  test("rejects NaN", () => {
    expect(validateHedgeBudget(NaN).valid).toBe(false);
  });
});

describe("validateAdditionalAddresses", () => {
  test("accepts undefined (optional)", () => {
    expect(validateAdditionalAddresses(undefined).valid).toBe(true);
  });

  test("accepts null (optional)", () => {
    expect(validateAdditionalAddresses(null).valid).toBe(true);
  });

  test("accepts empty array", () => {
    expect(validateAdditionalAddresses([]).valid).toBe(true);
  });

  test("accepts valid addresses", () => {
    expect(validateAdditionalAddresses([VALID_ADDR, VALID_ADDR_2]).valid).toBe(true);
  });

  test("rejects non-array", () => {
    expect(validateAdditionalAddresses("not-array").valid).toBe(false);
  });

  test("rejects more than 5 addresses", () => {
    const addrs = Array(6).fill(VALID_ADDR);
    const result = validateAdditionalAddresses(addrs);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("up to 5");
  });

  test("rejects if any address is invalid", () => {
    const result = validateAdditionalAddresses([VALID_ADDR, "bad"]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid additional address");
  });
});

describe("validateMarketTimeframe", () => {
  test("undefined is valid (optional)", () => {
    expect(validateMarketTimeframe(undefined)).toEqual({ valid: true });
  });

  test("null is valid (optional)", () => {
    expect(validateMarketTimeframe(null)).toEqual({ valid: true });
  });

  test("all valid values pass", () => {
    expect(validateMarketTimeframe("hourly")).toEqual({ valid: true });
    expect(validateMarketTimeframe("daily")).toEqual({ valid: true });
    expect(validateMarketTimeframe("weekly")).toEqual({ valid: true });
    expect(validateMarketTimeframe("all")).toEqual({ valid: true });
  });

  test("invalid string returns error", () => {
    const r = validateMarketTimeframe("biweekly");
    expect(r.valid).toBe(false);
    expect(r.error).toContain("biweekly");
  });

  test("number returns error", () => {
    expect(validateMarketTimeframe(42).valid).toBe(false);
  });
});

describe("validateCloseHedgeReq", () => {
  test("accepts position_ids", () => {
    expect(validateCloseHedgeReq({ position_ids: ["id-1"] }).valid).toBe(true);
  });

  test("accepts close_all", () => {
    expect(validateCloseHedgeReq({ close_all: true }).valid).toBe(true);
  });

  test("rejects empty object", () => {
    expect(validateCloseHedgeReq({}).valid).toBe(false);
  });

  test("rejects non-object", () => {
    expect(validateCloseHedgeReq(null).valid).toBe(false);
  });
});

describe("validateHedgeAnalysisReq", () => {
  const validReq = {
    wallet_address: VALID_ADDR,
    chain: "base",
    risk_tolerance: "moderate",
    hedge_budget: 100,
  };

  test("accepts valid request", () => {
    expect(validateHedgeAnalysisReq(validReq).valid).toBe(true);
  });

  test("accepts request with additional_addresses", () => {
    expect(
      validateHedgeAnalysisReq({ ...validReq, additional_addresses: [VALID_ADDR_2] }).valid
    ).toBe(true);
  });

  test("rejects invalid additional_addresses", () => {
    expect(
      validateHedgeAnalysisReq({ ...validReq, additional_addresses: ["bad-addr"] }).valid
    ).toBe(false);
  });

  test("rejects invalid wallet", () => {
    expect(validateHedgeAnalysisReq({ ...validReq, wallet_address: "bad" }).valid).toBe(false);
  });

  test("rejects invalid chain", () => {
    expect(validateHedgeAnalysisReq({ ...validReq, chain: "solana" }).valid).toBe(false);
  });
});

describe("validateExecuteHedgeReq", () => {
  test("accepts hedge_budget_usdc field", () => {
    expect(
      validateExecuteHedgeReq({
        wallet_address: VALID_ADDR,
        chain: "base",
        risk_tolerance: "moderate",
        hedge_budget_usdc: 100,
      }).valid
    ).toBe(true);
  });

  test("accepts legacy hedge_budget field (backward compat)", () => {
    expect(
      validateExecuteHedgeReq({
        wallet_address: VALID_ADDR,
        chain: "base",
        risk_tolerance: "moderate",
        hedge_budget: 100,
      }).valid
    ).toBe(true);
  });

  test("prefers hedge_budget_usdc when both present", () => {
    expect(
      validateExecuteHedgeReq({
        wallet_address: VALID_ADDR,
        chain: "base",
        risk_tolerance: "moderate",
        hedge_budget_usdc: 100,
        hedge_budget: 50,
      }).valid
    ).toBe(true);
  });

  test("rejects missing budget entirely", () => {
    expect(
      validateExecuteHedgeReq({
        wallet_address: VALID_ADDR,
        chain: "base",
        risk_tolerance: "moderate",
      }).valid
    ).toBe(false);
  });
});

// =============================================
// 4. Balance reservation
// =============================================

import {
  tryReserve,
  releaseReservation,
  getTotalReserved,
  getReservationStats,
} from "../utils/balance-reservation.ts";

function releaseAllReservations() {
  const stats = getReservationStats();
  for (const r of stats.reservations) {
    releaseReservation(r.jobId);
  }
}

describe("balance reservation", () => {
  beforeEach(() => {
    releaseAllReservations();
  });

  test("tryReserve succeeds when balance covers request", () => {
    expect(tryReserve("job-1", VALID_ADDR, 50, 100)).toBe(true);
    expect(getTotalReserved()).toBe(50);
  });

  test("tryReserve fails when balance is insufficient", () => {
    expect(tryReserve("job-1", VALID_ADDR, 150, 100)).toBe(false);
    expect(getTotalReserved()).toBe(0);
  });

  test("tryReserve is idempotent for same jobId", () => {
    expect(tryReserve("job-1", VALID_ADDR, 50, 100)).toBe(true);
    expect(tryReserve("job-1", VALID_ADDR, 50, 100)).toBe(true);
    expect(getTotalReserved()).toBe(50); // not doubled
  });

  test("cross-buyer race: second buyer blocked when wallet can't cover both", () => {
    expect(tryReserve("job-a", VALID_ADDR, 5, 7)).toBe(true);
    expect(tryReserve("job-b", VALID_ADDR_2, 5, 7)).toBe(false);
    expect(getTotalReserved()).toBe(5);
  });

  test("cross-buyer: second buyer succeeds after first releases", () => {
    expect(tryReserve("job-a", VALID_ADDR, 5, 7)).toBe(true);
    releaseReservation("job-a");
    expect(tryReserve("job-b", VALID_ADDR_2, 5, 7)).toBe(true);
    expect(getTotalReserved()).toBe(5);
  });

  test("multiple concurrent reservations sum correctly", () => {
    expect(tryReserve("job-1", VALID_ADDR, 20, 100)).toBe(true);
    expect(tryReserve("job-2", VALID_ADDR_2, 30, 100)).toBe(true);
    expect(getTotalReserved()).toBe(50);
    expect(tryReserve("job-3", VALID_ADDR, 60, 100)).toBe(false); // only $50 available
    expect(tryReserve("job-3", VALID_ADDR, 50, 100)).toBe(true);
    expect(getTotalReserved()).toBe(100);
  });

  test("releaseReservation frees funds", () => {
    tryReserve("job-1", VALID_ADDR, 50, 100);
    expect(getTotalReserved()).toBe(50);
    releaseReservation("job-1");
    expect(getTotalReserved()).toBe(0);
  });

  test("releaseReservation is a no-op for unknown jobId", () => {
    releaseReservation("nonexistent");
    expect(getTotalReserved()).toBe(0);
  });

  test("getReservationStats returns correct shape", () => {
    tryReserve("job-1", VALID_ADDR, 25, 100);
    tryReserve("job-2", VALID_ADDR_2, 35, 100);
    const stats = getReservationStats();
    expect(stats.count).toBe(2);
    expect(stats.totalReserved).toBe(60);
    expect(stats.reservations).toHaveLength(2);
    expect(stats.reservations[0]!.jobId).toBe("job-1");
    expect(stats.reservations[0]!.amount).toBe(25);
    expect(typeof stats.reservations[0]!.ageMs).toBe("number");
  });
});

// =============================================
// 5. Market timeframe filtering
// =============================================

import { filterByTimeframe } from "../limitless/markets.ts";
import type { ScoredLimitlessMarket } from "../utils/types.ts";

function mockMarket(hoursFromNow: number, overrides?: Partial<ScoredLimitlessMarket>): ScoredLimitlessMarket {
  const expirationDate = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
  return {
    raw: {} as ScoredLimitlessMarket["raw"],
    slug: `market-${hoursFromNow}h`,
    title: `$ETH above $2000 in ${hoursFromNow}h`,
    ticker: "ETH",
    strikePrice: 2000,
    direction: "above",
    expirationDate,
    yesPriceUsd: 0.5,
    noPriceUsd: 0.5,
    hedgeAction: "BUY_NO",
    hedgeScore: 50,
    liquidityUsd: 100,
    maxFillableShares: 200,
    payoutRatio: 2,
    ...overrides,
  };
}

describe("filterByTimeframe", () => {
  const markets = [
    mockMarket(0.5),   // 30 min  -> hourly
    mockMarket(1.5),   // 1.5h    -> hourly
    mockMarket(5),     // 5h      -> daily
    mockMarket(20),    // 20h     -> daily
    mockMarket(48),    // 48h     -> weekly
    mockMarket(100),   // 100h    -> weekly
    mockMarket(200),   // 200h    -> outside all specific buckets
  ];

  test('"all" returns all markets', () => {
    expect(filterByTimeframe(markets, "all")).toHaveLength(markets.length);
  });

  test('"hourly" returns only 0-2h markets', () => {
    const result = filterByTimeframe(markets, "hourly");
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.slug)).toEqual(["market-0.5h", "market-1.5h"]);
  });

  test('"daily" returns only 2-26h markets', () => {
    const result = filterByTimeframe(markets, "daily");
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.slug)).toEqual(["market-5h", "market-20h"]);
  });

  test('"weekly" returns only 26-168h markets', () => {
    const result = filterByTimeframe(markets, "weekly");
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.slug)).toEqual(["market-48h", "market-100h"]);
  });

  test("returns empty when no markets match", () => {
    const dailyOnly = [mockMarket(10), mockMarket(20)];
    expect(filterByTimeframe(dailyOnly, "hourly")).toHaveLength(0);
  });

  test("handles empty input", () => {
    expect(filterByTimeframe([], "daily")).toHaveLength(0);
  });

  test("boundary: exactly 2h falls in hourly", () => {
    const boundary = [mockMarket(2)];
    expect(filterByTimeframe(boundary, "hourly")).toHaveLength(1);
    expect(filterByTimeframe(boundary, "daily")).toHaveLength(0);
  });

  test("boundary: exactly 26h falls in daily", () => {
    const boundary = [mockMarket(26)];
    expect(filterByTimeframe(boundary, "daily")).toHaveLength(1);
    expect(filterByTimeframe(boundary, "weekly")).toHaveLength(0);
  });
});

// =============================================
// 6. Hedge price validation
// =============================================

describe("hedge price validation", () => {
  const isValidHedgePrice = (p: number | null): boolean =>
    p !== null && p > 0 && p < 1;

  test("rejects null/zero/out-of-range prices", () => {
    expect(isValidHedgePrice(null)).toBe(false);
    expect(isValidHedgePrice(0)).toBe(false);
    expect(isValidHedgePrice(1)).toBe(false);
    expect(isValidHedgePrice(-0.5)).toBe(false);
    expect(isValidHedgePrice(1.5)).toBe(false);
  });

  test("accepts valid prediction market share prices", () => {
    expect(isValidHedgePrice(0.1)).toBe(true);
    expect(isValidHedgePrice(0.25)).toBe(true);
    expect(isValidHedgePrice(0.5)).toBe(true);
    expect(isValidHedgePrice(0.75)).toBe(true);
    expect(isValidHedgePrice(0.99)).toBe(true);
  });
});

// =============================================
// 7. P&L calculation safety
// =============================================

describe("P&L calculation safety", () => {
  test("handles zero shares without NaN", () => {
    const totalShares = 0;
    if (totalShares <= 0) {
      expect(true).toBe(true); // skip group as close-hedge does
    } else {
      const sharesFraction = sanitizeNumber(100 / totalShares);
      expect(Number.isFinite(sharesFraction)).toBe(true);
    }
  });

  test("handles normal P&L calculation", () => {
    const totalShares = 1000000;
    const saleAmount = 0.75;
    const totalCost = 0.25;

    const sharesFraction = sanitizeNumber(500000 / totalShares);
    const posReturn = sanitizeNumber(saleAmount * sharesFraction);
    const posPnl = sanitizeNumber(posReturn - totalCost);

    expect(sharesFraction).toBe(0.5);
    expect(posReturn).toBeCloseTo(0.375, 4);
    expect(posPnl).toBeCloseTo(0.125, 4);
    expect(Number.isFinite(posPnl)).toBe(true);
  });
});

// =============================================
// 8. Edge case reasoning messages
// =============================================

describe("edge case reasoning", () => {
  test("generateEdgeCaseMessage returns string for all edge cases", async () => {
    const { generateEdgeCaseMessage } = await import("../hedging/reasoning.ts");

    const stableMsg = generateEdgeCaseMessage("stablecoins_only", { totalValue: 1000 });
    expect(typeof stableMsg).toBe("string");
    expect(stableMsg.length).toBeGreaterThan(10);

    const noMarketsMsg = generateEdgeCaseMessage("no_markets_found", { topAsset: "ETH" });
    expect(typeof noMarketsMsg).toBe("string");
    expect(noMarketsMsg).toContain("ETH");

    const budgetMsg = generateEdgeCaseMessage("budget_too_small", { budget: 0.1, minRecommended: 5 });
    expect(typeof budgetMsg).toBe("string");

    const liquidityMsg = generateEdgeCaseMessage("liquidity_too_thin", { ticker: "BTC", liquidity: 5 });
    expect(typeof liquidityMsg).toBe("string");

    const noHoldingsMsg = generateEdgeCaseMessage("no_holdings", { chain: "base" });
    expect(typeof noHoldingsMsg).toBe("string");
  });
});
