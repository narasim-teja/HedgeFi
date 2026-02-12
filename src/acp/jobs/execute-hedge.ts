import type { AcpJob } from "@virtuals-protocol/acp-node";
import { createLogger } from "../../utils/logger.ts";
import type {
  ExecuteHedgeRequirement,
  ExecuteHedgeDeliverable,
} from "../../utils/types.ts";

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

  // === MOCK DELIVERABLE — replaced with real execution in Phase 4 ===
  const deliverable: ExecuteHedgeDeliverable = {
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
      coverage_ratio: `Protecting ~5.3% of your $3,762 ETH exposure for 24h`,
    },
    reasoning:
      `[MOCK] Executed hedge on Limitless Exchange. Bought 200 YES shares ` +
      `on "ETH below $2,400" at $0.12/share. If ETH drops below $2,400, payout is $200. ` +
      `Budget used: $24 of $${req.hedge_budget_usdc}. Risk tolerance: ${req.risk_tolerance}.`,
  };

  log.info(`Delivering mock execute_hedge for job #${job.id}`);
  await job.deliver(JSON.stringify(deliverable));
  log.info(`Job #${job.id} delivered successfully`);
}
