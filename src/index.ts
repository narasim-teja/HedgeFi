import { createLogger } from "./utils/logger.ts";
import { createHedgeFiClient } from "./acp/client.ts";
import { authenticateAgent } from "./limitless/auth.ts";
import { startResourceServer } from "./resources/server.ts";
// Importing schema initializes the SQLite database on startup
import "./db/schema.ts";

const log = createLogger("main");

async function main() {
  log.info("=== HedgeFi Agent Starting ===");

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

    log.info("HedgeFi agent is live and listening for jobs");
    log.info(`Agent wallet: ${acpClient.walletAddress}`);
    log.info("Press Ctrl+C to stop");

    // SDK's init() registers SIGINT/SIGTERM handlers that disconnect
    // the socket and call process.exit(0). The process stays alive
    // via the socket.io connection + Bun.serve().
  } catch (err) {
    log.error("Failed to start HedgeFi agent", err);
    process.exit(1);
  }
}

main();
