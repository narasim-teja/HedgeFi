import { createLogger } from "../utils/logger.ts";
import {
  getActivePositions,
  getAllActivePositions,
  getHistoricalPositions,
  getPositionsForMarket,
} from "../db/positions.ts";
import { getMarketsForAsset } from "../limitless/markets.ts";
import { fetchMarketBySlug } from "../limitless/client.ts";
import type { DbPosition, ScoredLimitlessMarket, MarketTimeframe } from "../utils/types.ts";

const log = createLogger("resource-server");

const RESOURCE_PORT = Number(process.env.RESOURCE_PORT ?? 3001);
const CORS_ORIGIN = process.env.CORS_ALLOWED_ORIGIN ?? "*";

// =============================================
// Response helpers
// =============================================

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": CORS_ORIGIN,
    },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

// =============================================
// ACP Resource: get_active_pm_positions
// =============================================

function formatActivePosition(pos: DbPosition) {
  const potentialPayout = pos.shares; // Each share pays $1 if outcome triggers
  return {
    positionId: pos.id,
    marketId: pos.market_slug,
    question: pos.market_title,
    outcome: pos.side, // "YES" or "NO"
    usdStake: pos.total_cost_usdc,
    entryPrice: pos.entry_price,
    takeProfitPrice: null,
    stopLossPrice: null,
    usdPotentialPayout: potentialPayout,
    usdFeePaid: 0,
    isLiveOddsEnabled: false,
    openedAt: pos.created_at.endsWith("Z") ? pos.created_at : `${pos.created_at}Z`,
    resolveBy: pos.expiry.endsWith("Z") ? pos.expiry : `${pos.expiry}Z`,
  };
}

function handleActivePositions(url: URL): Response {
  const clientAddress = url.searchParams.get("clientAddress");
  if (!clientAddress) {
    return errorResponse("Missing required query parameter: clientAddress");
  }

  const positions = getActivePositions(clientAddress);

  return jsonResponse({
    clientAddress,
    positions: positions.map(formatActivePosition),
    lastUpdatedAt: new Date().toISOString(),
  });
}

// =============================================
// ACP Resource: get_historical_pm_positions
// =============================================

function formatHistoricalPosition(pos: DbPosition) {
  const pnl = pos.realized_pnl ?? 0;
  const payout = pos.total_cost_usdc + pnl;
  const won = pnl > 0;

  // Derive result status from position status
  let resultStatus: string;
  switch (pos.status) {
    case "closed":
      resultStatus = pnl >= 0 ? "profit" : "loss";
      break;
    case "won":
      resultStatus = "won";
      break;
    case "lost":
      resultStatus = "lost";
      break;
    case "expired":
      resultStatus = "expired";
      break;
    default:
      resultStatus = pos.status;
  }

  return {
    positionId: pos.id,
    marketId: pos.market_slug,
    question: pos.market_title,
    outcome: pos.side,
    usdStake: pos.total_cost_usdc,
    entryPrice: pos.entry_price,
    usdFeePaid: 0,
    finalOutcome: won ? pos.side : (pos.side === "YES" ? "NO" : "YES"),
    usdPayout: Math.round(Math.max(0, payout) * 100) / 100,
    takeProfitPrice: null,
    stopLossPrice: null,
    isLiveOddsEnabled: false,
    resolvedAt: pos.closed_at
      ? (pos.closed_at.endsWith("Z") ? pos.closed_at : `${pos.closed_at}Z`)
      : new Date().toISOString(),
    resultStatus,
  };
}

function handleHistoricalPositions(url: URL): Response {
  const clientAddress = url.searchParams.get("clientAddress");
  if (!clientAddress) {
    return errorResponse("Missing required query parameter: clientAddress");
  }

  const positions = getHistoricalPositions(clientAddress);

  return jsonResponse({
    clientAddress,
    positions: positions.map(formatHistoricalPosition),
  });
}

// =============================================
// ACP Resource: get_prediction_market
// =============================================

async function handleGetMarket(url: URL): Promise<Response> {
  const marketId = url.searchParams.get("marketId");
  if (!marketId) {
    return errorResponse("Missing required query parameter: marketId");
  }

  try {
    const market = await fetchMarketBySlug(marketId);

    const isExpired = market.expired || (market.expirationTimestamp < Date.now());

    if (isExpired) {
      return jsonResponse({
        marketId: market.slug,
        isOpen: false,
        reasonCode: "expired",
        lastCheckedAt: new Date().toISOString(),
      });
    }

    const yesPriceUsd = Array.isArray(market.prices) ? market.prices[0] ?? 0.5 : 0.5;
    const noPriceUsd = Array.isArray(market.prices) ? market.prices[1] ?? 0.5 : 0.5;

    return jsonResponse({
      marketId: market.slug,
      isOpen: true,
      closesAt: new Date(market.expirationTimestamp).toISOString(),
      question: market.title,
      outcomes: [
        { outcome: "YES", odds: yesPriceUsd },
        { outcome: "NO", odds: noPriceUsd },
      ],
      lastCheckedAt: new Date().toISOString(),
    });
  } catch (err) {
    log.error(`Failed to fetch market ${marketId}`, err);
    return errorResponse(`Market not found: ${marketId}`, 404);
  }
}

// =============================================
// Bonus: available_markets (browsable markets)
// =============================================

function formatMarketForResource(m: ScoredLimitlessMarket) {
  return {
    marketId: m.slug,
    question: m.title,
    outcomes: ["YES", "NO"],
    currentPrices: { yes: m.yesPriceUsd, no: m.noPriceUsd },
    liquidity: m.liquidityUsd,
    expiry: m.expirationDate.toISOString(),
    hedgingUtility: m.hedgeScore >= 60
      ? "high"
      : m.hedgeScore >= 30
        ? "medium"
        : "low",
    hedgeAction: m.hedgeAction,
    ticker: m.ticker,
    strikePrice: m.strikePrice,
  };
}

async function handleAvailableMarkets(url: URL): Promise<Response> {
  const asset = url.searchParams.get("asset") ?? "all";
  const timeframeParam = url.searchParams.get("timeframe") ?? "all";

  const validTimeframes = ["hourly", "daily", "weekly", "all"];
  if (!validTimeframes.includes(timeframeParam)) {
    return errorResponse(`Invalid timeframe: "${timeframeParam}". Must be one of: ${validTimeframes.join(", ")}`);
  }
  const timeframe = timeframeParam as MarketTimeframe;

  try {
    const markets = await getMarketsForAsset(asset, timeframe);
    return jsonResponse({
      asset,
      timeframe,
      markets: markets.map(formatMarketForResource),
      lastUpdatedAt: new Date().toISOString(),
    });
  } catch (err) {
    log.error("Failed to fetch available markets", err);
    return errorResponse("Failed to fetch markets", 500);
  }
}

// =============================================
// Server
// =============================================

export function startResourceServer(): void {
  const server = Bun.serve({
    port: RESOURCE_PORT,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": CORS_ORIGIN,
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }

      if (req.method !== "GET") {
        return errorResponse("Method not allowed", 405);
      }

      switch (path) {
        case "/resources/active-positions":
          return handleActivePositions(url);

        case "/resources/historical-positions":
          return handleHistoricalPositions(url);

        case "/resources/market":
          return handleGetMarket(url);

        case "/resources/available-markets":
          return handleAvailableMarkets(url);

        case "/health":
          return jsonResponse({ status: "ok", timestamp: new Date().toISOString() });

        case "/status": {
          let activeCount = 0;
          try {
            activeCount = getAllActivePositions().length;
          } catch { /* fallback to 0 */ }
          return jsonResponse({
            agent: "HedgeFi",
            version: "1.0.0-hackathon",
            status: "operational",
            model: "insurance",
            services: { acp: "connected", limitless: "ready", database: "ok" },
            activePositions: activeCount,
            timestamp: new Date().toISOString(),
          });
        }

        default:
          return errorResponse("Not found", 404);
      }
    },
  });

  log.info(`Resource server listening on port ${server.port}`);
  log.info("Available endpoints:");
  log.info("  GET /resources/active-positions?clientAddress=0x...");
  log.info("  GET /resources/historical-positions?clientAddress=0x...");
  log.info("  GET /resources/market?marketId=<slug>");
  log.info("  GET /resources/available-markets?asset=ETH|BTC|all&timeframe=hourly|daily|weekly|all");
  log.info("  GET /health");
}
