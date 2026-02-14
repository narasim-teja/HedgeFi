import { test, expect, describe } from "bun:test";
import { filterByTimeframe } from "../limitless/markets.ts";
import { validateMarketTimeframe } from "../acp/validation.ts";
import type { ScoredLimitlessMarket } from "../utils/types.ts";

// =============================================
// Helper: build a mock ScoredLimitlessMarket
// =============================================

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

// =============================================
// filterByTimeframe tests
// =============================================

describe("filterByTimeframe", () => {
  const markets = [
    mockMarket(0.5),   // 30 min  → hourly
    mockMarket(1.5),   // 1.5h    → hourly
    mockMarket(5),     // 5h      → daily
    mockMarket(20),    // 20h     → daily
    mockMarket(48),    // 48h     → weekly
    mockMarket(100),   // 100h    → weekly
    mockMarket(200),   // 200h    → outside all specific buckets
  ];

  test('"all" returns all markets unchanged', () => {
    const result = filterByTimeframe(markets, "all");
    expect(result).toHaveLength(markets.length);
  });

  test('"hourly" returns only markets with 0 < hoursToExpiry <= 2', () => {
    const result = filterByTimeframe(markets, "hourly");
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.slug)).toEqual(["market-0.5h", "market-1.5h"]);
  });

  test('"daily" returns only markets with 2 < hoursToExpiry <= 26', () => {
    const result = filterByTimeframe(markets, "daily");
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.slug)).toEqual(["market-5h", "market-20h"]);
  });

  test('"weekly" returns only markets with 26 < hoursToExpiry <= 168', () => {
    const result = filterByTimeframe(markets, "weekly");
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.slug)).toEqual(["market-48h", "market-100h"]);
  });

  test("returns empty array when no markets match the timeframe", () => {
    const dailyOnly = [mockMarket(10), mockMarket(20)];
    const result = filterByTimeframe(dailyOnly, "hourly");
    expect(result).toHaveLength(0);
  });

  test("handles empty input array", () => {
    const result = filterByTimeframe([], "daily");
    expect(result).toHaveLength(0);
  });

  test("boundary: market at exactly 2h falls in hourly (inclusive upper bound)", () => {
    const boundary = [mockMarket(2)];
    const hourly = filterByTimeframe(boundary, "hourly");
    const daily = filterByTimeframe(boundary, "daily");
    expect(hourly).toHaveLength(1);
    expect(daily).toHaveLength(0);
  });

  test("boundary: market at exactly 26h falls in daily (inclusive upper bound)", () => {
    const boundary = [mockMarket(26)];
    const daily = filterByTimeframe(boundary, "daily");
    const weekly = filterByTimeframe(boundary, "weekly");
    expect(daily).toHaveLength(1);
    expect(weekly).toHaveLength(0);
  });
});

// =============================================
// validateMarketTimeframe tests
// =============================================

describe("validateMarketTimeframe", () => {
  test("undefined is valid (optional field)", () => {
    expect(validateMarketTimeframe(undefined)).toEqual({ valid: true });
  });

  test("null is valid (optional field)", () => {
    expect(validateMarketTimeframe(null)).toEqual({ valid: true });
  });

  test('"hourly" is valid', () => {
    expect(validateMarketTimeframe("hourly")).toEqual({ valid: true });
  });

  test('"daily" is valid', () => {
    expect(validateMarketTimeframe("daily")).toEqual({ valid: true });
  });

  test('"weekly" is valid', () => {
    expect(validateMarketTimeframe("weekly")).toEqual({ valid: true });
  });

  test('"all" is valid', () => {
    expect(validateMarketTimeframe("all")).toEqual({ valid: true });
  });

  test("invalid string returns error", () => {
    const result = validateMarketTimeframe("biweekly");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("biweekly");
    expect(result.error).toContain("hourly");
  });

  test("number returns error", () => {
    const result = validateMarketTimeframe(42);
    expect(result.valid).toBe(false);
  });
});
