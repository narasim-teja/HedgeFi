import { createLogger } from "./utils/logger.ts";
import { createHedgeFiClient } from "./acp/client.ts";

const log = createLogger("main");

async function main() {
  log.info("=== HedgeFi Agent Starting ===");

  try {
    const acpClient = await createHedgeFiClient();

    log.info("HedgeFi agent is live and listening for jobs");
    log.info(`Agent wallet: ${acpClient.walletAddress}`);
    log.info("Press Ctrl+C to stop");

    // SDK's init() registers SIGINT/SIGTERM handlers that disconnect
    // the socket and call process.exit(0). The process stays alive
    // via the socket.io connection.
  } catch (err) {
    log.error("Failed to start HedgeFi agent", err);
    process.exit(1);
  }
}

main();
