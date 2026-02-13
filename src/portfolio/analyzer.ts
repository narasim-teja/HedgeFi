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

export function formatUsd(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function isStablecoinOnly(exposure: PortfolioExposure): boolean {
  if (exposure.tokens.length === 0) return false;
  return exposure.tokens.every((t) => STABLECOIN_SYMBOLS.has(t.symbol));
}

export function getExposureDescription(exposure: PortfolioExposure): string {
  if (exposure.tokens.length === 0) {
    return "No token holdings detected.";
  }

  if (isStablecoinOnly(exposure)) {
    return `Portfolio is 100% stablecoins ($${formatUsd(exposure.total_value_usd)}). No directional risk.`;
  }

  const nonStable = exposure.tokens.filter((t) => !STABLECOIN_SYMBOLS.has(t.symbol));
  const stableTotal = exposure.tokens
    .filter((t) => STABLECOIN_SYMBOLS.has(t.symbol))
    .reduce((s, t) => s + t.value_usd, 0);

  const parts: string[] = [];
  parts.push(`$${formatUsd(exposure.total_value_usd)} portfolio across ${exposure.tokens.length} tokens.`);

  if (nonStable.length > 0 && nonStable[0]) {
    parts.push(`Largest volatile position: ${nonStable[0].symbol} at ${nonStable[0].percentage}% ($${formatUsd(nonStable[0].value_usd)}).`);
  }
  if (stableTotal > 0) {
    const stablePct = Math.round((stableTotal / exposure.total_value_usd) * 100);
    parts.push(`${stablePct}% in stablecoins.`);
  }
  parts.push(`Concentration risk: ${exposure.concentration_risk}.`);

  return parts.join(" ");
}
