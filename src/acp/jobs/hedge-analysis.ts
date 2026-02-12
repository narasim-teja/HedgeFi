import type { AcpJob } from "@virtuals-protocol/acp-node";
import { createLogger } from "../../utils/logger.ts";
import type {
  HedgeAnalysisRequirement,
  HedgeAnalysisDeliverable,
} from "../../utils/types.ts";

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

  // === MOCK DELIVERABLE — replaced with real data in Phase 2+ ===
  const deliverable: HedgeAnalysisDeliverable = {
    exposure: {
      total_value_usd: 5230.42,
      tokens: [
        { symbol: "ETH", balance: "2.15", value_usd: 3762.5, percentage: 71.9 },
        { symbol: "USDC", balance: "1200.00", value_usd: 1200.0, percentage: 22.9 },
        { symbol: "LINK", balance: "18.5", value_usd: 267.92, percentage: 5.1 },
      ],
      concentration_risk: "high",
      top_exposure: "71.9% in ETH",
    },
    recommended_hedges: [
      {
        market_id: "mock-market-eth-below-2400",
        market_question: "Will ETH close below $2,400 today?",
        action: "BUY_YES",
        shares: 200,
        estimated_cost_usd: 24.0,
        coverage_usd: 200.0,
        coverage_percentage: 5.3,
        expiry: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        market_id: "mock-market-eth-below-2200",
        market_question: "Will ETH close below $2,200 today?",
        action: "BUY_YES",
        shares: 150,
        estimated_cost_usd: 9.0,
        coverage_usd: 150.0,
        coverage_percentage: 4.0,
        expiry: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
    ],
    total_hedge_cost: 33.0,
    total_coverage: 350.0,
    reasoning:
      `[MOCK] Your portfolio is heavily concentrated in ETH (71.9%). ` +
      `A 10% ETH price drop would reduce your portfolio value by ~$376. ` +
      `Recommended: YES shares on "ETH below $2,400" and "ETH below $2,200" markets. ` +
      `Total cost: $33 for $350 in downside coverage. Risk tolerance: ${req.risk_tolerance}.`,
  };

  log.info(`Delivering mock hedge analysis for job #${job.id}`);
  await job.deliver(JSON.stringify(deliverable));
  log.info(`Job #${job.id} delivered successfully`);
}
