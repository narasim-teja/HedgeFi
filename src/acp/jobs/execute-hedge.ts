import type { AcpJob } from "@virtuals-protocol/acp-node";
import { createLogger } from "../../utils/logger.ts";
import type {
  ExecuteHedgeRequirement,
  ExecuteHedgeDeliverable,
  ScoredLimitlessMarket,
} from "../../utils/types.ts";
import { readWalletBalances } from "../../portfolio/reader.ts";
import { getTokenPrices } from "../../portfolio/pricer.ts";
import { analyzeExposure } from "../../portfolio/analyzer.ts";
import { generateReasoning } from "../../hedging/reasoning.ts";
import { findHedgingMarkets } from "../../limitless/markets.ts";
import { buildHedgeRecommendations } from "../../hedging/strategy.ts";
import { validateAndAdjustSizing, formatCoverageRatio } from "../../hedging/sizing.ts";

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

    // Step 4: Build hedges_placed from recommendations
    // (order_id/tx_hash are placeholders until Phase 4 adds real Limitless order execution)
    const hedges_placed = recommendations.map((rec) => ({
      market_id: rec.market_id,
      market_question: rec.market_question,
      action: rec.action,
      shares_bought: rec.shares,
      price_per_share:
        rec.shares > 0 ? Math.round((rec.estimated_cost_usd / rec.shares) * 10000) / 10000 : 0,
      total_cost_usd: rec.estimated_cost_usd,
      max_payout_usd: rec.coverage_usd,
      order_id: `pending-phase4-${rec.market_id}`,
      tx_hash: `0xpending_phase4_${rec.market_id}`,
      expiry: rec.expiry,
    }));

    const coverageRatio = formatCoverageRatio(
      summary,
      exposure.total_value_usd,
      req.risk_tolerance
    );

    const deliverable: ExecuteHedgeDeliverable = {
      exposure,
      hedges_placed,
      summary: {
        total_spent: summary.total_hedge_cost,
        total_max_coverage: summary.total_coverage,
        budget_remaining: Math.round((req.hedge_budget_usdc - summary.total_hedge_cost) * 100) / 100,
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
