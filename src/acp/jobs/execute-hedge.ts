import type { AcpJob } from "@virtuals-protocol/acp-node";
import { createLogger } from "../../utils/logger.ts";
import type {
  ExecuteHedgeRequirement,
  ExecuteHedgeDeliverable,
} from "../../utils/types.ts";
import { readWalletBalances } from "../../portfolio/reader.ts";
import { getTokenPrices } from "../../portfolio/pricer.ts";
import { analyzeExposure } from "../../portfolio/analyzer.ts";
import { generateReasoning } from "../../hedging/reasoning.ts";

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
    const reasoning = await generateReasoning(exposure, req.risk_tolerance);

    // Steps 2-3: Hedge execution — mock until Phase 4 (Limitless integration)
    const deliverable: ExecuteHedgeDeliverable = {
      exposure,
      hedges_placed: [
        {
          market_id: "mock-market-eth-below-2400",
          market_question: "Will ETH close below $2,400 today?",
          action: "BUY_YES",
          shares_bought: 200,
          price_per_share: 0.12,
          total_cost_usd: 24.0,
          max_payout_usd: 200.0,
          order_id: "mock-order-001",
          tx_hash: "0xmock_tx_hash_001",
          expiry: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
      summary: {
        total_spent: 24.0,
        total_max_coverage: 200.0,
        budget_remaining: req.hedge_budget_usdc - 24.0,
        coverage_ratio: `[MOCK] Protecting ~5.3% of your $${exposure.total_value_usd} exposure for 24h`,
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
