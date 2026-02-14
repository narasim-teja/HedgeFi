import AcpClient, {
  AcpContractClientV2,
  type AcpJob,
  type AcpMemo,
} from "@virtuals-protocol/acp-node";
import { createLogger } from "../utils/logger.ts";
import { handleNewTask } from "./handlers.ts";
import { verifyDeliverable } from "./evaluation.ts";

const log = createLogger("acp-client");

// Dedup guard for evaluation — prevents duplicate socket events
const evaluatingJobs = new Set<number>();

// Module-level reference for health checks and re-initialization
let acpClientInstance: AcpClient | null = null;

export async function createHedgeFiClient(): Promise<AcpClient> {
  const privateKey = process.env.HEDGEFI_PRIVATE_KEY;
  const entityId = process.env.HEDGEFI_ENTITY_ID;
  const walletAddress = process.env.HEDGEFI_WALLET_ADDRESS;

  if (!privateKey || !entityId || !walletAddress) {
    throw new Error(
      "Missing required env vars: HEDGEFI_PRIVATE_KEY, HEDGEFI_ENTITY_ID, HEDGEFI_WALLET_ADDRESS"
    );
  }

  log.info("Building ACP contract client...", {
    entityId: Number(entityId),
    walletAddress,
  });

  // AcpContractClientV2.build(privateKey, entityId, walletAddress, config?)
  // config defaults to baseAcpConfigV2 (Base mainnet)
  const contractClient = await AcpContractClientV2.build(
    privateKey as `0x${string}`,
    Number(entityId),
    walletAddress as `0x${string}`
  );

  log.info("Contract client built successfully");

  const acpClient = new AcpClient({
    acpContractClient: contractClient,
    skipSocketConnection: true,
    onNewTask: async (job: AcpJob, memoToSign?: AcpMemo) => {
      log.info(`New task received: job #${job.id}`, {
        phase: job.phase,
        name: job.name,
        clientAddress: job.clientAddress,
      });
      try {
        await handleNewTask(job, memoToSign);
      } catch (err) {
        log.error(`Error handling job #${job.id}`, err);
      }
    },
    onEvaluate: async (job: AcpJob) => {
      // Memory cap: prevent unbounded growth under extreme load
      if (evaluatingJobs.size > 500) {
        log.warn(`Evaluation dedup set reached ${evaluatingJobs.size} entries, clearing stale entries`);
        evaluatingJobs.clear();
      }
      // Dedup: skip if we're already evaluating this job
      if (evaluatingJobs.has(job.id)) {
        log.debug(`Job #${job.id} evaluation already in progress, skipping duplicate`);
        return;
      }
      evaluatingJobs.add(job.id);

      log.info(`Evaluation requested for job #${job.id}`, {
        phase: job.phase,
      });
      try {
        const result = await verifyDeliverable(job);
        await job.evaluate(result.approved, `HedgeFi: ${result.reason}`);
        log.info(`Job #${job.id} evaluation: ${result.approved ? "approved" : "rejected"} — ${result.reason}`);
      } catch (err) {
        log.warn(`Error evaluating job #${job.id} — auto-approving (on-chain positions cannot be undone)`, err);
        // Fallback: auto-approve to avoid stuck jobs (positions already exist on-chain)
        try {
          await job.evaluate(true, "HedgeFi: Auto-approved (evaluation error — on-chain positions cannot be undone)");
        } catch (fallbackErr) {
          log.error(`Job #${job.id}: fallback evaluation also failed`, fallbackErr);
        }
      } finally {
        // Clean up after a delay to allow for any late duplicates
        setTimeout(() => evaluatingJobs.delete(job.id), 30_000);
      }
    },
  });

  // skipSocketConnection: true in constructor prevents auto-init,
  // so we create the socket exactly once here with proper await.
  await acpClient.init();

  acpClientInstance = acpClient;
  log.info("HedgeFi ACP client initialized and connected");
  return acpClient;
}

/**
 * Check ACP client health by making a lightweight SDK call.
 * Returns true if the client can successfully communicate with ACP.
 */
export async function checkAcpHealth(): Promise<boolean> {
  if (!acpClientInstance) return false;
  try {
    await acpClientInstance.getActiveJobs(1, 1);
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-initialize the ACP client (e.g., after repeated health check failures).
 */
export async function reinitializeAcpClient(): Promise<AcpClient> {
  log.warn("Re-initializing ACP client due to health check failures");
  acpClientInstance = null;
  return createHedgeFiClient();
}
