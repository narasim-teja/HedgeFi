/**
 * Edge case test: Stablecoin-only portfolio should be REJECTED.
 *
 * Sends execute_hedge with a wallet that only holds stablecoins (USDC/USDT).
 * The agent should reject this during REQUEST phase since there's nothing to hedge.
 *
 * Usage: bun run scripts/test-edge-stablecoin-portfolio.ts
 */
import {
  createBuyerClient,
  findOffering,
  waitForJob,
  log,
} from "./lib/buyer-helper.ts";

const TAG = "EdgeTest:StablecoinPortfolio";

async function main() {
  log(TAG, "=== Stablecoin-Only Portfolio Test ===");
  log(TAG, "Expects: REJECTED (nothing to hedge)\n");

  const { client, state } = await createBuyerClient({ tag: TAG });
  const offering = await findOffering(client, "execute_hedge", TAG);

  // Use an address with no non-stablecoin tokens on Base.
  // This tests that the agent rejects when there's nothing hedgeable
  // (either stablecoin-only or empty portfolio → no markets → REJECTED).
  const requirement = {
    wallet_address: "0xDeaD000000000000000000000000000000000001",
    chain: "base",
    risk_tolerance: "moderate",
    hedge_budget_usdc: 1,
  };

  log(TAG, "Sending execute_hedge with stablecoin-only wallet...");
  log(TAG, "Requirement:", requirement);

  const jobId = await offering!.initiateJob(requirement);
  log(TAG, `Job #${jobId} initiated`);

  const result = await waitForJob(client, jobId, state, {
    tag: TAG,
    timeoutMs: 90_000,
  });

  log(TAG, "\n=== RESULT ===");
  log(TAG, `Phase: ${result.finalPhase}`);
  log(TAG, `Rejection reason: ${result.rejectionReason ?? "none"}`);
  log(TAG, `Duration: ${result.durationMs}ms`);

  // This should be rejected in REQUEST phase — the agent calls job.reject()
  // before payment, so it should show as REJECTED.
  // However, if the wallet somehow has non-stablecoin tokens, it may proceed.
  const passed = result.finalPhase === "REJECTED";
  log(TAG, passed ? "\nPASS — Correctly rejected stablecoin-only portfolio" : "\nFAIL — Expected REJECTED");

  if (!passed && result.deliverable) {
    log(TAG, "Deliverable received (unexpected):", result.deliverable);
  }

  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  log(TAG, "Fatal error", err);
  process.exit(1);
});
