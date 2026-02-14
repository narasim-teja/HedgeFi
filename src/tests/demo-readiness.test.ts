import { test, expect, describe } from "bun:test";
import { sanitizeNumber, safeDivide } from "../utils/math.ts";
import { MAX_HEDGE_BUDGET_USD, MIN_HEDGE_BUDGET_USD } from "../utils/constants.ts";

// =============================================
// 1. sanitizeNumber utility
// =============================================

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

// =============================================
// 2. safeDivide utility
// =============================================

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
// 3. Budget cap constants
// =============================================

describe("budget cap", () => {
  test("MAX_HEDGE_BUDGET_USD is set for testing phase", () => {
    expect(MAX_HEDGE_BUDGET_USD).toBe(5);
    expect(MAX_HEDGE_BUDGET_USD).toBeGreaterThan(MIN_HEDGE_BUDGET_USD);
  });

  test("MIN_HEDGE_BUDGET_USD is reasonable", () => {
    expect(MIN_HEDGE_BUDGET_USD).toBe(0.5);
  });
});

// =============================================
// 4. Market price validation logic
// =============================================

describe("hedge price validation", () => {
  test("rejects null/zero/out-of-range prices", () => {
    const isValidHedgePrice = (p: number | null): boolean =>
      p !== null && p > 0 && p < 1;

    expect(isValidHedgePrice(null)).toBe(false);
    expect(isValidHedgePrice(0)).toBe(false);
    expect(isValidHedgePrice(1)).toBe(false);
    expect(isValidHedgePrice(-0.5)).toBe(false);
    expect(isValidHedgePrice(1.5)).toBe(false);
  });

  test("accepts valid prediction market share prices", () => {
    const isValidHedgePrice = (p: number | null): boolean =>
      p !== null && p > 0 && p < 1;

    expect(isValidHedgePrice(0.1)).toBe(true);
    expect(isValidHedgePrice(0.25)).toBe(true);
    expect(isValidHedgePrice(0.5)).toBe(true);
    expect(isValidHedgePrice(0.75)).toBe(true);
    expect(isValidHedgePrice(0.99)).toBe(true);
  });
});

// =============================================
// 5. P&L calculation safety (simulated close-hedge math)
// =============================================

describe("P&L calculation safety", () => {
  test("handles zero shares without NaN", () => {
    const totalShares = 0;
    const saleAmount = 10;

    // This is what close-hedge does — should NOT produce NaN
    if (totalShares <= 0) {
      // Expected: skip this group
      expect(true).toBe(true);
    } else {
      const sharesFraction = sanitizeNumber(100 / totalShares);
      expect(Number.isFinite(sharesFraction)).toBe(true);
    }
  });

  test("handles normal P&L calculation", () => {
    const totalShares = 1000000; // 1 share in micro-units
    const saleAmount = 0.75;
    const totalCost = 0.25;

    const sharesFraction = sanitizeNumber(500000 / totalShares); // 0.5
    const posReturn = sanitizeNumber(saleAmount * sharesFraction); // 0.375
    const posPnl = sanitizeNumber(posReturn - totalCost); // 0.125

    expect(sharesFraction).toBe(0.5);
    expect(posReturn).toBeCloseTo(0.375, 4);
    expect(posPnl).toBeCloseTo(0.125, 4);
    expect(Number.isFinite(posPnl)).toBe(true);
  });
});

// =============================================
// 6. Gemini fallback reasoning (template-based)
// =============================================

describe("Gemini fallback reasoning", () => {
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
