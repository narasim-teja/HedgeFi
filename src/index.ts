import { createLogger } from "./utils/logger.ts";
import { validateEnvironment } from "./utils/env-validator.ts";
import { createHedgeFiClient, checkAcpHealth, reinitializeAcpClient } from "./acp/client.ts";
import { authenticateAgent } from "./limitless/auth.ts";
import { startResourceServer } from "./resources/server.ts";
import { cleanupOldJobs, recoverStuckJobs } from "./db/job-state.ts";
import { initSchema } from "./db/schema.ts";
import { closeDb } from "./db/connection.ts";
import { jobQueue } from "./acp/handlers.ts";

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
    const httpServer = startResourceServer();

    // Periodic cleanup of old job state records (every 24h)
    const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const cleanupTimer = setInterval(async () => {
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

    // ACP health monitoring — poll every 60s, re-init after 3 consecutive failures
    const HEALTH_CHECK_INTERVAL_MS = 60_000;
    let consecutiveFailures = 0;
    const healthTimer = setInterval(async () => {
      try {
        const healthy = await checkAcpHealth();
        if (healthy) {
          if (consecutiveFailures > 0) {
            log.info(`ACP health restored after ${consecutiveFailures} failure(s)`);
          }
          consecutiveFailures = 0;
        } else {
          consecutiveFailures++;
          log.warn(`ACP health check failed (${consecutiveFailures} consecutive)`);
          if (consecutiveFailures >= 3) {
            log.error("ACP health check failed 3 times, re-initializing client");
            try {
              await reinitializeAcpClient();
              consecutiveFailures = 0;
              log.info("ACP client re-initialized successfully");
            } catch (reinitErr) {
              log.error("Failed to re-initialize ACP client", reinitErr);
            }
          }
        }
      } catch (err) {
        consecutiveFailures++;
        log.warn("ACP health check threw an error", err);
      }
    }, HEALTH_CHECK_INTERVAL_MS);

    // Graceful shutdown handler
    let shuttingDown = false;
    async function gracefulShutdown(signal: string) {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info(`Received ${signal}, starting graceful shutdown...`);

      // Stop health check and cleanup timers
      clearInterval(healthTimer);
      clearInterval(cleanupTimer);

      // Stop accepting new HTTP requests
      try {
        httpServer.stop();
        log.info("HTTP server stopped");
      } catch (err) {
        log.warn("Error stopping HTTP server", err);
      }

      // Drain the job queue (wait for active jobs to finish, up to 10s)
      try {
        log.info("Draining job queue...");
        await jobQueue.drain(10_000);
        const stats = jobQueue.getStats();
        log.info("Job queue drained", stats);
      } catch (err) {
        log.warn("Error draining job queue", err);
      }

      // Close database connection
      try {
        closeDb();
        log.info("Database connection closed");
      } catch (err) {
        log.warn("Error closing database", err);
      }

      log.info("Graceful shutdown complete");
      process.exit(0);
    }

    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

    log.info("HedgeFi agent is live and listening for jobs");
    log.info(`Agent wallet: ${acpClient.walletAddress}`);
    log.info("Press Ctrl+C to stop");
  } catch (err) {
    log.error("Failed to start HedgeFi agent", err);
    process.exit(1);
  }
}

main();
