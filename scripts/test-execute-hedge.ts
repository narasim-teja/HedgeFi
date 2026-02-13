/**
 * Test script: sends an execute_hedge job to HedgeFi with a $1 budget.
 * The HedgeFi agent must be running (bun run start) before running this.
 *
 * Usage: bun run scripts/test-execute-hedge.ts
 */
import AcpClient, {
  AcpContractClientV2,
  type AcpJob,
  type AcpMemo,
  AcpJobPhases,
  AcpGraduationStatus,
  AcpOnlineStatus,
} from "@virtuals-protocol/acp-node";

const log = (msg: string, data?: unknown) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [TestBuyer] ${msg}`, data !== undefined ? data : "");
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  log("Building buyer contract client...");

  const contractClient = await AcpContractClientV2.build(
    privateKey as `0x${string}`,
    Number(entityId),
    walletAddress as `0x${string}`
  );

  log("Contract client built. Creating ACP client...");

  let jobCompleted = false;
  let requirementCount = 0;
  let evaluationSent = false;

  const buyerClient = new AcpClient({
    acpContractClient: contractClient,
    skipSocketConnection: true,
    onNewTask: async (job: AcpJob, _memoToSign?: AcpMemo) => {
      log(`onNewTask for job #${job.id}`, {
        phase: job.phase,
        name: job.name,
      });

      // NEGOTIATION phase: The requirement text contains the hedge plan for review.
      // The agent runs analysis during REQUEST phase, so the plan is embedded
      // in the requirement that the buyer pays for.
      if (job.phase === AcpJobPhases.NEGOTIATION) {
        requirementCount++;
        log(`Job #${job.id}: [Req #${requirementCount}] Requirement received. Reviewing & paying...`);

        // Log the requirement content (contains the hedge plan)
        const reqContent = typeof job.requirement === "string"
          ? job.requirement
          : JSON.stringify(job.requirement, null, 2);
        if (reqContent && reqContent.length > 20) {
          log("=== HEDGE PLAN (from requirement) ===");
          log(reqContent);
          log("=== END HEDGE PLAN ===");
        }

        try {
          await job.payAndAcceptRequirement(
            `TestBuyer: Reviewed and approved hedge plan #${requirementCount}`
          );
          log(`Job #${job.id}: Requirement #${requirementCount} accepted & paid`);
        } catch (err) {
          log(`Job #${job.id}: Error accepting requirement #${requirementCount}`, err);
        }
      }
    },
    onEvaluate: async (job: AcpJob) => {
      log(`onEvaluate for job #${job.id}`, {
        phase: job.phase,
        hasDeliverable: !!job.deliverable,
      });

      if (!evaluationSent) {
        evaluationSent = true;
        try {
          // Log the deliverable before approving
          if (job.deliverable) {
            log("=== DELIVERABLE ===");
            try {
              const parsed = JSON.parse(job.deliverable as string);
              log("Exposure:", parsed.exposure);
              log("Hedges placed:", parsed.hedges_placed?.length ?? 0);
              log("Summary:", parsed.summary);
              if (parsed.summary?.deployment_ratio) {
                log("Deployment ratio:", parsed.summary.deployment_ratio);
              }
              if (parsed.summary?.undeployed_usdc !== undefined) {
                log("Undeployed USDC:", parsed.summary.undeployed_usdc);
              }
              if (parsed.summary?.redistribution_rounds !== undefined) {
                log("Redistribution rounds:", parsed.summary.redistribution_rounds);
              }
              log("Reasoning:", parsed.reasoning?.substring(0, 200) + "...");
            } catch {
              log("Raw deliverable:", job.deliverable);
            }
            log("=== END DELIVERABLE ===");
          }

          await job.evaluate(true, "TestBuyer: execute_hedge deliverable approved!");
          log(`Job #${job.id}: Evaluation approved`);
          jobCompleted = true;
        } catch (err) {
          log(`Job #${job.id}: Error evaluating`, err);
        }
      }
    },
  });

  await buyerClient.init();
  log("Buyer client initialized");

  await sleep(3000);

  // =========================================================
  // Step 1: Discover HedgeFi agent
  // =========================================================
  log("Searching for HedgeFi agent...");

  let agents = await buyerClient.browseAgents("hedgefi", {
    graduationStatus: AcpGraduationStatus.ALL,
    onlineStatus: AcpOnlineStatus.ALL,
    showHiddenOfferings: true,
  });

  log(`browseAgents returned ${agents.length} agent(s)`);

  if (agents.length === 0) {
    const hedgefiWallet = process.env.HEDGEFI_WALLET_ADDRESS;
    if (hedgefiWallet) {
      log(`Trying direct lookup: ${hedgefiWallet}`);
      const agent = await buyerClient.getAgent(
        hedgefiWallet as `0x${string}`,
        { showHiddenOfferings: true }
      );
      if (agent) {
        agents = [agent];
        log(`Found via direct lookup: ${agent.name}`);
      }
    }
  }

  if (agents.length === 0) {
    log("ERROR: Could not find HedgeFi agent. Is it registered and online?");
    process.exit(1);
  }

  const hedgefi = agents[0]!;
  log(`Found agent: ${hedgefi.name}`, {
    offerings: hedgefi.jobOfferings.map((o) => `${o.name} ($${o.price})`),
  });

  // =========================================================
  // Step 2: Find the execute_hedge offering
  // =========================================================
  const offering = hedgefi.jobOfferings.find(
    (o) => o.name === "execute_hedge"
  );

  if (!offering) {
    log("ERROR: No 'execute_hedge' offering found");
    log("Available offerings:", hedgefi.jobOfferings.map((o) => o.name));
    process.exit(1);
  }

  log(`Found offering: ${offering.name} (price: ${offering.price})`);

  // =========================================================
  // Step 3: Initiate execute_hedge job with $1 budget
  // =========================================================
  log("Initiating execute_hedge job with $1 hedge budget...");

  const requirement = {
    wallet_address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", // vitalik.eth — large public portfolio
    chain: "base",
    risk_tolerance: "moderate",
    hedge_budget_usdc: 1,
  };

  log("Requirement:", requirement);

  const jobId = await offering.initiateJob(requirement);
  log(`Job initiated! Job ID: ${jobId}`);

  // =========================================================
  // Step 4: Wait for job to complete
  // =========================================================
  log("Waiting for job lifecycle to complete...");

  const timeout = 180_000; // 3 minutes (execute_hedge takes longer)
  const start = Date.now();

  while (!jobCompleted && Date.now() - start < timeout) {
    await sleep(5000);

    const polled = await buyerClient.getJobById(jobId);
    if (polled) {
      log(`Job #${jobId} poll: phase=${polled.phase}, memos=${polled.memos.length}`);

      if (polled.phase === AcpJobPhases.COMPLETED) {
        log("Job completed!");
        if (polled.deliverable) {
          try {
            const parsed = JSON.parse(polled.deliverable as string);
            log("=== FINAL RESULT ===");
            log("Total spent:", parsed.summary?.total_spent);
            log("Hedges placed:", parsed.hedges_placed?.length);
            log("Budget remaining:", parsed.summary?.budget_remaining);
            log("=== END ===");
          } catch {
            log("Deliverable:", polled.deliverable);
          }
        }
        jobCompleted = true;
      } else if (polled.phase === AcpJobPhases.REJECTED) {
        log("Job rejected!", polled.rejectionReason);
        break;
      } else if (polled.phase === AcpJobPhases.EXPIRED) {
        log("Job expired!");
        break;
      }
    }
  }

  if (!jobCompleted) {
    log("Timeout — job did not complete within 3 minutes. Check HedgeFi agent logs.");
  } else {
    log("=== Test completed successfully! ===");
  }

  process.exit(0);
}

main().catch((err) => {
  log("Fatal error", err);
  process.exit(1);
});
