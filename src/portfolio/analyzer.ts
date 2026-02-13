import { createLogger } from "../utils/logger.ts";
import { STABLECOIN_SYMBOLS } from "../utils/constants.ts";
import type { PortfolioExposure, TokenExposure } from "../utils/types.ts";
import type { RawTokenBalance } from "./reader.ts";

const log = createLogger("analyzer");

export function analyzeExposure(
  rawBalances: RawTokenBalance[],
  prices: Record<string, number>
): PortfolioExposure {
  // Calculate USD value for each token
  const tokenExposures: TokenExposure[] = [];
  let totalValueUsd = 0;

  for (const token of rawBalances) {
    const price = prices[token.coingeckoId] ?? 0;
    const valueUsd = parseFloat(token.formatted) * price;

    if (valueUsd < 0.01) continue; // skip dust

    totalValueUsd += valueUsd;
    tokenExposures.push({
      symbol: token.symbol,
      balance: token.formatted,
      value_usd: Math.round(valueUsd * 100) / 100,
      percentage: 0, // calculated below
    });
  }

  // Calculate percentages
  for (const exposure of tokenExposures) {
    exposure.percentage =
      totalValueUsd > 0
        ? Math.round((exposure.value_usd / totalValueUsd) * 1000) / 10
        : 0;
  }

  // Sort by value descending
  tokenExposures.sort((a, b) => b.value_usd - a.value_usd);

  // Concentration risk based on largest non-stablecoin position
  let maxNonStablePercentage = 0;
  let topNonStableSymbol = "";

  for (const exposure of tokenExposures) {
    if (!STABLECOIN_SYMBOLS.has(exposure.symbol)) {
      if (exposure.percentage > maxNonStablePercentage) {
        maxNonStablePercentage = exposure.percentage;
        topNonStableSymbol = exposure.symbol;
      }
    }
  }

  let concentrationRisk: "high" | "medium" | "low";
  if (maxNonStablePercentage > 50) {
    concentrationRisk = "high";
  } else if (maxNonStablePercentage > 30) {
    concentrationRisk = "medium";
  } else {
    concentrationRisk = "low";
  }

  const topExposure =
    topNonStableSymbol && maxNonStablePercentage > 0
      ? `${maxNonStablePercentage}% in ${topNonStableSymbol}`
      : tokenExposures.length > 0
        ? `${tokenExposures[0]!.percentage}% in ${tokenExposures[0]!.symbol}`
        : "No holdings detected";

  const result: PortfolioExposure = {
    total_value_usd: Math.round(totalValueUsd * 100) / 100,
    tokens: tokenExposures,
    concentration_risk: concentrationRisk,
    top_exposure: topExposure,
  };

  log.info("Exposure analysis complete", {
    totalValueUsd: result.total_value_usd,
    tokenCount: result.tokens.length,
    concentrationRisk: result.concentration_risk,
    topExposure: result.top_exposure,
  });

  return result;
}
