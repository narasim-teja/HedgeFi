/**
 * Shared helper for buyer test scripts.
 * Creates and initializes the buyer ACP client with configurable callbacks.
 */
import AcpClient, {
  AcpContractClientV2,
  type AcpJob,
  type AcpMemo,
  AcpJobPhases,
  AcpGraduationStatus,
  AcpOnlineStatus,
} from "@virtuals-protocol/acp-node";

export interface TestResult {
  jobId: number;
  finalPhase: string;
  deliverable: unknown | null;
  rejectionReason: string | null;
  requirementCount: number;
  durationMs: number;
}

export const log = (tag: string, msg: string, data?: unknown) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${tag}] ${msg}`, data !== undefined ? data : "");
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a buyer ACP client from env vars.
 */
export async function createBuyerClient(opts?: {
  /** Auto-pay requirements? Default true */
  autoPayRequirements?: boolean;
  /** Auto-approve evaluation? Default true */
  autoApproveEval?: boolean;
  /** Tag for log messages */
  tag?: string;
}): Promise<{
  client: AcpClient;
  state: {
    completed: boolean;
    rejected: boolean;
    requirementCount: number;
    evaluationSent: boolean;
    deliverable: unknown | null;
    rejectionReason: string | null;
    requirementTexts: string[];
  };
}> {
  const privateKey = process.env.BUYER_PRIVATE_KEY;
  const entityId = process.env.BUYER_ENTITY_ID;
  const walletAddress = process.env.BUYER_WALLET_ADDRESS;
  const tag = opts?.tag ?? "Buyer";
  const autoPayReqs = opts?.autoPayRequirements ?? true;
  const autoApproveEval = opts?.autoApproveEval ?? true;

  if (!privateKey || !entityId || !walletAddress) {
    throw new Error(
      "Missing env vars: BUYER_PRIVATE_KEY, BUYER_ENTITY_ID, BUYER_WALLET_ADDRESS"
    );
  }

  const contractClient = await AcpContractClientV2.build(
    privateKey as `0x${string}`,
    Number(entityId),
    walletAddress as `0x${string}`
  );

  const state = {
    completed: false,
    rejected: false,
    requirementCount: 0,
    evaluationSent: false,
    deliverable: null as unknown | null,
    rejectionReason: null as string | null,
    requirementTexts: [] as string[],
  };

  const client = new AcpClient({
    acpContractClient: contractClient,
    skipSocketConnection: true,
    onNewTask: async (job: AcpJob, _memoToSign?: AcpMemo) => {
      log(tag, `onNewTask job #${job.id}`, { phase: job.phase, name: job.name });

      if (job.phase === AcpJobPhases.NEGOTIATION && autoPayReqs) {
        state.requirementCount++;
        const reqContent = typeof job.requirement === "string"
          ? job.requirement
          : JSON.stringify(job.requirement);
        state.requirementTexts.push(reqContent ?? "");

        log(tag, `Requirement #${state.requirementCount} received, auto-paying...`);
        try {
          await job.payAndAcceptRequirement(
            `${tag}: Accepted requirement #${state.requirementCount}`
          );
          log(tag, `Requirement #${state.requirementCount} paid`);
        } catch (err) {
          log(tag, `Error paying requirement`, err);
        }
      }

      // Detect rejection
      if (job.phase === AcpJobPhases.REJECTED) {
        state.rejected = true;
        state.rejectionReason = (job as any).rejectionReason ?? "unknown";
        log(tag, `Job REJECTED: ${state.rejectionReason}`);
      }
    },
    onEvaluate: async (job: AcpJob) => {
      log(tag, `onEvaluate job #${job.id}`, { hasDeliverable: !!job.deliverable });

      if (!state.evaluationSent && autoApproveEval) {
        state.evaluationSent = true;
        try {
          if (job.deliverable) {
            try {
              state.deliverable = JSON.parse(job.deliverable as string);
            } catch {
              state.deliverable = job.deliverable;
            }
          }
          await job.evaluate(true, `${tag}: Approved`);
          state.completed = true;
          log(tag, `Evaluation approved`);
        } catch (err) {
          log(tag, `Error evaluating`, err);
        }
      }
    },
  });

  await client.init();
  await sleep(2000);

  return { client, state };
}

/**
 * Find the HedgeFi agent and return a specific job offering.
 */
export async function findOffering(
  client: AcpClient,
  jobName: string,
  tag: string = "Buyer"
): Promise<ReturnType<Awaited<ReturnType<typeof client.browseAgents>>[number]["jobOfferings"]["find"]>> {
  log(tag, "Searching for HedgeFi agent...");

  let agents = await client.browseAgents("hedgefi", {
    graduationStatus: AcpGraduationStatus.ALL,
    onlineStatus: AcpOnlineStatus.ALL,
    showHiddenOfferings: true,
  });

  if (agents.length === 0) {
    const hedgefiWallet = process.env.HEDGEFI_WALLET_ADDRESS;
    if (hedgefiWallet) {
      const agent = await client.getAgent(
        hedgefiWallet as `0x${string}`,
        { showHiddenOfferings: true }
      );
      if (agent) agents = [agent];
    }
  }

  if (agents.length === 0) {
    throw new Error("Could not find HedgeFi agent. Is it running?");
  }

  const hedgefi = agents[0]!;
  log(tag, `Found agent: ${hedgefi.name}`, {
    offerings: hedgefi.jobOfferings.map((o) => o.name),
  });

  const offering = hedgefi.jobOfferings.find((o) => o.name === jobName);
  if (!offering) {
    throw new Error(`No '${jobName}' offering found. Available: ${hedgefi.jobOfferings.map((o) => o.name).join(", ")}`);
  }

  return offering;
}

/**
 * Poll a job until it reaches a terminal phase or times out.
 */
export async function waitForJob(
  client: AcpClient,
  jobId: number,
  state: { completed: boolean; rejected: boolean },
  opts?: { timeoutMs?: number; tag?: string }
): Promise<TestResult> {
  const tag = opts?.tag ?? "Buyer";
  const timeout = opts?.timeoutMs ?? 180_000;
  const start = Date.now();

  while (!state.completed && !state.rejected && Date.now() - start < timeout) {
    await sleep(5000);

    const polled = await client.getJobById(jobId);
    if (polled) {
      log(tag, `Poll job #${jobId}: phase=${polled.phase}, memos=${polled.memos.length}`);

      if (polled.phase === AcpJobPhases.COMPLETED) {
        state.completed = true;
        if (polled.deliverable) {
          try {
            return {
              jobId,
              finalPhase: "COMPLETED",
              deliverable: JSON.parse(polled.deliverable as string),
              rejectionReason: null,
              requirementCount: (state as any).requirementCount ?? 0,
              durationMs: Date.now() - start,
            };
          } catch {}
        }
      } else if (polled.phase === AcpJobPhases.REJECTED) {
        state.rejected = true;
        return {
          jobId,
          finalPhase: "REJECTED",
          deliverable: null,
          rejectionReason: polled.rejectionReason ?? "unknown",
          requirementCount: (state as any).requirementCount ?? 0,
          durationMs: Date.now() - start,
        };
      } else if (polled.phase === AcpJobPhases.EXPIRED) {
        return {
          jobId,
          finalPhase: "EXPIRED",
          deliverable: null,
          rejectionReason: null,
          requirementCount: (state as any).requirementCount ?? 0,
          durationMs: Date.now() - start,
        };
      }
    }
  }

  return {
    jobId,
    finalPhase: state.completed ? "COMPLETED" : state.rejected ? "REJECTED" : "TIMEOUT",
    deliverable: (state as any).deliverable ?? null,
    rejectionReason: (state as any).rejectionReason ?? null,
    requirementCount: (state as any).requirementCount ?? 0,
    durationMs: Date.now() - start,
  };
}
