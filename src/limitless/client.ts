import { createLogger } from "../utils/logger.ts";
import {
  LIMITLESS_API_BASE_URL,
  MARKET_CACHE_TTL_MS,
} from "../utils/constants.ts";
import type {
  LimitlessMarketRaw,
  LimitlessActiveMarketsResponse,
  LimitlessOrderbook,
  LimitlessMarketSlug,
} from "../utils/types.ts";

const log = createLogger("limitless-client");

// =============================================
// Cache
// =============================================

interface MarketCache {
  markets: LimitlessMarketRaw[];
  slugs: LimitlessMarketSlug[];
  timestamp: number;
}

let cache: MarketCache | null = null;

function isCacheValid(): boolean {
  return cache !== null && Date.now() - cache.timestamp < MARKET_CACHE_TTL_MS;
}

// =============================================
// Core fetch helper with retry
// =============================================

async function limitlessFetch<T>(
  path: string,
  params?: Record<string, string | number>
): Promise<T> {
  const url = new URL(`${LIMITLESS_API_BASE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
  }

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
      });

      if (response.status === 429) {
        const backoffMs = (attempt + 1) * 2000;
        log.warn(`Rate limited by Limitless API, retrying in ${backoffMs}ms`);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      if (!response.ok) {
        throw new Error(
          `Limitless API error: ${response.status} ${response.statusText} for ${path}`
        );
      }

      return (await response.json()) as T;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      log.warn(`Limitless API request failed (attempt ${attempt + 1}), retrying`, err);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  throw new Error(`Limitless API request failed after ${maxRetries + 1} attempts`);
}

// =============================================
// Public API functions
// =============================================

/**
 * Fetch all active CLOB markets with pagination.
 * Caches results for MARKET_CACHE_TTL_MS.
 */
export async function fetchActiveMarkets(
  maxPages: number = 4
): Promise<LimitlessMarketRaw[]> {
  if (isCacheValid()) {
    log.debug("Returning cached active markets");
    return cache!.markets;
  }

  log.info("Fetching active markets from Limitless API");
  const allMarkets: LimitlessMarketRaw[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const response = await limitlessFetch<LimitlessActiveMarketsResponse>(
      "/markets/active",
      { limit: 25, page, sortBy: "high_value", tradeType: "clob" }
    );

    allMarkets.push(...response.data);

    if (response.data.length < 25) break;
  }

  log.info(`Fetched ${allMarkets.length} active markets`);

  const slugs = await fetchMarketSlugs();
  cache = { markets: allMarkets, slugs, timestamp: Date.now() };

  return allMarkets;
}

/**
 * Fetch slug metadata (strike prices, tickers, deadlines).
 */
export async function fetchMarketSlugs(): Promise<LimitlessMarketSlug[]> {
  if (isCacheValid() && cache!.slugs.length > 0) {
    return cache!.slugs;
  }

  log.info("Fetching market slugs from Limitless API");
  const slugs = await limitlessFetch<LimitlessMarketSlug[]>(
    "/markets/active/slugs"
  );
  log.info(`Fetched ${slugs.length} market slugs`);
  return slugs;
}

/**
 * Semantic search for markets matching a query.
 */
export async function searchMarkets(
  query: string,
  limit: number = 10
): Promise<LimitlessMarketRaw[]> {
  log.info(`Searching Limitless markets for: "${query}"`);
  const response = await limitlessFetch<{ markets: LimitlessMarketRaw[]; totalMarketsCount: number }>(
    "/markets/search",
    { query, limit }
  );
  log.info(`Search returned ${response.markets?.length ?? 0} markets`);
  return response.markets ?? [];
}

/**
 * Fetch detailed market data by slug.
 */
export async function fetchMarketBySlug(
  slug: string
): Promise<LimitlessMarketRaw> {
  return limitlessFetch<LimitlessMarketRaw>(`/markets/${slug}`);
}

/**
 * Fetch orderbook for a specific market.
 */
export async function fetchOrderbook(
  slug: string
): Promise<LimitlessOrderbook> {
  return limitlessFetch<LimitlessOrderbook>(`/markets/${slug}/orderbook`);
}

/**
 * Invalidate the cache (useful for testing or forced refresh).
 */
export function invalidateMarketCache(): void {
  cache = null;
  log.debug("Market cache invalidated");
}
