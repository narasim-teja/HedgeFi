import type { AcpJob } from "@virtuals-protocol/acp-node";
import { createLogger } from "../../utils/logger.ts";
import type {
  CloseHedgeRequirement,
  CloseHedgeDeliverable,
} from "../../utils/types.ts";

const log = createLogger("close-hedge");

function parseRequirement(job: AcpJob): CloseHedgeRequirement {
  const raw = job.requirement;
  const fallback: CloseHedgeRequirement = { close_all: true };

  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  if (raw && typeof raw === "object") {
    return raw as CloseHedgeRequirement;
  }

  return fallback;
}

export async function handleCloseHedge(job: AcpJob): Promise<void> {
  log.info(`Processing close_hedge for job #${job.id}`);

  const req = parseRequirement(job);
  log.info("Requirement parsed", req);

  // === MOCK DELIVERABLE — replaced with real Limitless sell in Phase 4 ===
  const deliverable: CloseHedgeDeliverable = {
    positions_closed: [
      {
        market_id: "mock-market-eth-below-2400",
        shares_sold: 200,
        sale_price: 0.15,
        realized_pnl: 6.0,
      },
    ],
    total_returned_usdc: 30.0,
    return_tx_hash: "0xmock_return_tx_hash_001",
  };

  log.info(`Delivering mock close_hedge for job #${job.id}`);
  await job.deliver(JSON.stringify(deliverable));
  log.info(`Job #${job.id} delivered successfully`);
}
