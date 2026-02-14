import { createLogger } from "../utils/logger.ts";
import {
  SYMBOL_TO_LIMITLESS_TICKER,
  MIN_MARKET_LIQUIDITY_USD,
  TIMEFRAME_HOUR_BOUNDS,
} from "../utils/constants.ts";
import {
  fetchActiveMarkets,
  searchMarkets,
  fetchMarketSlugs,
} from "./client.ts";
import type {
  LimitlessMarketRaw,
  LimitlessMarketSlug,
  ScoredLimitlessMarket,
  PortfolioExposure,
  MarketTimeframe,
} from "../utils/types.ts";

const log = createLogger("limitless-markets");

// =============================================
// Title parsing utilities
// =============================================

/**
 * Regex patterns for extracting market metadata from titles.
 * Real examples from Limitless API:
 *   "$ETH above $1969.15 on Feb 13, 06:00 UTC?"
 *   "$BTC above $66274.74 on Feb 13, 06:00 UTC?"
 *   "Will ETH close below $2400 today?"
 */
const PRICE_MARKET_PATTERNS = [
  // "$ETH above $1969.15 on Feb 13" — actual Limitless format
  /\$(\w+)\s+(above|below|under|over)\s+\$?([\d,]+(?:\.\d+)?)/i,
  // "Will ETH close below $2400 today?"
  /will\s+\$?(\w+)\s+(?:close\s+)?(?:be\s+)?(below|above|under|over)\s+\$?([\d,]+(?:\.\d+)?)/i,
  // "ETH below $2,300"
  /\$?(\w+)\s+(below|above|under|over)\s+\$?([\d,]+(?:\.\d+)?)/i,
];

interface ParsedMarketTitle {
  ticker: string;
  direction: "below" | "above";
  strikePrice: number;
}

function parseMarketTitle(title: string): ParsedMarketTitle | null {
  for (const pattern of PRICE_MARKET_PATTERNS) {
    const match = title.match(pattern);
    if (match) {
      const ticker = match[1]!.toUpperCase();
      const dirWord = match[2]!.toLowerCase();
      const direction: "below" | "above" =
        dirWord === "below" || dirWord === "under" ? "below" : "above";
      const strikePrice = parseFloat(match[3]!.replace(/,/g, ""));

      if (!isNaN(strikePrice) && strikePrice > 0) {
        return { ticker, direction, strikePrice };
      }
    }
  }
  return null;
}

// =============================================
// Market enrichment
// =============================================

function enrichMarket(
  raw: LimitlessMarketRaw,
  slugMeta: LimitlessMarketSlug | undefined
): ScoredLimitlessMarket | null {
  // Skip expired or non-funded markets
  if (raw.expired) return null;

  // Try priceOracleMetadata first (most reliable)
  let ticker = raw.priceOracleMetadata?.ticker?.toUpperCase() ?? null;
  let strikePrice: number | null = null;
  let direction: "below" | "above" = "below";

  // Try metadata.openPrice for strike price (most reliable source on real API)
  if (raw.metadata?.openPrice) {
    const parsed = parseFloat(raw.metadata.openPrice);
    if (!isNaN(parsed)) strikePrice = parsed;
  }

  // Try slug metadata for strike price as fallback
  if (strikePrice === null && slugMeta?.strikePrice) {
    const parsed = parseFloat(slugMeta.strikePrice);
    if (!isNaN(parsed)) strikePrice = parsed;
  }
  if (slugMeta?.ticker) {
    ticker = slugMeta.ticker.toUpperCase();
  }

  // Parse title for direction and as fallback for ticker/strike
  const parsed = parseMarketTitle(raw.title);
  if (parsed) {
    if (!ticker) ticker = parsed.ticker;
    if (strikePrice === null) strikePrice = parsed.strikePrice;
    direction = parsed.direction;
  }

  // No ticker = not useful for hedging
  if (!ticker) return null;

  // Determine hedge action for a LONG position:
  // "ETH below $X" → BUY YES hedges longs (profit if ETH drops)
  // "ETH above $X" → BUY NO hedges longs (profit if ETH doesn't go above)
  const hedgeAction: "BUY_YES" | "BUY_NO" =
    direction === "below" ? "BUY_YES" : "BUY_NO";

  // prices is [yesPrice, noPrice] array
  const yesPriceUsd = Array.isArray(raw.prices) ? raw.prices[0] ?? 0.5 : 0.5;
  const noPriceUsd = Array.isArray(raw.prices) ? raw.prices[1] ?? 0.5 : 0.5;

  const hedgeCostPerShare =
    hedgeAction === "BUY_YES" ? yesPriceUsd : noPriceUsd;

  const payoutRatio = hedgeCostPerShare > 0 ? 1 / hedgeCostPerShare : 0;

  // Use volume as liquidity proxy (volumeFormatted is in USD)
  const volumeUsd = raw.volumeFormatted ? parseFloat(raw.volumeFormatted) : 0;
  const liquidityUsd = raw.liquidity ?? volumeUsd;

  if (liquidityUsd < MIN_MARKET_LIQUIDITY_USD) return null;

  // expirationTimestamp is in milliseconds from Limitless API
  const expirationMs = raw.expirationTimestamp;

  const hedgeScore = computeHedgeScore({
    payoutRatio,
    liquidityUsd,
    expirationMs,
    hedgeCostPerShare,
  });

  return {
    raw,
    slug: raw.slug,
    title: raw.title,
    ticker,
    strikePrice,
    direction,
    expirationDate: new Date(expirationMs),
    yesPriceUsd,
    noPriceUsd,
    hedgeAction,
    hedgeScore,
    liquidityUsd,
    maxFillableShares:
      liquidityUsd > 0 && hedgeCostPerShare > 0
        ? Math.floor(liquidityUsd / hedgeCostPerShare)
        : 0,
    payoutRatio,
  };
}

// =============================================
// Scoring logic
// =============================================

interface ScoreInputs {
  payoutRatio: number;
  liquidityUsd: number;
  expirationMs: number; // milliseconds
  hedgeCostPerShare: number;
}

function computeHedgeScore(inputs: ScoreInputs): number {
  let score = 0;

  // Payout ratio score (0-35 points)
  if (inputs.payoutRatio >= 10) score += 35;
  else if (inputs.payoutRatio >= 6) score += 30;
  else if (inputs.payoutRatio >= 4) score += 25;
  else if (inputs.payoutRatio >= 3) score += 20;
  else if (inputs.payoutRatio >= 2) score += 10;
  else score += 5;

  // Liquidity score (0-25 points)
  if (inputs.liquidityUsd >= 1000) score += 25;
  else if (inputs.liquidityUsd >= 500) score += 20;
  else if (inputs.liquidityUsd >= 100) score += 15;
  else if (inputs.liquidityUsd >= 50) score += 10;
  else score += 5;

  // Time to expiry score (0-20 points)
  // expirationMs is already in milliseconds
  const hoursToExpiry = (inputs.expirationMs - Date.now()) / (1000 * 60 * 60);
  if (hoursToExpiry >= 1 && hoursToExpiry <= 24) score += 20;
  else if (hoursToExpiry > 24 && hoursToExpiry <= 72) score += 15;
  else if (hoursToExpiry > 0 && hoursToExpiry < 1) score += 8;
  else score += 5;

  // Cost efficiency score (0-20 points)
  if (inputs.hedgeCostPerShare <= 0.10) score += 20;
  else if (inputs.hedgeCostPerShare <= 0.20) score += 15;
  else if (inputs.hedgeCostPerShare <= 0.35) score += 10;
  else score += 5;

  return Math.min(100, Math.max(0, score));
}

// =============================================
// Timeframe filtering
// =============================================

/**
 * Filter scored markets by timeframe preference.
 * Returns only markets whose hours-to-expiry falls within the specified bucket.
 * "all" returns everything (no filtering).
 */
export function filterByTimeframe(
  markets: ScoredLimitlessMarket[],
  timeframe: MarketTimeframe
): ScoredLimitlessMarket[] {
  if (timeframe === "all") return markets;

  const bounds = TIMEFRAME_HOUR_BOUNDS[timeframe];
  if (!bounds) return markets;

  const now = Date.now();
  return markets.filter((m) => {
    const hoursToExpiry = (m.expirationDate.getTime() - now) / (1000 * 60 * 60);
    return hoursToExpiry > bounds.min && hoursToExpiry <= bounds.max;
  });
}

// =============================================
// Main scanning functions
// =============================================

/**
 * Find markets relevant for hedging the given portfolio exposure.
 * Combines active market browsing with targeted search.
 */
export async function findHedgingMarkets(
  exposure: PortfolioExposure,
  timeframe: MarketTimeframe = "all"
): Promise<ScoredLimitlessMarket[]> {
  const hedgeableTickers = getHedgeableTickers(exposure);

  if (hedgeableTickers.length === 0) {
    log.info("No hedgeable assets found in portfolio (all stablecoins?)");
    return [];
  }

  log.info(`Looking for markets to hedge: ${hedgeableTickers.join(", ")}`);

  const [activeMarkets, slugs] = await Promise.all([
    fetchActiveMarkets(),
    fetchMarketSlugs(),
  ]);

  // Build slug lookup map
  const slugMap = new Map<string, LimitlessMarketSlug>();
  for (const s of slugs) {
    slugMap.set(s.slug, s);
    if (s.markets) {
      for (const nested of s.markets) {
        slugMap.set(nested.slug, s);
      }
    }
  }

  // Enrich and filter markets
  const scored: ScoredLimitlessMarket[] = [];

  for (const raw of activeMarkets) {
    const enriched = enrichMarket(raw, slugMap.get(raw.slug));
    if (!enriched) continue;

    if (hedgeableTickers.includes(enriched.ticker)) {
      scored.push(enriched);
    }
  }

  // Supplement with semantic search if few results per ticker
  for (const ticker of hedgeableTickers) {
    const tickerMarkets = scored.filter((m) => m.ticker === ticker);
    if (tickerMarkets.length < 2) {
      log.info(`Few markets for ${ticker}, trying semantic search`);
      try {
        const searchResults = await searchMarkets(`${ticker} below price`, 5);
        for (const raw of searchResults) {
          if (scored.some((m) => m.slug === raw.slug)) continue;
          const enriched = enrichMarket(raw, slugMap.get(raw.slug));
          if (enriched && enriched.ticker === ticker) {
            scored.push(enriched);
          }
        }
      } catch (err) {
        log.warn(`Semantic search for ${ticker} failed`, err);
      }
    }
  }

  // Apply timeframe filter before sorting
  const filtered = filterByTimeframe(scored, timeframe);

  if (scored.length > 0 && filtered.length === 0) {
    log.info(`All ${scored.length} markets filtered out by timeframe "${timeframe}"`);
  }

  filtered.sort((a, b) => b.hedgeScore - a.hedgeScore);

  log.info(`Found ${filtered.length} hedging-relevant markets (timeframe: ${timeframe})`, {
    tickers: [...new Set(filtered.map((m) => m.ticker))],
    topScore: filtered[0]?.hedgeScore,
    filteredOut: scored.length - filtered.length,
  });

  return filtered;
}

/**
 * Extract tickers from portfolio that can be hedged on Limitless.
 * Only non-stablecoin tokens with >5% portfolio weight.
 */
function getHedgeableTickers(exposure: PortfolioExposure): string[] {
  const tickers = new Set<string>();

  for (const token of exposure.tokens) {
    if (token.percentage < 5) continue;

    const limitlessTicker = SYMBOL_TO_LIMITLESS_TICKER[token.symbol];
    if (limitlessTicker) {
      tickers.add(limitlessTicker);
    }
  }

  return [...tickers];
}

/**
 * Get markets for a specific asset (for the available_markets resource).
 */
export async function getMarketsForAsset(
  asset: string,
  timeframe: MarketTimeframe = "all"
): Promise<ScoredLimitlessMarket[]> {
  const [activeMarkets, slugs] = await Promise.all([
    fetchActiveMarkets(),
    fetchMarketSlugs(),
  ]);

  const slugMap = new Map<string, LimitlessMarketSlug>();
  for (const s of slugs) {
    slugMap.set(s.slug, s);
  }

  const scored: ScoredLimitlessMarket[] = [];
  const targetTicker = asset.toUpperCase();

  for (const raw of activeMarkets) {
    const enriched = enrichMarket(raw, slugMap.get(raw.slug));
    if (!enriched) continue;

    if (targetTicker === "ALL" || enriched.ticker === targetTicker) {
      scored.push(enriched);
    }
  }

  const timeframeFiltered = filterByTimeframe(scored, timeframe);
  timeframeFiltered.sort((a, b) => b.hedgeScore - a.hedgeScore);
  return timeframeFiltered;
}
