/**
 * Edge case test: close_hedge when buyer has no active positions.
 *
 * The agent should handle this gracefully — either reject or deliver
 * an empty result (0 positions closed, $0 returned).
 *
 * Usage: bun run scripts/test-edge-close-no-positions.ts
 */
import {
  createBuyerClient,
  findOffering,
  waitForJob,
  log,
} from "./lib/buyer-helper.ts";

const TAG = "EdgeTest:CloseNoPositions";

async function main() {
  log(TAG, "=== Close Hedge With No Positions Test ===");
  log(TAG, "Expects: Graceful handling (reject or empty close)\n");

  const { client, state } = await createBuyerClient({ tag: TAG });
  const offering = await findOffering(client, "close_hedge", TAG);

  // close_all: true but buyer likely has no active positions
  const requirement = { close_all: true };

  log(TAG, "Sending close_hedge with close_all: true...");
  const jobId = await offering!.initiateJob(requirement);
  log(TAG, `Job #${jobId} initiated`);

  const result = await waitForJob(client, jobId, state, {
    tag: TAG,
    timeoutMs: 90_000,
  });

  log(TAG, "\n=== RESULT ===");
  log(TAG, `Phase: ${result.finalPhase}`);
  log(TAG, `Duration: ${result.durationMs}ms`);

  if (result.finalPhase === "REJECTED") {
    log(TAG, `Rejection reason: ${result.rejectionReason}`);
    log(TAG, "\nPASS — Agent rejected (no positions to close)");
    process.exit(0);
  }

  if (result.finalPhase === "COMPLETED" && result.deliverable) {
    const d = result.deliverable as any;
    log(TAG, "Deliverable:", {
      positions_closed: d.positions_closed?.length ?? 0,
      total_returned_usdc: d.total_returned_usdc ?? 0,
    });

    // Valid if 0 positions closed
    if (d.positions_closed?.length === 0 || d.positions_closed === undefined) {
      log(TAG, "\nPASS — Agent completed gracefully with 0 positions closed");
      process.exit(0);
    } else {
      log(TAG, "\nINFO — Agent found and closed positions (buyer had active positions)");
      log(TAG, "This is valid if the buyer had positions from a prior test.");
      process.exit(0);
    }
  }

  log(TAG, `\nFAIL — Unexpected phase: ${result.finalPhase}`);
  process.exit(1);
}

main().catch((err) => {
  log(TAG, "Fatal error", err);
  process.exit(1);
});
