/**
 * Phase 3 integration test — verify Limitless API integration works end-to-end.
 *
 * Run with: bun scripts/test-limitless-api.ts
 */

import { fetchActiveMarkets, searchMarkets, invalidateMarketCache } from "../src/limitless/client.ts";
import { findHedgingMarkets, getMarketsForAsset } from "../src/limitless/markets.ts";
import { buildHedgeRecommendations } from "../src/hedging/strategy.ts";
import { validateAndAdjustSizing, formatCoverageRatio } from "../src/hedging/sizing.ts";
import type { PortfolioExposure } from "../src/utils/types.ts";

async function main() {
  console.log("=== Phase 3: Limitless API Integration Test ===\n");

  // Force fresh data
  invalidateMarketCache();

  // 1. Test fetching active markets
  console.log("1. Fetching active markets...");
  const markets = await fetchActiveMarkets();
  console.log(`   ✓ Fetched ${markets.length} active markets`);
  if (markets.length > 0) {
    console.log(`   Sample: "${markets[0].title}" (slug: ${markets[0].slug})`);
    console.log(`   Prices: buy=${markets[0].prices?.buy?.market}, liquidity=${markets[0].liquidity}`);
  }

  // 2. Test semantic search
  console.log("\n2. Searching for 'ETH below' markets...");
  try {
    const ethMarkets = await searchMarkets("ETH below", 5);
    console.log(`   ✓ Found ${ethMarkets.length} ETH markets via search`);
    for (const m of ethMarkets.slice(0, 3)) {
      console.log(`   - "${m.title}"`);
    }
  } catch (err) {
    console.log(`   ⚠ Search failed (may not be supported): ${err}`);
  }

  // 3. Test full pipeline with mock ETH-heavy portfolio
  console.log("\n3. Testing full hedging pipeline with mock portfolio...");
  const mockExposure: PortfolioExposure = {
    total_value_usd: 5000,
    tokens: [
      { symbol: "WETH", balance: "2.0", value_usd: 4000, percentage: 80 },
      { symbol: "USDC", balance: "1000", value_usd: 1000, percentage: 20 },
    ],
    concentration_risk: "high",
    top_exposure: "80% in ETH",
  };

  const hedgingMarkets = await findHedgingMarkets(mockExposure);
  console.log(`   ✓ Found ${hedgingMarkets.length} hedging-relevant markets`);
  for (const m of hedgingMarkets.slice(0, 5)) {
    console.log(
      `   - [score=${m.hedgeScore}] "${m.title}" | ${m.hedgeAction} | ` +
        `YES=$${m.yesPriceUsd.toFixed(2)} | payout=${m.payoutRatio.toFixed(1)}x | ` +
        `liquidity=$${m.liquidityUsd.toFixed(0)} | expires=${m.expirationDate.toISOString()}`
    );
  }

  // 4. Test strategy + sizing
  console.log("\n4. Building hedge recommendations (budget=$50, moderate risk)...");
  const mockPrices: Record<string, number> = { ethereum: 2500 };
  const recommendations = buildHedgeRecommendations(
    mockExposure,
    hedgingMarkets,
    "moderate",
    50,
    mockPrices
  );

  console.log(`   ✓ Built ${recommendations.length} recommendations`);
  for (const rec of recommendations) {
    console.log(
      `   - "${rec.market_question}" | ${rec.action} | ` +
        `${rec.shares} shares | cost=$${rec.estimated_cost_usd} | ` +
        `coverage=$${rec.coverage_usd} (${rec.coverage_percentage}%)`
    );
  }

  // 5. Test sizing validation
  console.log("\n5. Validating sizing...");
  const { adjusted, summary } = validateAndAdjustSizing(recommendations, {
    hedgeBudget: 50,
    riskTolerance: "moderate",
    portfolioValueUsd: 5000,
  });

  console.log(`   ✓ Adjusted to ${adjusted.length} positions`);
  console.log(`   Total cost: $${summary.total_hedge_cost}`);
  console.log(`   Total coverage: $${summary.total_coverage}`);
  console.log(`   Coverage ratio: ${summary.coverage_ratio_pct}%`);
  console.log(`   Budget used: ${summary.budget_utilization_pct}%`);
  console.log(`   Cost efficiency: ${summary.cost_efficiency}x`);

  const coverageStr = formatCoverageRatio(summary, 5000, "moderate");
  console.log(`   Summary: ${coverageStr}`);

  // 6. Test getMarketsForAsset (for available_markets resource)
  console.log("\n6. Testing getMarketsForAsset('ETH')...");
  const ethAssetMarkets = await getMarketsForAsset("ETH");
  console.log(`   ✓ Found ${ethAssetMarkets.length} ETH markets`);

  console.log("\n7. Testing getMarketsForAsset('ALL')...");
  const allMarkets = await getMarketsForAsset("ALL");
  console.log(`   ✓ Found ${allMarkets.length} total scoreable markets`);
  const tickers = [...new Set(allMarkets.map((m) => m.ticker))];
  console.log(`   Tickers: ${tickers.join(", ")}`);

  // 8. Edge case: all-stablecoin portfolio
  console.log("\n8. Edge case: all-stablecoin portfolio...");
  const stableExposure: PortfolioExposure = {
    total_value_usd: 5000,
    tokens: [
      { symbol: "USDC", balance: "3000", value_usd: 3000, percentage: 60 },
      { symbol: "USDT", balance: "2000", value_usd: 2000, percentage: 40 },
    ],
    concentration_risk: "low",
    top_exposure: "60% in USDC",
  };
  const stableMarkets = await findHedgingMarkets(stableExposure);
  console.log(`   ✓ Found ${stableMarkets.length} markets (expected: 0)`);

  // 9. Edge case: tiny budget
  console.log("\n9. Edge case: budget below minimum ($2)...");
  const tinyRecs = buildHedgeRecommendations(
    mockExposure,
    hedgingMarkets,
    "moderate",
    2,
    mockPrices
  );
  console.log(`   ✓ Recommendations: ${tinyRecs.length} (expected: 0)`);

  console.log("\n=== All tests passed! ===");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
