import { createLogger } from "../utils/logger.ts";
import { MIN_HEDGE_BUDGET_USD } from "../utils/constants.ts";
import type { HedgeRecommendation } from "../utils/types.ts";

const log = createLogger("sizing");

export interface SizingParams {
  hedgeBudget: number;
  riskTolerance: string;
  portfolioValueUsd: number;
}

export interface SizingSummary {
  total_hedge_cost: number;
  total_coverage: number;
  coverage_ratio_pct: number;
  budget_utilization_pct: number;
  cost_efficiency: number;
}

/**
 * Validate and adjust recommendations to fit within budget constraints.
 * Ensures:
 * 1. Total cost does not exceed budget
 * 2. Positions are rounded to whole shares
 */
export function validateAndAdjustSizing(
  recommendations: HedgeRecommendation[],
  params: SizingParams
): { adjusted: HedgeRecommendation[]; summary: SizingSummary } {
  if (params.hedgeBudget < MIN_HEDGE_BUDGET_USD) {
    log.warn(`Budget $${params.hedgeBudget} below minimum $${MIN_HEDGE_BUDGET_USD}`);
    return { adjusted: [], summary: emptySummary() };
  }

  let totalCost = 0;
  const adjusted: HedgeRecommendation[] = [];

  for (const rec of recommendations) {
    if (totalCost + rec.estimated_cost_usd > params.hedgeBudget) {
      // Scale down to fit remaining budget
      const remaining = params.hedgeBudget - totalCost;
      if (remaining < 0.50) break;

      const pricePerShare =
        rec.shares > 0 ? rec.estimated_cost_usd / rec.shares : 0;
      if (pricePerShare <= 0) continue;

      const adjustedShares = Math.floor(remaining / pricePerShare);
      if (adjustedShares <= 0) break;

      const adjustedCost = adjustedShares * pricePerShare;
      const adjustedCoverage = adjustedShares;
      const coveragePct =
        params.portfolioValueUsd > 0
          ? Math.round((adjustedCoverage / params.portfolioValueUsd) * 1000) / 10
          : 0;

      adjusted.push({
        ...rec,
        shares: adjustedShares,
        estimated_cost_usd: Math.round(adjustedCost * 100) / 100,
        coverage_usd: Math.round(adjustedCoverage * 100) / 100,
        coverage_percentage: coveragePct,
      });
      totalCost += adjustedCost;
      break;
    }

    adjusted.push(rec);
    totalCost += rec.estimated_cost_usd;
  }

  const totalCoverage = adjusted.reduce((s, r) => s + r.coverage_usd, 0);

  const summary: SizingSummary = {
    total_hedge_cost: Math.round(totalCost * 100) / 100,
    total_coverage: Math.round(totalCoverage * 100) / 100,
    coverage_ratio_pct:
      params.portfolioValueUsd > 0
        ? Math.round((totalCoverage / params.portfolioValueUsd) * 1000) / 10
        : 0,
    budget_utilization_pct:
      params.hedgeBudget > 0
        ? Math.round((totalCost / params.hedgeBudget) * 1000) / 10
        : 0,
    cost_efficiency:
      totalCost > 0 ? Math.round((totalCoverage / totalCost) * 10) / 10 : 0,
  };

  log.info("Sizing summary", summary);
  return { adjusted, summary };
}

function emptySummary(): SizingSummary {
  return {
    total_hedge_cost: 0,
    total_coverage: 0,
    coverage_ratio_pct: 0,
    budget_utilization_pct: 0,
    cost_efficiency: 0,
  };
}

/**
 * Generate a human-readable coverage description.
 */
export function formatCoverageRatio(
  summary: SizingSummary,
  portfolioValueUsd: number,
  riskTolerance: string
): string {
  if (summary.total_hedge_cost === 0) {
    return "No hedges placed.";
  }

  const costStr = `$${summary.total_hedge_cost.toFixed(2)}`;
  const coverageStr = `$${summary.total_coverage.toFixed(0)}`;
  const portfolioStr = `$${portfolioValueUsd.toLocaleString()}`;
  const efficiencyStr = `${summary.cost_efficiency.toFixed(1)}x`;

  return (
    `Protecting ~${summary.coverage_ratio_pct}% of your ${portfolioStr} portfolio ` +
    `for ${costStr} (${efficiencyStr} leverage). ` +
    `Max payout if hedges trigger: ${coverageStr}. ` +
    `Risk tolerance: ${riskTolerance}. ` +
    `Budget used: ${summary.budget_utilization_pct}%.`
  );
}
