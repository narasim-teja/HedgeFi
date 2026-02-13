import type { AcpJob } from "@virtuals-protocol/acp-node";
import { createLogger } from "../../utils/logger.ts";
import { STABLECOIN_SYMBOLS } from "../../utils/constants.ts";
import type {
  HedgeAnalysisRequirement,
  HedgeAnalysisDeliverable,
  ScoredLimitlessMarket,
} from "../../utils/types.ts";
import { readWalletBalances } from "../../portfolio/reader.ts";
import { getTokenPrices } from "../../portfolio/pricer.ts";
import { analyzeExposure, isStablecoinOnly, formatUsd } from "../../portfolio/analyzer.ts";
import { generateScenarioReasoning, generateEdgeCaseMessage } from "../../hedging/reasoning.ts";
import { findHedgingMarkets } from "../../limitless/markets.ts";
import { buildHedgeRecommendations, formatDiagnosticMessage } from "../../hedging/strategy.ts";
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

function formatAnalysisNotification(d: HedgeAnalysisDeliverable): string {
  if (d.recommended_hedges.length === 0) {
    return `Portfolio Analysis: $${formatUsd(d.exposure.total_value_usd)} | ` +
      `Risk: ${d.exposure.concentration_risk} | No hedges recommended`;
  }
  return [
    `Portfolio: $${formatUsd(d.exposure.total_value_usd)}`,
    `Risk: ${d.exposure.concentration_risk}`,
    `${d.recommended_hedges.length} hedge(s) recommended`,
    `Est. Cost: $${formatUsd(d.total_hedge_cost)}`,
    `Coverage: $${formatUsd(d.total_coverage)}`,
  ].join(" | ");
}

export async function handleHedgeAnalysis(job: AcpJob): Promise<void> {
  log.info(`Processing hedge_analysis for job #${job.id}`);

  const req = parseRequirement(job);
  log.info("Requirement parsed", req);

  try {
    // Step 1: Read wallet balances
    const tWallet = log.time("Read wallet balances");
    const rawBalances = await readWalletBalances(req.wallet_address, req.chain);
    tWallet.end();

    if (rawBalances.length === 0) {
      log.warn(`No token balances found for ${req.wallet_address} on ${req.chain}`);
      const reasoning = generateEdgeCaseMessage("no_holdings", { chain: req.chain });
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
        reasoning,
      };
      await job.deliver(JSON.stringify(deliverable));
      try { await job.createNotification(formatAnalysisNotification(deliverable)); } catch { /* non-fatal */ }
      return;
    }

    // Step 2: Fetch prices for all held tokens
    const tPrices = log.time("Fetch token prices");
    const coingeckoIds = rawBalances.map((b) => b.coingeckoId);
    const prices = await getTokenPrices(coingeckoIds);
    tPrices.end();

    // Step 3: Analyze exposure
    const exposure = analyzeExposure(rawBalances, prices);

    // Edge case: stablecoin-only portfolio
    if (isStablecoinOnly(exposure)) {
      log.info("Portfolio is stablecoin-only, no hedging needed");
      const reasoning = generateEdgeCaseMessage("stablecoins_only", {
        totalValue: exposure.total_value_usd,
      });
      const deliverable: HedgeAnalysisDeliverable = {
        exposure,
        recommended_hedges: [],
        total_hedge_cost: 0,
        total_coverage: 0,
        reasoning,
      };
      await job.deliver(JSON.stringify(deliverable));
      try { await job.createNotification(formatAnalysisNotification(deliverable)); } catch { /* non-fatal */ }
      return;
    }

    // Step 4: Scan Limitless markets for hedging opportunities
    const tMarkets = log.time("Limitless market scan");
    let scoredMarkets: ScoredLimitlessMarket[] = [];
    try {
      scoredMarkets = await findHedgingMarkets(exposure);
    } catch (err) {
      log.warn("Failed to fetch Limitless markets, continuing without", err);
    }
    tMarkets.end();

    // Edge case: no markets found
    if (scoredMarkets.length === 0) {
      const topNonStable = exposure.tokens.find((t) => !STABLECOIN_SYMBOLS.has(t.symbol));
      const reasoning = generateEdgeCaseMessage("no_markets_found", {
        topAsset: topNonStable?.symbol ?? "your holdings",
      });
      const deliverable: HedgeAnalysisDeliverable = {
        exposure,
        recommended_hedges: [],
        total_hedge_cost: 0,
        total_coverage: 0,
        reasoning,
      };
      await job.deliver(JSON.stringify(deliverable));
      try { await job.createNotification(formatAnalysisNotification(deliverable)); } catch { /* non-fatal */ }
      return;
    }

    // Step 5: Build hedge recommendations
    const { recommendations: rawRecommendations, diagnostics } = buildHedgeRecommendations(
      exposure,
      scoredMarkets,
      req.risk_tolerance,
      req.hedge_budget,
      prices
    );

    // Edge case: budget too small
    if (diagnostics.budgetTooSmall) {
      const reasoning = generateEdgeCaseMessage("budget_too_small", {
        budget: req.hedge_budget,
        minRecommended: 10,
      });
      const deliverable: HedgeAnalysisDeliverable = {
        exposure,
        recommended_hedges: [],
        total_hedge_cost: 0,
        total_coverage: 0,
        reasoning,
      };
      await job.deliver(JSON.stringify(deliverable));
      try { await job.createNotification(formatAnalysisNotification(deliverable)); } catch { /* non-fatal */ }
      return;
    }

    // Step 6: Validate sizing
    const { adjusted: recommendations, summary } = validateAndAdjustSizing(
      rawRecommendations,
      {
        hedgeBudget: req.hedge_budget,
        riskTolerance: req.risk_tolerance,
        portfolioValueUsd: exposure.total_value_usd,
      }
    );

    // Step 7: Generate AI reasoning (scenario-specific)
    const tReasoning = log.time("AI reasoning generation");
    let reasoning: string;
    if (recommendations.length > 0) {
      reasoning = await generateScenarioReasoning({
        type: "hedge_recommendation",
        exposure,
        riskTolerance: req.risk_tolerance,
        recommendations,
      });
    } else {
      reasoning = await generateScenarioReasoning({
        type: "exposure_analysis",
        exposure,
        riskTolerance: req.risk_tolerance,
      });
    }
    tReasoning.end();

    // Append diagnostic warnings if any
    const diagMsg = formatDiagnosticMessage(diagnostics);
    if (diagMsg) {
      reasoning += `\n\nNote: ${diagMsg}`;
    }

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

    try {
      await job.createNotification(formatAnalysisNotification(deliverable));
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
