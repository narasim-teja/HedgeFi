/**
 * Test script: validates the market_timeframe feature by sending execute_hedge
 * jobs with different timeframe preferences and verifying the returned markets
 * match the requested window.
 *
 * The HedgeFi agent must be running (bun run start) before running this.
 *
 * Usage: bun run scripts/test-market-timeframe.ts
 *   Optional: TIMEFRAME=hourly|daily|weekly|all (default: daily)
 */
import AcpClient, {
  AcpContractClientV2,
  type AcpJob,
  type AcpMemo,
  AcpJobPhases,
  AcpGraduationStatus,
  AcpOnlineStatus,
} from "@virtuals-protocol/acp-node";

const TIMEFRAME = process.env.TIMEFRAME ?? "daily";
const VALID_TIMEFRAMES = ["hourly", "daily", "weekly", "all"];

if (!VALID_TIMEFRAMES.includes(TIMEFRAME)) {
  console.error(`Invalid TIMEFRAME="${TIMEFRAME}". Must be one of: ${VALID_TIMEFRAMES.join(", ")}`);
  process.exit(1);
}

// Timeframe boundaries (must match src/utils/constants.ts TIMEFRAME_HOUR_BOUNDS)
const TIMEFRAME_BOUNDS: Record<string, { min: number; max: number }> = {
  hourly: { min: 0, max: 2 },
  daily: { min: 2, max: 26 },
  weekly: { min: 26, max: 168 },
  all: { min: 0, max: Infinity },
};

const log = (msg: string, data?: unknown) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [TimeframeTest] ${msg}`, data !== undefined ? data : "");
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if all hedges in the plan/deliverable fall within the expected timeframe.
 */
function validateTimeframeCompliance(
  items: Array<{ expiry?: string; expiry_human?: string; market_question?: string }>,
  timeframe: string
): { pass: boolean; violations: string[] } {
  if (timeframe === "all") return { pass: true, violations: [] };

  const bounds = TIMEFRAME_BOUNDS[timeframe]!;
  const now = Date.now();
  const violations: string[] = [];

  for (const item of items) {
    if (!item.expiry) continue;
    const expiryMs = new Date(item.expiry).getTime();
    const hoursToExpiry = (expiryMs - now) / (1000 * 60 * 60);

    if (hoursToExpiry <= bounds.min || hoursToExpiry > bounds.max) {
      violations.push(
        `"${item.market_question ?? "unknown"}" expires in ${hoursToExpiry.toFixed(1)}h — outside ${timeframe} window (${bounds.min}-${bounds.max}h)`
      );
    }
  }

  return { pass: violations.length === 0, violations };
}

async function main() {
  const privateKey = process.env.BUYER_PRIVATE_KEY;
  const entityId = process.env.BUYER_ENTITY_ID;
  const walletAddress = process.env.BUYER_WALLET_ADDRESS;

  if (!privateKey || !entityId || !walletAddress) {
    throw new Error(
      "Missing env vars: BUYER_PRIVATE_KEY, BUYER_ENTITY_ID, BUYER_WALLET_ADDRESS"
    );
  }

  log(`Testing market_timeframe="${TIMEFRAME}"`);
  log("========================================");

  const contractClient = await AcpContractClientV2.build(
    privateKey as `0x${string}`,
    Number(entityId),
    walletAddress as `0x${string}`
  );

  let jobCompleted = false;
  let jobRejected = false;
  let rejectionReason = "";
  let requirementCount = 0;
  let evaluationSent = false;
  let planValidation: { pass: boolean; violations: string[] } | null = null;
  let deliverableValidation: { pass: boolean; violations: string[] } | null = null;

  const buyerClient = new AcpClient({
    acpContractClient: contractClient,
    skipSocketConnection: true,
    onNewTask: async (job: AcpJob, _memoToSign?: AcpMemo) => {
      if (job.phase === AcpJobPhases.NEGOTIATION) {
        requirementCount++;
        log(`Requirement #${requirementCount} received — reviewing hedge plan...`);

        // Parse the plan text to check for timeframe line
        const reqContent = typeof job.requirement === "string"
          ? job.requirement
          : JSON.stringify(job.requirement, null, 2);

        if (reqContent) {
          log("=== HEDGE PLAN ===");
          log(reqContent);
          log("=== END HEDGE PLAN ===");

          // Check if "Market Timeframe:" line appears in plan
          if (TIMEFRAME !== "all") {
            const hasTimeframeLine = reqContent.includes(`Market Timeframe: ${TIMEFRAME}`);
            log(`Plan shows "Market Timeframe: ${TIMEFRAME}": ${hasTimeframeLine ? "YES" : "NO"}`);
          }

          // Try to extract expiry info from plan text for validation
          const expiryMatches = [...reqContent.matchAll(/Expires: .+? \(in (.+?)\)/g)];
          if (expiryMatches.length > 0) {
            log(`Found ${expiryMatches.length} market(s) with expiry info:`,
              expiryMatches.map((m) => m[1])
            );
          }
        }

        try {
          await job.payAndAcceptRequirement(
            `TimeframeTest: Approved plan with timeframe=${TIMEFRAME}`
          );
          log("Plan accepted & paid");
        } catch (err) {
          log("Error accepting requirement", err);
        }
      }
    },
    onEvaluate: async (job: AcpJob) => {
      if (evaluationSent) return;
      evaluationSent = true;

      log("Evaluating deliverable...");

      if (job.deliverable) {
        try {
          const parsed = JSON.parse(job.deliverable as string);
          const hedges = parsed.hedges_placed ?? [];

          log("=== DELIVERABLE SUMMARY ===");
          log(`Hedges placed: ${hedges.length}`);
          log(`Total spent: $${parsed.summary?.total_spent}`);
          log(`Budget remaining: $${parsed.summary?.budget_remaining}`);
          log(`Deployment ratio: ${parsed.summary?.deployment_ratio}`);

          // Validate each hedge falls within the expected timeframe
          if (hedges.length > 0) {
            log("");
            log("=== TIMEFRAME VALIDATION ===");
            deliverableValidation = validateTimeframeCompliance(hedges, TIMEFRAME);

            for (const hedge of hedges) {
              const expiryMs = new Date(hedge.expiry).getTime();
              const hoursToExpiry = (expiryMs - Date.now()) / (1000 * 60 * 60);
              const bounds = TIMEFRAME_BOUNDS[TIMEFRAME]!;
              const inBounds = hoursToExpiry > bounds.min && hoursToExpiry <= bounds.max;
              log(
                `  ${inBounds ? "PASS" : "FAIL"} "${hedge.market_question}" — expires in ${hoursToExpiry.toFixed(1)}h (${hedge.expiry_human ?? "?"})`,
              );
            }

            if (deliverableValidation.pass) {
              log(`\nAll ${hedges.length} hedge(s) are within ${TIMEFRAME} timeframe window`);
            } else {
              log(`\nFAILED: ${deliverableValidation.violations.length} hedge(s) outside ${TIMEFRAME} window:`);
              for (const v of deliverableValidation.violations) {
                log(`  - ${v}`);
              }
            }
          } else {
            log("No hedges placed (budget may have been too small for available markets)");
          }

          log("=== END ===");
          log(`Reasoning: ${parsed.reasoning?.substring(0, 150)}...`);
        } catch {
          log("Raw deliverable:", job.deliverable);
        }
      }

      await job.evaluate(true, "TimeframeTest: deliverable approved");
      jobCompleted = true;
    },
  });

  await buyerClient.init();
  log("Buyer client initialized");
  await sleep(3000);

  // Discover HedgeFi agent
  log("Searching for HedgeFi agent...");
  let agents = await buyerClient.browseAgents("hedgefi", {
    graduationStatus: AcpGraduationStatus.ALL,
    onlineStatus: AcpOnlineStatus.ALL,
    showHiddenOfferings: true,
  });

  if (agents.length === 0) {
    const hedgefiWallet = process.env.HEDGEFI_WALLET_ADDRESS;
    if (hedgefiWallet) {
      const agent = await buyerClient.getAgent(
        hedgefiWallet as `0x${string}`,
        { showHiddenOfferings: true }
      );
      if (agent) agents = [agent];
    }
  }

  if (agents.length === 0) {
    log("ERROR: Could not find HedgeFi agent");
    process.exit(1);
  }

  const hedgefi = agents[0]!;
  log(`Found: ${hedgefi.name}`);

  const offering = hedgefi.jobOfferings.find((o) => o.name === "execute_hedge");
  if (!offering) {
    log("ERROR: No 'execute_hedge' offering");
    process.exit(1);
  }

  // Send job with the specified timeframe
  const requirement = {
    wallet_address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    chain: "base",
    risk_tolerance: "moderate",
    hedge_budget_usdc: 1,
    market_timeframe: TIMEFRAME,
  };

  log("Sending requirement:", requirement);
  const jobId = await offering.initiateJob(requirement);
  log(`Job initiated: #${jobId}`);

  // Wait for completion
  const timeout = 180_000;
  const start = Date.now();

  while (!jobCompleted && !jobRejected && Date.now() - start < timeout) {
    await sleep(5000);

    const polled = await buyerClient.getJobById(jobId);
    if (polled) {
      log(`Poll: phase=${polled.phase}, memos=${polled.memos.length}`);

      if (polled.phase === AcpJobPhases.COMPLETED) {
        jobCompleted = true;
      } else if (polled.phase === AcpJobPhases.REJECTED) {
        jobRejected = true;
        rejectionReason = polled.rejectionReason ?? "unknown";
        log(`Job REJECTED: ${rejectionReason}`);

        // Rejection with timeframe hint is expected when no markets exist for the window
        if (rejectionReason.includes("No " + TIMEFRAME + " markets")) {
          log(`This is expected — no ${TIMEFRAME} markets available right now. The timeframe filter is working correctly.`);
        }
      } else if (polled.phase === AcpJobPhases.EXPIRED) {
        log("Job expired!");
        break;
      }
    }
  }

  // Final summary
  log("");
  log("========================================");
  log("TEST RESULTS");
  log("========================================");
  log(`Timeframe tested: ${TIMEFRAME}`);
  log(`Bounds: ${TIMEFRAME_BOUNDS[TIMEFRAME]!.min}h - ${TIMEFRAME_BOUNDS[TIMEFRAME]!.max}h`);

  if (jobRejected) {
    if (rejectionReason.includes("No " + TIMEFRAME + " markets") || rejectionReason.includes("no_markets_found")) {
      log(`Result: PASS (no ${TIMEFRAME} markets available — filter worked, rejection is correct)`);
    } else {
      log(`Result: REJECTED — ${rejectionReason}`);
    }
  } else if (jobCompleted) {
    if (deliverableValidation) {
      log(`Result: ${deliverableValidation.pass ? "PASS" : "FAIL"}`);
      if (!deliverableValidation.pass) {
        log(`Violations: ${deliverableValidation.violations.length}`);
      }
    } else {
      log("Result: COMPLETED (no hedges to validate)");
    }
  } else {
    log("Result: TIMEOUT");
  }

  log("========================================");
  process.exit(0);
}

main().catch((err) => {
  log("Fatal error", err);
  process.exit(1);
});
