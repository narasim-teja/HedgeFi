import { createLogger } from "../utils/logger.ts";
import {
  RISK_TOLERANCE_DROP_TARGETS,
  MAX_SINGLE_MARKET_ALLOCATION,
  SYMBOL_TO_LIMITLESS_TICKER,
  MIN_HEDGE_BUDGET_USD,
  STABLECOIN_SYMBOLS,
} from "../utils/constants.ts";
import type {
  PortfolioExposure,
  TokenExposure,
  ScoredLimitlessMarket,
  HedgeRecommendation,
} from "../utils/types.ts";

const log = createLogger("strategy");

// =============================================
// Strategy configuration per risk tolerance
// =============================================

interface StrategyConfig {
  maxMarketsPerTicker: number;
  minHedgeScore: number;
}

const STRATEGY_CONFIGS: Record<string, StrategyConfig> = {
  conservative: {
    maxMarketsPerTicker: 3,
    minHedgeScore: 20,
  },
  moderate: {
    maxMarketsPerTicker: 2,
    minHedgeScore: 15,
  },
  aggressive: {
    maxMarketsPerTicker: 2,
    minHedgeScore: 10,
  },
};

// Reverse map: Limitless ticker -> CoinGecko ID (for price lookups)
const TICKER_TO_COINGECKO: Record<string, string> = {
  ETH: "ethereum",
  BTC: "wrapped-bitcoin",
  LINK: "chainlink",
  UNI: "uniswap",
  ARB: "arbitrum",
  AAVE: "aave",
};

// =============================================
// Core strategy function
// =============================================

/**
 * Build hedge recommendations by matching portfolio exposure to scored markets.
 *
 * 1. Determine which assets need hedging and their proportion
 * 2. Allocate budget proportionally to asset exposure
 * 3. For each asset, select best markets based on risk tolerance
 * 4. Filter by strike price proximity to current price
 * 5. Cap each market allocation at MAX_SINGLE_MARKET_ALLOCATION
 */
export function buildHedgeRecommendations(
  exposure: PortfolioExposure,
  markets: ScoredLimitlessMarket[],
  riskTolerance: string,
  hedgeBudget: number,
  currentPrices: Record<string, number> // coingeckoId -> USD price
): HedgeRecommendation[] {
  if (hedgeBudget < MIN_HEDGE_BUDGET_USD) {
    log.warn(`Hedge budget $${hedgeBudget} below minimum $${MIN_HEDGE_BUDGET_USD}`);
    return [];
  }

  if (markets.length === 0) {
    log.info("No markets available for hedging");
    return [];
  }

  const config = STRATEGY_CONFIGS[riskTolerance] ?? STRATEGY_CONFIGS["moderate"]!;
  const dropTargets = RISK_TOLERANCE_DROP_TARGETS[riskTolerance]
    ?? RISK_TOLERANCE_DROP_TARGETS["moderate"]!;

  // Group markets by ticker
  const marketsByTicker = new Map<string, ScoredLimitlessMarket[]>();
  for (const market of markets) {
    const existing = marketsByTicker.get(market.ticker) ?? [];
    existing.push(market);
    marketsByTicker.set(market.ticker, existing);
  }

  // Determine budget allocation per ticker (proportional to exposure)
  const hedgeableExposures = getHedgeableExposures(exposure);
  const totalHedgeableValue = hedgeableExposures.reduce(
    (sum, e) => sum + e.value_usd,
    0
  );

  if (totalHedgeableValue === 0) {
    log.info("No hedgeable exposure (all stablecoins?)");
    return [];
  }

  const recommendations: HedgeRecommendation[] = [];

  for (const tokenExp of hedgeableExposures) {
    const ticker = SYMBOL_TO_LIMITLESS_TICKER[tokenExp.symbol];
    if (!ticker) continue;

    const tickerMarkets = marketsByTicker.get(ticker);
    if (!tickerMarkets || tickerMarkets.length === 0) continue;

    // Budget for this ticker, proportional to portfolio weight
    const exposurePct = tokenExp.value_usd / totalHedgeableValue;
    const tickerBudget = hedgeBudget * exposurePct;

    if (tickerBudget < 0.10) continue;

    // Select best markets
    const selectedMarkets = selectMarketsForTicker(
      tickerMarkets,
      config,
      dropTargets,
      currentPrices,
      ticker
    );

    if (selectedMarkets.length === 0) continue;

    // Allocate budget across selected markets
    const marketRecs = allocateBudget(
      selectedMarkets,
      tickerBudget,
      tokenExp.value_usd
    );

    recommendations.push(...marketRecs);
  }

  recommendations.sort((a, b) => b.estimated_cost_usd - a.estimated_cost_usd);

  log.info(`Built ${recommendations.length} hedge recommendations`, {
    totalCost: recommendations.reduce((s, r) => s + r.estimated_cost_usd, 0),
    totalCoverage: recommendations.reduce((s, r) => s + r.coverage_usd, 0),
  });

  return recommendations;
}

// =============================================
// Helpers
// =============================================

function getHedgeableExposures(exposure: PortfolioExposure): TokenExposure[] {
  return exposure.tokens.filter(
    (t) => !STABLECOIN_SYMBOLS.has(t.symbol) && t.percentage >= 5
  );
}

/**
 * Select best markets for a given ticker based on strategy config.
 *
 * Hedge logic for LONG holders:
 * - "ETH above $X" market: BUY NO → profits if ETH drops below X.
 *   Best when strike is slightly below current price (e.g. ETH at $2000, strike at $1900).
 *   The NO share is cheap when market expects ETH to stay above X.
 *
 * - "ETH below $X" market: BUY YES → profits if ETH drops below X.
 *   Best when strike is slightly below current price.
 *   The YES share is cheap when drop is considered unlikely.
 *
 * For both directions, we want strikes that represent a realistic downside scenario.
 */
function selectMarketsForTicker(
  markets: ScoredLimitlessMarket[],
  config: StrategyConfig,
  dropTargets: number[],
  currentPrices: Record<string, number>,
  ticker: string
): ScoredLimitlessMarket[] {
  const coingeckoId = TICKER_TO_COINGECKO[ticker] ?? "";
  const currentPrice = currentPrices[coingeckoId] ?? 0;

  let candidates = markets.filter((m) => m.hedgeScore >= config.minHedgeScore);

  // Filter by strike proximity if we have price data
  if (currentPrice > 0 && candidates.some((m) => m.strikePrice !== null)) {
    const minDrop = dropTargets[0] ?? 0.05;
    const maxDrop = dropTargets[1] ?? 0.15;

    // For hedging longs, we want strikes BELOW current price
    // representing plausible downside scenarios
    const minStrike = currentPrice * (1 - maxDrop);
    const maxStrike = currentPrice * (1 - minDrop);

    const strikeFiltered = candidates.filter((m) => {
      if (m.strikePrice === null) return true;
      // Both "above" and "below" markets: the strike should be in the
      // downside range relative to current price
      return m.strikePrice >= minStrike && m.strikePrice <= maxStrike;
    });

    // Only use strike-filtered if it has results
    if (strikeFiltered.length > 0) {
      candidates = strikeFiltered;
    }
  }

  // Prefer markets where the hedge cost is reasonable (< $0.50/share)
  // and payout ratio is at least 1.5x
  candidates.sort((a, b) => {
    const hedgeCostA = a.hedgeAction === "BUY_YES" ? a.yesPriceUsd : a.noPriceUsd;
    const hedgeCostB = b.hedgeAction === "BUY_YES" ? b.yesPriceUsd : b.noPriceUsd;
    // Prefer cheaper hedges (higher payout ratio)
    if (a.payoutRatio !== b.payoutRatio) return b.payoutRatio - a.payoutRatio;
    // Then by hedge score
    return b.hedgeScore - a.hedgeScore;
  });

  return candidates.slice(0, config.maxMarketsPerTicker);
}

/**
 * Allocate budget across selected markets for a single ticker.
 */
function allocateBudget(
  markets: ScoredLimitlessMarket[],
  tickerBudget: number,
  exposureValueUsd: number
): HedgeRecommendation[] {
  const recommendations: HedgeRecommendation[] = [];
  const maxPerMarket = tickerBudget * MAX_SINGLE_MARKET_ALLOCATION;

  const totalScore = markets.reduce((s, m) => s + m.hedgeScore, 0);
  let remainingBudget = tickerBudget;

  for (const market of markets) {
    if (remainingBudget <= 0) break;

    const scorePct =
      totalScore > 0 ? market.hedgeScore / totalScore : 1 / markets.length;
    let allocation = Math.min(tickerBudget * scorePct, maxPerMarket);
    allocation = Math.min(allocation, remainingBudget);

    const hedgePricePerShare =
      market.hedgeAction === "BUY_YES" ? market.yesPriceUsd : market.noPriceUsd;

    if (hedgePricePerShare <= 0) continue;

    // Cap by market liquidity
    const maxByLiquidity = market.maxFillableShares * hedgePricePerShare;
    allocation = Math.min(allocation, maxByLiquidity);

    if (allocation < 0.10) continue;

    // For FOK orders, the exchange fills as many shares as the USDC can buy.
    // Allow fractional shares in recommendations — actual fill is determined by the exchange.
    const shares = allocation / hedgePricePerShare;
    if (shares < 0.1) continue;

    const estimatedCost = Math.round(allocation * 100) / 100;
    const coverageUsd = shares; // Each share pays $1 if outcome triggers
    const coveragePct =
      exposureValueUsd > 0
        ? Math.round((coverageUsd / exposureValueUsd) * 1000) / 10
        : 0;

    recommendations.push({
      market_id: String(market.raw.id ?? market.slug),
      market_question: market.title,
      action: market.hedgeAction,
      shares,
      estimated_cost_usd: Math.round(estimatedCost * 100) / 100,
      coverage_usd: Math.round(coverageUsd * 100) / 100,
      coverage_percentage: coveragePct,
      expiry: market.expirationDate.toISOString(),
    });

    remainingBudget -= estimatedCost;
  }

  return recommendations;
}
