/**
 * Edge case test: close_hedge with position IDs that don't exist.
 *
 * The agent should handle this gracefully — the positions won't resolve
 * and it should either reject or deliver an empty close result.
 *
 * Usage: bun run scripts/test-edge-close-invalid-ids.ts
 */
import {
  createBuyerClient,
  findOffering,
  waitForJob,
  log,
} from "./lib/buyer-helper.ts";

const TAG = "EdgeTest:CloseInvalidIDs";

async function main() {
  log(TAG, "=== Close Hedge With Invalid Position IDs Test ===");
  log(TAG, "Expects: Graceful handling (reject or empty close)\n");

  const { client, state } = await createBuyerClient({ tag: TAG });
  const offering = await findOffering(client, "close_hedge", TAG);

  // These position IDs don't exist in the database
  const requirement = {
    position_ids: [
      "pos_nonexistent_abc123",
      "pos_fake_def456",
      "pos_invalid_ghi789",
    ],
  };

  log(TAG, "Sending close_hedge with fake position IDs...");
  log(TAG, "Requirement:", requirement);

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
    log(TAG, "\nPASS — Agent rejected (invalid position IDs)");
    process.exit(0);
  }

  if (result.finalPhase === "COMPLETED" && result.deliverable) {
    const d = result.deliverable as any;
    log(TAG, "Deliverable:", {
      positions_closed: d.positions_closed?.length ?? 0,
      total_returned_usdc: d.total_returned_usdc ?? 0,
    });

    if ((d.positions_closed?.length ?? 0) === 0) {
      log(TAG, "\nPASS — Agent completed with 0 positions closed (IDs didn't resolve)");
      process.exit(0);
    }
  }

  log(TAG, `\nFAIL — Unexpected result: ${result.finalPhase}`);
  if (result.rejectionReason) log(TAG, `Reason: ${result.rejectionReason}`);
  process.exit(1);
}

main().catch((err) => {
  log(TAG, "Fatal error", err);
  process.exit(1);
});
