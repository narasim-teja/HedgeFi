import { createLogger } from "./utils/logger.ts";
import { validateEnvironment } from "./utils/env-validator.ts";
import { createHedgeFiClient } from "./acp/client.ts";
import { authenticateAgent } from "./limitless/auth.ts";
import { startResourceServer } from "./resources/server.ts";
import { cleanupOldJobs, recoverStuckJobs } from "./db/job-state.ts";
import { initSchema } from "./db/schema.ts";

const log = createLogger("main");

async function main() {
  log.info("=== HedgeFi Agent Starting ===");

  // Validate environment variables immediately at startup
  validateEnvironment();
  log.info("Environment validation passed");

  // Initialize database schema (Postgres tables)
  await initSchema();

  try {
    // Authenticate with Limitless Exchange (auto-creates account on first login)
    log.info("Authenticating with Limitless Exchange...");
    try {
      await authenticateAgent();
      log.info("Limitless authentication successful");
    } catch (err) {
      log.warn("Limitless authentication failed — order placement will retry on demand", err);
    }

    const acpClient = await createHedgeFiClient();

    // Start the ACP Resource HTTP server (positions, markets)
    startResourceServer();

    // Periodic cleanup of old job state records (every 24h)
    const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
    setInterval(async () => {
      try {
        await cleanupOldJobs(30);
      } catch (err) {
        log.warn("Job state cleanup failed", err);
      }
    }, CLEANUP_INTERVAL_MS);
    // Run once at startup too
    try {
      await cleanupOldJobs(30);
    } catch (err) {
      log.warn("Job state cleanup failed on startup", err);
    }
    // Recover any jobs stuck in "executing" from a previous crash
    try {
      await recoverStuckJobs(10);
    } catch (err) {
      log.warn("Failed to recover stuck jobs on startup", err);
    }

    log.info("HedgeFi agent is live and listening for jobs");
    log.info(`Agent wallet: ${acpClient.walletAddress}`);
    log.info("Press Ctrl+C to stop");
  } catch (err) {
    log.error("Failed to start HedgeFi agent", err);
    process.exit(1);
  }
}

main();
