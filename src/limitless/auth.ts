import { privateKeyToAccount } from "viem/accounts";
import { createLogger } from "../utils/logger.ts";
import { LIMITLESS_API_BASE_URL } from "../utils/constants.ts";
import type { LimitlessUserProfile } from "../utils/types.ts";

const log = createLogger("limitless-auth");

// =============================================
// Session state
// =============================================

let sessionCookie: string | null = null;
let userProfile: LimitlessUserProfile | null = null;

// =============================================
// Public API
// =============================================

/**
 * Authenticate the HedgeFi agent wallet with Limitless Exchange.
 * Uses EIP-191 personal sign — no API key or UI interaction needed.
 * Auto-creates account on first login.
 */
export async function authenticateAgent(): Promise<void> {
  const privateKey = process.env.HEDGEFI_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("HEDGEFI_PRIVATE_KEY not set — cannot authenticate with Limitless");
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const address = account.address;

  log.info(`Authenticating with Limitless as ${address}`);

  // Step 1: Get signing message (contains server nonce)
  const signingMessageRes = await fetch(
    `${LIMITLESS_API_BASE_URL}/auth/signing-message`,
    { headers: { Accept: "application/json" } }
  );

  if (!signingMessageRes.ok) {
    throw new Error(
      `Failed to get signing message: ${signingMessageRes.status} ${signingMessageRes.statusText}`
    );
  }

  const signingMessage = await signingMessageRes.text();
  // Strip quotes if JSON-encoded string
  const cleanMessage = signingMessage.replace(/^"|"$/g, "");
  log.debug("Got signing message from Limitless");

  // Step 2: Sign the message with agent's private key (EIP-191)
  const signature = await account.signMessage({ message: cleanMessage });
  log.debug("Signed authentication message");

  // Step 3: Login
  // Limitless expects x-signing-message as a hex string (0x-prefixed).
  const messageHex = "0x" + Buffer.from(cleanMessage, "utf-8").toString("hex");
  const loginRes = await fetch(`${LIMITLESS_API_BASE_URL}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-account": address,
      "x-signing-message": messageHex,
      "x-signature": signature,
    },
    body: JSON.stringify({ client: "eoa" }),
  });

  if (!loginRes.ok) {
    const errorText = await loginRes.text();
    throw new Error(
      `Limitless login failed: ${loginRes.status} ${loginRes.statusText} — ${errorText}`
    );
  }

  // Step 4: Extract session cookie from response headers
  const setCookieHeader = loginRes.headers.get("set-cookie");
  if (setCookieHeader) {
    // Extract the limitless_session cookie value
    const match = setCookieHeader.match(/limitless_session=([^;]+)/);
    if (match) {
      sessionCookie = match[1]!;
      log.info("Session cookie obtained");
    } else {
      // Store the full set-cookie as fallback
      sessionCookie = setCookieHeader.split(";")[0] ?? null;
      log.warn("Could not parse limitless_session cookie, using raw cookie");
    }
  } else {
    log.warn("No set-cookie header in login response");
  }

  const loginData = await loginRes.json();
  log.info("Logged in to Limitless", {
    account: loginData.account,
    displayName: loginData.displayName,
  });

  // Step 5: Fetch user profile for ownerId and feeRateBps
  try {
    const profileRes = await fetch(
      `${LIMITLESS_API_BASE_URL}/profiles/${address}`,
      {
        headers: {
          Accept: "application/json",
          ...(sessionCookie
            ? { Cookie: `limitless_session=${sessionCookie}` }
            : {}),
        },
      }
    );

    if (profileRes.ok) {
      userProfile = (await profileRes.json()) as LimitlessUserProfile;
      log.info("User profile fetched", {
        ownerId: userProfile.id,
        feeRateBps: userProfile.rank?.feeRateBps,
      });
    } else {
      log.warn(`Failed to fetch profile: ${profileRes.status}`);
    }
  } catch (err) {
    log.warn("Failed to fetch user profile, will use defaults", err);
  }
}

/**
 * Get the session cookie for authenticated API calls.
 * Returns the cookie string or null if not authenticated.
 */
export function getSessionCookie(): string | null {
  return sessionCookie;
}

/**
 * Get the cached user profile (ownerId, feeRateBps).
 */
export function getUserProfile(): LimitlessUserProfile | null {
  return userProfile;
}

/**
 * Ensure the agent is authenticated. Calls authenticateAgent() if needed.
 */
export async function ensureAuthenticated(): Promise<void> {
  if (sessionCookie) return;
  await authenticateAgent();
}
