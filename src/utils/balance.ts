import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { USDC_BASE, CHAIN_CONFIG, ERC20_ABI } from "./constants.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("balance");

// =============================================
// Shared public client
// =============================================

function getPublicClient() {
  return createPublicClient({
    chain: base,
    transport: http(CHAIN_CONFIG.base.rpcUrl),
  });
}

function getWalletAddress(): `0x${string}` {
  const addr = process.env.HEDGEFI_WALLET_ADDRESS;
  if (!addr) throw new Error("HEDGEFI_WALLET_ADDRESS not set");
  return addr as `0x${string}`;
}

// =============================================
// ERC-1155 balanceOf ABI (inline to avoid modifying const assertion in constants.ts)
// =============================================

const ERC1155_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// =============================================
// Agent USDC balance (trading wallet on Base)
// =============================================

/**
 * Read the agent's USDC balance on Base.
 * Returns human-readable USD amount (divided by 1e6).
 */
export async function getAgentUsdcBalance(): Promise<number> {
  const walletAddress = getWalletAddress();
  const client = getPublicClient();

  const raw = await client.readContract({
    address: USDC_BASE,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [walletAddress],
  });

  return Number(raw) / 1e6;
}

// =============================================
// Agent ETH balance (for gas)
// =============================================

/**
 * Read the agent's ETH balance on Base.
 * Returns ETH as a number.
 */
export async function getAgentEthBalance(): Promise<number> {
  const walletAddress = getWalletAddress();
  const client = getPublicClient();

  const raw = await client.getBalance({
    address: walletAddress,
  });

  return Number(raw) / 1e18;
}

// =============================================
// Agent ERC-1155 Conditional Token balance
// =============================================

/**
 * Read the agent's ERC-1155 conditional token balance for a specific tokenId.
 * Returns raw balance as bigint (shares are in 1e6 scale).
 */
export async function getAgentCtBalance(
  ctContractAddress: string,
  tokenId: string
): Promise<bigint> {
  const walletAddress = getWalletAddress();
  const client = getPublicClient();

  const raw = await client.readContract({
    address: ctContractAddress as `0x${string}`,
    abi: ERC1155_BALANCE_ABI,
    functionName: "balanceOf",
    args: [walletAddress, BigInt(tokenId)],
  });

  return raw;
}
