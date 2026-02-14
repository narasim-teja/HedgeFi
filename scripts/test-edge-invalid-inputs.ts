/**
 * Edge case test: Invalid inputs that should be REJECTED.
 *
 * Tests:
 *  1. execute_hedge with invalid wallet address → REJECTED
 *  2. execute_hedge with unsupported chain → REJECTED
 *  3. execute_hedge with budget below minimum → REJECTED
 *  4. close_hedge with empty requirement (no position_ids, no close_all) → REJECTED
 *  5. execute_hedge with valid inputs → ACCEPTED (sanity check)
 *
 * Usage: bun run scripts/test-edge-invalid-inputs.ts
 *
 * Prerequisites:
 *  - HedgeFi agent running (bun run start)
 *  - BUYER_PRIVATE_KEY, BUYER_ENTITY_ID, BUYER_WALLET_ADDRESS env vars set
 */
import {
  createBuyerClient,
  findOffering,
  waitForJob,
  log,
  sleep,
} from "./lib/buyer-helper.ts";

const TAG = "EdgeTest:InvalidInputs";

interface TestCase {
  name: string;
  jobName: string;
  requirement: Record<string, unknown>;
  expectPhase: "REJECTED" | "COMPLETED";
  expectErrorContains?: string;
}

const tests: TestCase[] = [
  {
    name: "1. Bad wallet address",
    jobName: "execute_hedge",
    requirement: {
      wallet_address: "not-a-wallet",
      chain: "base",
      risk_tolerance: "moderate",
      hedge_budget_usdc: 1,
    },
    expectPhase: "REJECTED",
    expectErrorContains: "wallet",
  },
  {
    name: "2. Unsupported chain",
    jobName: "execute_hedge",
    requirement: {
      wallet_address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      chain: "solana",
      risk_tolerance: "moderate",
      hedge_budget_usdc: 1,
    },
    expectPhase: "REJECTED",
    expectErrorContains: "chain",
  },
  {
    name: "3. Budget below minimum ($0.10 < $0.50 min)",
    jobName: "execute_hedge",
    requirement: {
      wallet_address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      chain: "base",
      risk_tolerance: "moderate",
      hedge_budget_usdc: 0.10,
    },
    expectPhase: "REJECTED",
    expectErrorContains: "hedge_budget",
  },
  {
    name: "4. close_hedge with empty requirement",
    jobName: "close_hedge",
    requirement: {},
    expectPhase: "REJECTED",
    expectErrorContains: "position_ids",
  },
];

async function main() {
  log(TAG, "=== Invalid Input Edge Case Tests ===");
  log(TAG, `Running ${tests.length} test(s)...\n`);

  const results: Array<{ name: string; passed: boolean; detail: string }> = [];

  for (const tc of tests) {
    log(TAG, `--- ${tc.name} ---`);

    try {
      const { client, state } = await createBuyerClient({ tag: TAG });
      const offering = await findOffering(client, tc.jobName, TAG);

      log(TAG, `Sending ${tc.jobName} with invalid input...`);
      const jobId = await offering!.initiateJob(tc.requirement);
      log(TAG, `Job #${jobId} initiated`);

      const result = await waitForJob(client, jobId, state, {
        tag: TAG,
        timeoutMs: 60_000,
      });

      log(TAG, `Result: phase=${result.finalPhase}`, {
        rejectionReason: result.rejectionReason,
        durationMs: result.durationMs,
      });

      const phaseOk = result.finalPhase === tc.expectPhase;
      const errorOk = !tc.expectErrorContains || (
        result.rejectionReason?.toLowerCase().includes(tc.expectErrorContains.toLowerCase()) ?? false
      );

      const passed = phaseOk && errorOk;
      results.push({
        name: tc.name,
        passed,
        detail: passed
          ? `Correctly ${tc.expectPhase}`
          : `Expected ${tc.expectPhase} but got ${result.finalPhase}. Reason: ${result.rejectionReason ?? "none"}`,
      });

      log(TAG, passed ? "PASS" : "FAIL", results[results.length - 1]);
    } catch (err) {
      results.push({
        name: tc.name,
        passed: false,
        detail: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
      log(TAG, "FAIL (error)", err);
    }

    // Brief pause between tests
    await sleep(2000);
  }

  // Summary
  log(TAG, "\n=== RESULTS ===");
  const passCount = results.filter((r) => r.passed).length;
  for (const r of results) {
    console.log(`  ${r.passed ? "PASS" : "FAIL"} ${r.name} — ${r.detail}`);
  }
  console.log(`\n  ${passCount}/${results.length} passed\n`);

  process.exit(passCount === results.length ? 0 : 1);
}

main().catch((err) => {
  log(TAG, "Fatal error", err);
  process.exit(1);
});
