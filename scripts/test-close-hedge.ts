/**
 * Test script: sends a close_hedge job to HedgeFi to close all active positions.
 * The HedgeFi agent must be running (bun run start) before running this.
 * Run test-execute-hedge.ts first to create positions to close.
 *
 * Usage: bun run scripts/test-close-hedge.ts
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
  let paymentSent = false;
  let evaluationSent = false;

  const buyerClient = new AcpClient({
    acpContractClient: contractClient,
    skipSocketConnection: true,
    onNewTask: async (job: AcpJob, memoToSign?: AcpMemo) => {
      log(`onNewTask for job #${job.id}`, {
        phase: job.phase,
        name: job.name,
      });

      // When provider creates a requirement (NEGOTIATION phase), buyer pays
      if (job.phase === AcpJobPhases.NEGOTIATION && !paymentSent) {
        paymentSent = true;
        log(`Job #${job.id}: Provider accepted. Paying requirement...`);
        try {
          await job.payAndAcceptRequirement("TestBuyer: Payment confirmed for close_hedge");
          log(`Job #${job.id}: Payment sent`);
        } catch (err) {
          log(`Job #${job.id}: Error paying requirement`, err);
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
              log("Positions closed:", parsed.positions_closed);
              log("Total returned USDC:", parsed.total_returned_usdc);
              log("Return tx hash:", parsed.return_tx_hash);
            } catch {
              log("Raw deliverable:", job.deliverable);
            }
            log("=== END DELIVERABLE ===");
          }

          await job.evaluate(true, "TestBuyer: close_hedge deliverable approved!");
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
  // Step 2: Find the close_hedge offering
  // =========================================================
  const offering = hedgefi.jobOfferings.find(
    (o) => o.name === "close_hedge"
  );

  if (!offering) {
    log("ERROR: No 'close_hedge' offering found");
    log("Available offerings:", hedgefi.jobOfferings.map((o) => o.name));
    process.exit(1);
  }

  log(`Found offering: ${offering.name} (price: ${offering.price})`);

  // =========================================================
  // Step 3: Initiate close_hedge job
  // =========================================================
  // Support specific position IDs via env var, otherwise close all
  const positionIds = process.env.POSITION_IDS
    ? process.env.POSITION_IDS.split(",").map((s) => s.trim())
    : null;

  const requirement = positionIds
    ? { position_ids: positionIds }
    : { close_all: true };

  log("Initiating close_hedge job...");
  log("Requirement:", requirement);

  const jobId = await offering.initiateJob(requirement);
  log(`Job initiated! Job ID: ${jobId}`);

  // =========================================================
  // Step 4: Wait for job to complete
  // =========================================================
  log("Waiting for job lifecycle to complete...");

  const timeout = 180_000; // 3 minutes
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
            log("Positions closed:", parsed.positions_closed?.length ?? 0);
            log("Total returned:", parsed.total_returned_usdc);
            log("Tx hash:", parsed.return_tx_hash);
            if (parsed.positions_closed?.length > 0) {
              for (const pc of parsed.positions_closed) {
                log(`  ${pc.market_id}: sold ${pc.shares_sold} @ $${pc.sale_price}, P&L: $${pc.realized_pnl}`);
              }
            }
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
