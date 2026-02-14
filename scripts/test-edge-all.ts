/**
 * Master test runner: executes all edge case buyer scripts sequentially.
 *
 * Each test runs as a separate process to avoid state leakage.
 * Results are collected and printed at the end.
 *
 * Usage: bun run scripts/test-edge-all.ts
 *
 * Or run individual tests:
 *   bun run scripts/test-edge-invalid-inputs.ts
 *   bun run scripts/test-edge-stablecoin-portfolio.ts
 *   bun run scripts/test-edge-close-no-positions.ts
 *   bun run scripts/test-edge-close-invalid-ids.ts
 *   bun run scripts/test-edge-concurrent-jobs.ts
 */
import { $ } from "bun";

const TAG = "TestRunner";

const log = (msg: string) => {
  console.log(`[${new Date().toISOString()}] [${TAG}] ${msg}`);
};

interface TestSuite {
  name: string;
  script: string;
  timeoutSec: number;
}

const suites: TestSuite[] = [
  {
    name: "Invalid Inputs (bad wallet, wrong chain, low budget, empty close)",
    script: "scripts/test-edge-invalid-inputs.ts",
    timeoutSec: 120,
  },
  {
    name: "Stablecoin-Only Portfolio (should reject)",
    script: "scripts/test-edge-stablecoin-portfolio.ts",
    timeoutSec: 90,
  },
  {
    name: "Close Hedge — No Positions",
    script: "scripts/test-edge-close-no-positions.ts",
    timeoutSec: 90,
  },
  {
    name: "Close Hedge — Invalid Position IDs",
    script: "scripts/test-edge-close-invalid-ids.ts",
    timeoutSec: 90,
  },
  {
    name: "Concurrent Jobs (Same Buyer — tests per-buyer lock)",
    script: "scripts/test-edge-concurrent-jobs.ts",
    timeoutSec: 300,
  },
];

async function main() {
  log("========================================");
  log("  HedgeFi Edge Case Test Suite");
  log("========================================\n");
  log(`Running ${suites.length} test suite(s)...\n`);

  const results: Array<{ name: string; passed: boolean; durationSec: number; error?: string }> = [];

  // Check env vars first
  if (!process.env.BUYER_PRIVATE_KEY || !process.env.BUYER_ENTITY_ID || !process.env.BUYER_WALLET_ADDRESS) {
    log("ERROR: Missing buyer env vars. Set these before running:");
    log("  BUYER_PRIVATE_KEY, BUYER_ENTITY_ID, BUYER_WALLET_ADDRESS");
    log("  HEDGEFI_WALLET_ADDRESS (for agent discovery)");
    process.exit(1);
  }

  for (let i = 0; i < suites.length; i++) {
    const suite = suites[i]!;
    log(`\n[${ i + 1}/${suites.length}] ${suite.name}`);
    log(`  Running: bun run ${suite.script}`);
    log("  " + "=".repeat(50));

    const start = Date.now();

    try {
      const proc = Bun.spawn(["bun", "run", suite.script], {
        stdout: "inherit",
        stderr: "inherit",
        env: process.env,
      });

      // Wait with timeout
      const exitCode = await Promise.race([
        proc.exited,
        new Promise<number>((_, reject) =>
          setTimeout(() => {
            proc.kill();
            reject(new Error(`Timeout after ${suite.timeoutSec}s`));
          }, suite.timeoutSec * 1000)
        ),
      ]);

      const durationSec = (Date.now() - start) / 1000;
      const passed = exitCode === 0;

      results.push({ name: suite.name, passed, durationSec });
      log(`  Result: ${passed ? "PASS" : "FAIL"} (${durationSec.toFixed(1)}s)`);
    } catch (err) {
      const durationSec = (Date.now() - start) / 1000;
      results.push({
        name: suite.name,
        passed: false,
        durationSec,
        error: err instanceof Error ? err.message : String(err),
      });
      log(`  Result: FAIL — ${results[results.length - 1]!.error} (${durationSec.toFixed(1)}s)`);
    }

    // Pause between suites to let the agent settle
    if (i < suites.length - 1) {
      log("  Waiting 5s before next test...");
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // Final summary
  const passCount = results.filter((r) => r.passed).length;
  const totalSec = results.reduce((s, r) => s + r.durationSec, 0);

  log("\n========================================");
  log("  FINAL RESULTS");
  log("========================================\n");

  for (const r of results) {
    const icon = r.passed ? "PASS" : "FAIL";
    const err = r.error ? ` (${r.error})` : "";
    console.log(`  ${icon}  ${r.name} [${r.durationSec.toFixed(1)}s]${err}`);
  }

  console.log(`\n  ${passCount}/${results.length} suites passed in ${totalSec.toFixed(1)}s\n`);

  process.exit(passCount === results.length ? 0 : 1);
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
