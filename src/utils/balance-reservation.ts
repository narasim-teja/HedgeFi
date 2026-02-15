import { createLogger } from "./logger.ts";

const log = createLogger("balance-reservation");

// =============================================
// In-memory balance reservation system
// =============================================
//
// Prevents cross-buyer race conditions on the agent's pre-funded trading wallet.
// The agent trades with its own USDC. Multiple concurrent buyers could overdraw
// the wallet if each independently checks `agentBalance >= budget`.
//
// The reservation ledger tracks funds committed to in-flight jobs. Before a job
// proceeds, it must tryReserve(). The check becomes:
//   availableBalance = agentBalance - totalReserved
//   if (availableBalance >= requestedBudget) → reserve
//
// On completion or failure, releaseReservation() frees the slot.

interface Reservation {
  jobId: string;
  buyerAddress: string;
  amount: number;
  createdAt: number;
}

const reservations = new Map<string, Reservation>();

/** Safety: auto-expire reservations after 15 minutes (crash recovery) */
const RESERVATION_TTL_MS = 15 * 60 * 1000;

function cleanExpired(): void {
  const now = Date.now();
  for (const [jobId, res] of reservations) {
    if (now - res.createdAt > RESERVATION_TTL_MS) {
      log.warn(`Auto-expiring stale reservation for job ${jobId} ($${res.amount})`);
      reservations.delete(jobId);
    }
  }
}

/**
 * Total USDC currently reserved across all in-flight jobs.
 */
export function getTotalReserved(): number {
  cleanExpired();
  let total = 0;
  for (const res of reservations.values()) {
    total += res.amount;
  }
  return total;
}

/**
 * Attempt to reserve funds for a job.
 *
 * @param jobId - Unique job identifier
 * @param buyerAddress - Buyer's wallet address (for logging)
 * @param amount - USDC amount to reserve
 * @param agentBalance - Current on-chain USDC balance of the trading wallet
 * @returns true if reservation succeeded, false if insufficient unreserved balance
 */
export function tryReserve(
  jobId: string,
  buyerAddress: string,
  amount: number,
  agentBalance: number
): boolean {
  cleanExpired();

  // Idempotent: already reserved for this job
  if (reservations.has(jobId)) {
    log.debug(`Job ${jobId} already has a reservation`);
    return true;
  }

  const totalReserved = getTotalReserved();
  const available = agentBalance - totalReserved;

  if (available < amount) {
    log.warn(
      `Reservation failed for job ${jobId}: ` +
      `available=$${available.toFixed(2)}, requested=$${amount}, ` +
      `agentBalance=$${agentBalance.toFixed(2)}, reserved=$${totalReserved.toFixed(2)}`
    );
    return false;
  }

  reservations.set(jobId, {
    jobId,
    buyerAddress,
    amount,
    createdAt: Date.now(),
  });

  log.info(
    `Reserved $${amount} for job ${jobId} ` +
    `(buyer: ${buyerAddress.slice(0, 10)}..., ` +
    `total reserved: $${(totalReserved + amount).toFixed(2)})`
  );
  return true;
}

/**
 * Release a reservation when a job completes, fails, or is refunded.
 */
export function releaseReservation(jobId: string): void {
  const res = reservations.get(jobId);
  if (res) {
    reservations.delete(jobId);
    log.info(`Released reservation for job ${jobId} ($${res.amount})`);
  }
}

/**
 * Get current reservation stats (for /status endpoint and debugging).
 */
export function getReservationStats(): {
  count: number;
  totalReserved: number;
  reservations: Array<{ jobId: string; amount: number; ageMs: number }>;
} {
  cleanExpired();
  const now = Date.now();
  return {
    count: reservations.size,
    totalReserved: getTotalReserved(),
    reservations: Array.from(reservations.values()).map((r) => ({
      jobId: r.jobId,
      amount: r.amount,
      ageMs: now - r.createdAt,
    })),
  };
}
