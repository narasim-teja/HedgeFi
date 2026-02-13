import type { AcpJob } from "@virtuals-protocol/acp-node";
import { createLogger } from "../../utils/logger.ts";
import type {
  HedgeAnalysisRequirement,
  HedgeAnalysisDeliverable,
  ScoredLimitlessMarket,
} from "../../utils/types.ts";
import { readWalletBalances } from "../../portfolio/reader.ts";
import { getTokenPrices } from "../../portfolio/pricer.ts";
import { analyzeExposure } from "../../portfolio/analyzer.ts";
import { generateReasoning } from "../../hedging/reasoning.ts";
import { findHedgingMarkets } from "../../limitless/markets.ts";
import { buildHedgeRecommendations } from "../../hedging/strategy.ts";
import { validateAndAdjustSizing } from "../../hedging/sizing.ts";

const log = createLogger("hedge-analysis");

function parseRequirement(job: AcpJob): HedgeAnalysisRequirement {
  const raw = job.requirement;
  const fallback: HedgeAnalysisRequirement = {
    wallet_address: "0x0000000000000000000000000000000000000000",
    chain: "base",
    risk_tolerance: "moderate",
    hedge_budget: 50,
  };

  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  if (raw && typeof raw === "object") {
    return raw as HedgeAnalysisRequirement;
  }

  return fallback;
}

export async function handleHedgeAnalysis(job: AcpJob): Promise<void> {
  log.info(`Processing hedge_analysis for job #${job.id}`);

  const req = parseRequirement(job);
  log.info("Requirement parsed", req);

  try {
    // Step 1: Read wallet balances
    const rawBalances = await readWalletBalances(req.wallet_address, req.chain);

    if (rawBalances.length === 0) {
      log.warn(`No token balances found for ${req.wallet_address} on ${req.chain}`);
      const deliverable: HedgeAnalysisDeliverable = {
        exposure: {
          total_value_usd: 0,
          tokens: [],
          concentration_risk: "low",
          top_exposure: "No holdings detected",
        },
        recommended_hedges: [],
        total_hedge_cost: 0,
        total_coverage: 0,
        reasoning: "No significant token holdings were detected in this wallet on the specified chain.",
      };
      await job.deliver(JSON.stringify(deliverable));
      return;
    }

    // Step 2: Fetch prices for all held tokens
    const coingeckoIds = rawBalances.map((b) => b.coingeckoId);
    const prices = await getTokenPrices(coingeckoIds);

    // Step 3: Analyze exposure
    const exposure = analyzeExposure(rawBalances, prices);

    // Step 4: Scan Limitless markets for hedging opportunities
    let scoredMarkets: ScoredLimitlessMarket[] = [];
    try {
      scoredMarkets = await findHedgingMarkets(exposure);
    } catch (err) {
      log.warn("Failed to fetch Limitless markets, continuing without", err);
    }

    // Step 5: Build hedge recommendations
    const rawRecommendations = buildHedgeRecommendations(
      exposure,
      scoredMarkets,
      req.risk_tolerance,
      req.hedge_budget,
      prices
    );

    // Step 6: Validate sizing
    const { adjusted: recommendations, summary } = validateAndAdjustSizing(
      rawRecommendations,
      {
        hedgeBudget: req.hedge_budget,
        riskTolerance: req.risk_tolerance,
        portfolioValueUsd: exposure.total_value_usd,
      }
    );

    // Step 7: Generate AI reasoning (enhanced with market data)
    const reasoning = await generateReasoning(
      exposure,
      req.risk_tolerance,
      recommendations
    );

    // Step 8: Build deliverable
    const deliverable: HedgeAnalysisDeliverable = {
      exposure,
      recommended_hedges: recommendations,
      total_hedge_cost: summary.total_hedge_cost,
      total_coverage: summary.total_coverage,
      reasoning,
    };

    log.info(`Delivering hedge analysis for job #${job.id}`);
    await job.deliver(JSON.stringify(deliverable));
    log.info(`Job #${job.id} delivered successfully`);

    // Notification memo (mandatory for ACP graduation)
    try {
      const notifMsg = [
        `Portfolio Analysis Complete`,
        `Value: $${deliverable.exposure.total_value_usd.toFixed(2)}`,
        `Risk: ${deliverable.exposure.concentration_risk}`,
        `Hedges: ${deliverable.recommended_hedges.length}`,
        `Est. Cost: $${deliverable.total_hedge_cost.toFixed(2)}`,
        `Coverage: $${deliverable.total_coverage.toFixed(2)}`,
      ].join(" | ");
      await job.createNotification(notifMsg);
      log.info(`Job #${job.id}: notification memo sent`);
    } catch (notifErr) {
      log.warn(`Job #${job.id}: failed to send notification memo`, notifErr);
    }
  } catch (err) {
    log.error(`Failed to process hedge_analysis for job #${job.id}`, err);
    const errorDeliverable: HedgeAnalysisDeliverable = {
      exposure: {
        total_value_usd: 0,
        tokens: [],
        concentration_risk: "low",
        top_exposure: "Error reading portfolio",
      },
      recommended_hedges: [],
      total_hedge_cost: 0,
      total_coverage: 0,
      reasoning: `Failed to analyze portfolio: ${err instanceof Error ? err.message : "Unknown error"}. Please try again.`,
    };
    await job.deliver(JSON.stringify(errorDeliverable));

    try {
      await job.createNotification(
        `Hedge Analysis Failed: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    } catch { /* non-fatal */ }
  }
}
