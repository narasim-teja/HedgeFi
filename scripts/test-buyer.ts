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

  const buyerClient = new AcpClient({
    acpContractClient: contractClient,
    onNewTask: async (job: AcpJob, memoToSign?: AcpMemo) => {
      log(`onNewTask for job #${job.id}`, {
        phase: job.phase,
        name: job.name,
        memoToSignId: memoToSign?.id,
      });

      // When provider creates a requirement (NEGOTIATION phase), buyer pays
      if (job.phase === AcpJobPhases.NEGOTIATION) {
        log(`Job #${job.id}: Provider accepted. Paying requirement...`);
        try {
          await job.payAndAcceptRequirement("TestBuyer: Payment confirmed");
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

      // Auto-approve the deliverable
      try {
        await job.evaluate(true, "TestBuyer: Deliverable approved!");
        log(`Job #${job.id}: Evaluation approved`);
        jobCompleted = true;
      } catch (err) {
        log(`Job #${job.id}: Error evaluating`, err);
      }
    },
  });

  await buyerClient.init();
  log("Buyer client initialized");

  // Give socket time to connect
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

  // Fallback: direct lookup by wallet address
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
    id: hedgefi.id,
    walletAddress: hedgefi.walletAddress,
    offerings: hedgefi.jobOfferings.map((o) => o.name),
  });

  // =========================================================
  // Step 2: Find the hedge_analysis offering
  // =========================================================
  const offering = hedgefi.jobOfferings.find(
    (o) => o.name === "hedge_analysis"
  );

  if (!offering) {
    log("ERROR: No 'hedge_analysis' offering found");
    log("Available offerings:", hedgefi.jobOfferings.map((o) => o.name));
    process.exit(1);
  }

  log(`Found offering: ${offering.name} (price: ${offering.price})`);

  // =========================================================
  // Step 3: Initiate hedge_analysis job
  // =========================================================
  log("Initiating hedge_analysis job...");

  const requirement = {
    wallet_address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", // vitalik.eth
    chain: "base",
    risk_tolerance: "moderate",
    hedge_budget: 50,
  };

  const jobId = await offering.initiateJob(requirement);
  log(`Job initiated! Job ID: ${jobId}`);

  // =========================================================
  // Step 4: Wait for job to complete
  // =========================================================
  log("Waiting for job lifecycle to complete...");

  const timeout = 120_000; // 2 minutes
  const start = Date.now();

  while (!jobCompleted && Date.now() - start < timeout) {
    await sleep(5000);

    // Poll as backup
    const polled = await buyerClient.getJobById(jobId);
    if (polled) {
      log(`Job #${jobId} poll: phase=${polled.phase}, memos=${polled.memos.length}`);

      if (polled.phase === AcpJobPhases.COMPLETED) {
        log("Job completed!");
        log("Deliverable:", polled.deliverable);
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
    log("Timeout — job did not complete within 2 minutes. Check HedgeFi logs.");
  } else {
    log("=== Test completed successfully! ===");
  }

  process.exit(0);
}

main().catch((err) => {
  log("Fatal error", err);
  process.exit(1);
});
