import { createLogger } from "../utils/logger.ts";
import { SYMBOL_TO_COINGECKO } from "../utils/constants.ts";

const log = createLogger("pricer");

// =============================================
// Cache
// =============================================
interface PriceCache {
  prices: Record<string, number>;
  timestamp: number;
}

const CACHE_TTL_MS = 60_000;
let cache: PriceCache | null = null;

// =============================================
// Fallback prices (approximate, for when API is down)
// =============================================
const FALLBACK_PRICES: Record<string, number> = {
  ethereum: 2500,
  "usd-coin": 1.0,
  tether: 1.0,
  dai: 1.0,
  "wrapped-bitcoin": 60000,
  chainlink: 15,
  uniswap: 7,
  arbitrum: 1.2,
  optimism: 2.0,
  aave: 200,
};

// =============================================
// CoinGecko API
// =============================================
const COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3";

export async function getTokenPrices(
  coingeckoIds: string[]
): Promise<Record<string, number>> {
  const uniqueIds = [...new Set(coingeckoIds)];

  // Check cache
  if (cache && Date.now() - cache.timestamp < CACHE_TTL_MS) {
    const allCached = uniqueIds.every((id) => id in cache!.prices);
    if (allCached) {
      log.debug("Returning cached prices");
      return cache.prices;
    }
  }

  const idsParam = uniqueIds.join(",");
  const url = `${COINGECKO_BASE_URL}/simple/price?ids=${idsParam}&vs_currencies=usd`;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  const apiKey = process.env.COINGECKO_API_KEY;
  if (apiKey) {
    headers["x-cg-demo-api-key"] = apiKey;
  }

  try {
    log.info(`Fetching prices for ${uniqueIds.length} tokens from CoinGecko`);
    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as Record<string, { usd: number }>;

    const prices: Record<string, number> = {};
    for (const [id, priceObj] of Object.entries(data)) {
      if (priceObj?.usd !== undefined) {
        prices[id] = priceObj.usd;
      }
    }

    // Fill missing with fallback
    for (const id of uniqueIds) {
      if (!(id in prices)) {
        const fallback = FALLBACK_PRICES[id];
        if (fallback !== undefined) {
          log.warn(`Using fallback price for ${id}: $${fallback}`);
          prices[id] = fallback;
        }
      }
    }

    cache = { prices, timestamp: Date.now() };
    log.info("Prices fetched successfully", prices);
    return prices;
  } catch (err) {
    log.error("CoinGecko API failed, using fallback prices", err);

    const prices: Record<string, number> = {};
    for (const id of uniqueIds) {
      prices[id] = FALLBACK_PRICES[id] ?? 0;
    }
    return prices;
  }
}

export function getSymbolPrice(
  prices: Record<string, number>,
  symbol: string
): number {
  const coingeckoId = SYMBOL_TO_COINGECKO[symbol];
  if (!coingeckoId) return 0;
  return prices[coingeckoId] ?? 0;
}
