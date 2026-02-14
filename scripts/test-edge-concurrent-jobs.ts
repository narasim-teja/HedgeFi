/**
 * Edge case test: Two execute_hedge jobs from the SAME buyer at the same time.
 *
 * Tests the per-buyer concurrency lock. Both jobs should succeed,
 * but they should execute SEQUENTIALLY (not in parallel).
 *
 * What to watch for in HedgeFi agent logs:
 *  - "Lock acquired for <buyer>" / "Lock released for <buyer>" messages
 *  - The second job should wait for the first to complete
 *  - No "Insufficient balance" or race condition errors
 *
 * Usage: bun run scripts/test-edge-concurrent-jobs.ts
 */
import AcpClient, {
  AcpContractClientV2,
  type AcpJob,
  type AcpMemo,
  AcpJobPhases,
  AcpGraduationStatus,
  AcpOnlineStatus,
} from "@virtuals-protocol/acp-node";

const TAG = "EdgeTest:ConcurrentJobs";

const log = (msg: string, data?: unknown) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${TAG}] ${msg}`, data !== undefined ? data : "");
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  log("=== Concurrent Jobs (Same Buyer) Test ===");
  log("Expects: Both jobs complete, but serialized by the per-buyer lock\n");

  const privateKey = process.env.BUYER_PRIVATE_KEY;
  const entityId = process.env.BUYER_ENTITY_ID;
  const walletAddress = process.env.BUYER_WALLET_ADDRESS;

  if (!privateKey || !entityId || !walletAddress) {
    throw new Error("Missing BUYER_PRIVATE_KEY, BUYER_ENTITY_ID, BUYER_WALLET_ADDRESS");
  }

  const contractClient = await AcpContractClientV2.build(
    privateKey as `0x${string}`,
    Number(entityId),
    walletAddress as `0x${string}`
  );

  // Track state for both jobs
  const jobStates = new Map<number, {
    phase: string;
    requirementsPaid: number;
    evaluated: boolean;
  }>();

  const completedJobs = new Set<number>();
  const rejectedJobs = new Set<number>();

  const client = new AcpClient({
    acpContractClient: contractClient,
    skipSocketConnection: true,
    onNewTask: async (job: AcpJob, _memoToSign?: AcpMemo) => {
      const jobId = job.id;
      log(`onNewTask job #${jobId}`, { phase: job.phase, name: job.name });

      if (!jobStates.has(jobId)) {
        jobStates.set(jobId, { phase: String(job.phase), requirementsPaid: 0, evaluated: false });
      }

      if (job.phase === AcpJobPhases.NEGOTIATION) {
        const st = jobStates.get(jobId)!;
        st.requirementsPaid++;
        log(`Job #${jobId}: Paying requirement #${st.requirementsPaid}...`);
        try {
          await job.payAndAcceptRequirement(`ConcurrentTest: Accepted #${st.requirementsPaid}`);
          log(`Job #${jobId}: Paid`);
        } catch (err) {
          log(`Job #${jobId}: Pay error`, err);
        }
      }

      if (job.phase === AcpJobPhases.REJECTED) {
        rejectedJobs.add(jobId);
        log(`Job #${jobId}: REJECTED`);
      }
    },
    onEvaluate: async (job: AcpJob) => {
      const jobId = job.id;
      log(`onEvaluate job #${jobId}`);

      const st = jobStates.get(jobId);
      if (st && !st.evaluated) {
        st.evaluated = true;
        try {
          await job.evaluate(true, "ConcurrentTest: Approved");
          completedJobs.add(jobId);
          log(`Job #${jobId}: Evaluation approved`);
        } catch (err) {
          log(`Job #${jobId}: Evaluation error`, err);
        }
      }
    },
  });

  await client.init();
  await sleep(3000);

  // Find execute_hedge offering
  let agents = await client.browseAgents("hedgefi", {
    graduationStatus: AcpGraduationStatus.ALL,
    onlineStatus: AcpOnlineStatus.ALL,
    showHiddenOfferings: true,
  });

  if (agents.length === 0) {
    const hedgefiWallet = process.env.HEDGEFI_WALLET_ADDRESS;
    if (hedgefiWallet) {
      const agent = await client.getAgent(hedgefiWallet as `0x${string}`, { showHiddenOfferings: true });
      if (agent) agents = [agent];
    }
  }

  if (agents.length === 0) throw new Error("HedgeFi agent not found");

  const hedgefi = agents[0]!;
  const offering = hedgefi.jobOfferings.find((o) => o.name === "execute_hedge");
  if (!offering) throw new Error("No execute_hedge offering");

  // Send two jobs nearly simultaneously
  const requirement = {
    wallet_address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    chain: "base",
    risk_tolerance: "moderate",
    hedge_budget_usdc: 1,
  };

  log("Initiating Job A...");
  const jobIdA = await offering.initiateJob(requirement);
  log(`Job A: #${jobIdA}`);

  // Small delay to ensure both are in-flight
  await sleep(1000);

  log("Initiating Job B...");
  const jobIdB = await offering.initiateJob(requirement);
  log(`Job B: #${jobIdB}`);

  log(`\nBoth jobs initiated: A=#${jobIdA}, B=#${jobIdB}`);
  log("Waiting for both to complete (watch agent logs for lock serialization)...\n");

  // Wait for both
  const timeout = 300_000; // 5 min for two sequential jobs
  const start = Date.now();

  while (
    (completedJobs.size + rejectedJobs.size) < 2 &&
    Date.now() - start < timeout
  ) {
    await sleep(5000);

    for (const jid of [jobIdA, jobIdB]) {
      if (completedJobs.has(jid) || rejectedJobs.has(jid)) continue;

      const polled = await client.getJobById(jid);
      if (polled) {
        log(`Poll #${jid}: phase=${polled.phase}, memos=${polled.memos.length}`);
        if (polled.phase === AcpJobPhases.COMPLETED) completedJobs.add(jid);
        if (polled.phase === AcpJobPhases.REJECTED) rejectedJobs.add(jid);
      }
    }
  }

  // Results
  log("\n=== RESULTS ===");
  log(`Job A (#${jobIdA}): ${completedJobs.has(jobIdA) ? "COMPLETED" : rejectedJobs.has(jobIdA) ? "REJECTED" : "UNKNOWN"}`);
  log(`Job B (#${jobIdB}): ${completedJobs.has(jobIdB) ? "COMPLETED" : rejectedJobs.has(jobIdB) ? "REJECTED" : "UNKNOWN"}`);
  log(`Duration: ${((Date.now() - start) / 1000).toFixed(1)}s`);

  const bothResolved = (completedJobs.size + rejectedJobs.size) >= 2;
  if (bothResolved) {
    log("\nPASS — Both jobs resolved (check agent logs to confirm serialization)");
    log("Look for: 'Lock acquired' / 'Lock released' messages in agent output");
  } else {
    log("\nFAIL — Not all jobs resolved within timeout");
  }

  process.exit(bothResolved ? 0 : 1);
}

main().catch((err) => {
  log("Fatal error", err);
  process.exit(1);
});
