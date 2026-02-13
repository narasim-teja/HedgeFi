import type { AcpJob } from "@virtuals-protocol/acp-node";
import { createLogger } from "../../utils/logger.ts";
import type {
  ExecuteHedgeRequirement,
  ExecuteHedgeDeliverable,
  HedgePlaced,
  ScoredLimitlessMarket,
} from "../../utils/types.ts";
import { LimitlessOrderSide, LimitlessOrderType } from "../../utils/types.ts";
import { readWalletBalances } from "../../portfolio/reader.ts";
import { getTokenPrices } from "../../portfolio/pricer.ts";
import { analyzeExposure } from "../../portfolio/analyzer.ts";
import { generateReasoning } from "../../hedging/reasoning.ts";
import { findHedgingMarkets } from "../../limitless/markets.ts";
import { fetchMarketBySlug } from "../../limitless/client.ts";
import { placeHedgeOrder } from "../../limitless/orders.ts";
import { buildHedgeRecommendations } from "../../hedging/strategy.ts";
import { validateAndAdjustSizing, formatCoverageRatio } from "../../hedging/sizing.ts";
import { createPosition, recordOrder } from "../../db/positions.ts";

const log = createLogger("execute-hedge");

function parseRequirement(job: AcpJob): ExecuteHedgeRequirement {
  const raw = job.requirement;
  const fallback: ExecuteHedgeRequirement = {
    wallet_address: "0x0000000000000000000000000000000000000000",
    chain: "base",
    risk_tolerance: "moderate",
    hedge_budget_usdc: 50,
  };

  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  if (raw && typeof raw === "object") {
    return raw as ExecuteHedgeRequirement;
  }

  return fallback;
}

export async function handleExecuteHedge(job: AcpJob): Promise<void> {
  log.info(`Processing execute_hedge for job #${job.id}`);

  const req = parseRequirement(job);
  log.info("Requirement parsed", req);

  try {
    // Step 1: Read real wallet exposure
    const rawBalances = await readWalletBalances(req.wallet_address, req.chain);
    const coingeckoIds = rawBalances.map((b) => b.coingeckoId);
    const prices = await getTokenPrices(coingeckoIds);
    const exposure = analyzeExposure(rawBalances, prices);

    // Step 2: Scan Limitless markets + build strategy
    let scoredMarkets: ScoredLimitlessMarket[] = [];
    try {
      scoredMarkets = await findHedgingMarkets(exposure);
    } catch (err) {
      log.warn("Failed to fetch Limitless markets", err);
    }

    const rawRecommendations = buildHedgeRecommendations(
      exposure,
      scoredMarkets,
      req.risk_tolerance,
      req.hedge_budget_usdc,
      prices
    );

    const { adjusted: recommendations, summary } = validateAndAdjustSizing(
      rawRecommendations,
      {
        hedgeBudget: req.hedge_budget_usdc,
        riskTolerance: req.risk_tolerance,
        portfolioValueUsd: exposure.total_value_usd,
      }
    );

    // Step 3: Generate reasoning
    const reasoning = await generateReasoning(
      exposure,
      req.risk_tolerance,
      recommendations
    );

    // Step 4: Place REAL orders on Limitless Exchange
    const hedges_placed: HedgePlaced[] = [];
    let totalSpent = 0;

    for (const rec of recommendations) {
      if (totalSpent >= req.hedge_budget_usdc) break;

      try {
        // Find the scored market to get slug, tokens, venue
        const market = scoredMarkets.find(
          (m) => m.slug === String(rec.market_id) || String(m.raw.id) === String(rec.market_id)
        );

        // Get market details — need venue.exchange for EIP-712 signing
        let marketSlug = market?.slug ?? String(rec.market_id);
        let venueExchange = market?.raw.venue?.exchange;
        let tokensYes = market?.raw.tokens.yes;
        let tokensNo = market?.raw.tokens.no;

        if (!venueExchange) {
          log.info(`Fetching full market details for ${marketSlug}`);
          const fullMarket = await fetchMarketBySlug(marketSlug);
          venueExchange = fullMarket.venue?.exchange;
          tokensYes = fullMarket.tokens.yes;
          tokensNo = fullMarket.tokens.no;
        }

        if (!venueExchange) {
          log.warn(`No venue exchange address for market ${marketSlug}, skipping`);
          continue;
        }

        // Determine tokenId based on hedge action
        const tokenId = rec.action === "BUY_YES" ? tokensYes : tokensNo;
        if (!tokenId) {
          log.warn(`No token ID for ${rec.action} on market ${marketSlug}, skipping`);
          continue;
        }

        const remainingBudget = req.hedge_budget_usdc - totalSpent;
        const orderAmount = Math.min(rec.estimated_cost_usd, remainingBudget);

        // Place the order on Limitless
        const result = await placeHedgeOrder({
          marketSlug,
          tokenId,
          side: LimitlessOrderSide.BUY,
          usdcAmount: orderAmount,
          orderType: LimitlessOrderType.FOK,
          venueExchangeAddress: venueExchange,
        });

        // Record in database
        const buyerAddress = (job as any).clientAddress ?? "unknown";
        const positionId = createPosition({
          jobId: String(job.id),
          buyerAddress,
          marketSlug,
          marketTitle: rec.market_question,
          tokenId,
          side: rec.action === "BUY_YES" ? "YES" : "NO",
          action: rec.action,
          shares: result.filledSize,
          entryPrice: result.avgPrice,
          totalCostUsdc: result.totalCost,
          orderId: result.orderId,
          expiry: rec.expiry,
          venueExchange,
        });

        recordOrder({
          positionId,
          orderType: "open",
          marketSlug,
          side: LimitlessOrderSide.BUY,
          makerAmount: String(Math.ceil(orderAmount * 1e6)),
          takerAmount: "1",
          price: result.avgPrice,
          filledSize: result.filledSize,
          orderId: result.orderId,
          status: result.matched ? "filled" : "placed",
        });

        hedges_placed.push({
          market_id: rec.market_id,
          market_question: rec.market_question,
          action: rec.action,
          shares_bought: result.filledSize,
          price_per_share: result.avgPrice,
          total_cost_usd: result.totalCost,
          max_payout_usd: result.filledSize, // Each share pays $1 if outcome triggers
          order_id: result.orderId,
          tx_hash: `limitless:${result.orderId}`,
          expiry: rec.expiry,
        });

        totalSpent += result.totalCost;
        log.info(`Hedge placed for ${marketSlug}`, {
          orderId: result.orderId,
          filledSize: result.filledSize,
          cost: result.totalCost,
        });
      } catch (err) {
        log.error(`Failed to place order for market ${rec.market_id}`, err);
        // Continue to next recommendation — don't fail the entire job
      }
    }

    const coverageRatio = formatCoverageRatio(
      summary,
      exposure.total_value_usd,
      req.risk_tolerance
    );

    const deliverable: ExecuteHedgeDeliverable = {
      exposure,
      hedges_placed,
      summary: {
        total_spent: Math.round(totalSpent * 100) / 100,
        total_max_coverage: hedges_placed.reduce((s, h) => s + h.max_payout_usd, 0),
        budget_remaining: Math.round((req.hedge_budget_usdc - totalSpent) * 100) / 100,
        coverage_ratio: coverageRatio,
      },
      reasoning,
    };

    log.info(`Delivering execute_hedge for job #${job.id}`);
    await job.deliver(JSON.stringify(deliverable));
    log.info(`Job #${job.id} delivered successfully`);
  } catch (err) {
    log.error(`Failed to process execute_hedge for job #${job.id}`, err);
    const errorDeliverable: ExecuteHedgeDeliverable = {
      exposure: {
        total_value_usd: 0,
        tokens: [],
        concentration_risk: "low",
        top_exposure: "Error reading portfolio",
      },
      hedges_placed: [],
      summary: {
        total_spent: 0,
        total_max_coverage: 0,
        budget_remaining: req.hedge_budget_usdc,
        coverage_ratio: "Error: could not analyze portfolio",
      },
      reasoning: `Failed to execute hedge: ${err instanceof Error ? err.message : "Unknown error"}. Please try again.`,
    };
    await job.deliver(JSON.stringify(errorDeliverable));
  }
}
