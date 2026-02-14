import { createPublicClient, createWalletClient, http, maxUint256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { createLogger } from "../utils/logger.ts";
import {
  USDC_BASE,
  CHAIN_CONFIG,
  ERC20_APPROVE_ABI,
  ERC1155_ABI,
  ERC20_ABI,
} from "../utils/constants.ts";

const log = createLogger("limitless-approvals");

// =============================================
// Wallet setup
// =============================================

function getAccount() {
  const pk = process.env.HEDGEFI_PRIVATE_KEY;
  if (!pk) throw new Error("HEDGEFI_PRIVATE_KEY not set");
  return privateKeyToAccount(pk as `0x${string}`);
}

function getWalletClient() {
  return createWalletClient({
    account: getAccount(),
    chain: base,
    transport: http(CHAIN_CONFIG.base.rpcUrl),
  });
}

function getPublicClient() {
  return createPublicClient({
    chain: base,
    transport: http(CHAIN_CONFIG.base.rpcUrl),
  });
}

// =============================================
// Approval cache with TTL (per exchange address)
// =============================================

const APPROVAL_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const usdcApproved = new Map<string, number>();
const ctApproved = new Map<string, number>();

function isCacheValid(cache: Map<string, number>, key: string): boolean {
  const ts = cache.get(key);
  if (ts === undefined) return false;
  if (Date.now() - ts > APPROVAL_CACHE_TTL_MS) {
    cache.delete(key);
    return false;
  }
  return true;
}

// =============================================
// USDC Approval (ERC-20)
// =============================================

/**
 * Ensure USDC is approved for the given exchange contract.
 * Checks allowance first, only sends tx if needed.
 */
export async function ensureUsdcApproval(exchangeAddress: string): Promise<void> {
  if (isCacheValid(usdcApproved, exchangeAddress)) return;

  const publicClient = getPublicClient();
  const account = getAccount();

  const abi = [...ERC20_ABI, ...ERC20_APPROVE_ABI];

  try {
    const allowance = await publicClient.readContract({
      address: USDC_BASE,
      abi,
      functionName: "allowance",
      args: [account.address, exchangeAddress as `0x${string}`],
    }) as bigint;

    // If allowance is > 1000 USDC (1e9 in 6-decimal), skip approval
    if (allowance > 1_000_000_000n) {
      log.debug(`USDC already approved for ${exchangeAddress}`);
      usdcApproved.set(exchangeAddress, Date.now());
      return;
    }
  } catch (err) {
    log.warn("Failed to check USDC allowance, will attempt approval", err);
  }

  log.info(`Approving USDC for exchange ${exchangeAddress}`);
  const walletClient = getWalletClient();

  const hash = await walletClient.writeContract({
    address: USDC_BASE,
    abi,
    functionName: "approve",
    args: [exchangeAddress as `0x${string}`, maxUint256],
  });

  log.info(`USDC approval tx sent: ${hash}`);

  // Wait for confirmation
  const publicClientForReceipt = getPublicClient();
  await publicClientForReceipt.waitForTransactionReceipt({ hash });
  log.info("USDC approval confirmed");

  usdcApproved.set(exchangeAddress, Date.now());
}

/**
 * Ensure Conditional Tokens (ERC-1155) are approved for selling.
 * The CT contract address is derived from the market's collateral/venue setup.
 * For Limitless CLOB markets, the CT contract is typically at a known address.
 */
export async function ensureCtApproval(
  ctContractAddress: string,
  exchangeAddress: string
): Promise<void> {
  const cacheKey = `${ctContractAddress}:${exchangeAddress}`;
  if (isCacheValid(ctApproved, cacheKey)) return;

  const publicClient = getPublicClient();
  const account = getAccount();

  try {
    const isApproved = await publicClient.readContract({
      address: ctContractAddress as `0x${string}`,
      abi: ERC1155_ABI,
      functionName: "isApprovedForAll",
      args: [account.address, exchangeAddress as `0x${string}`],
    }) as boolean;

    if (isApproved) {
      log.debug(`CT already approved for ${exchangeAddress}`);
      ctApproved.set(cacheKey, Date.now());
      return;
    }
  } catch (err) {
    log.warn("Failed to check CT approval, will attempt approval", err);
  }

  log.info(`Approving CT (${ctContractAddress}) for exchange ${exchangeAddress}`);
  const walletClient = getWalletClient();

  const hash = await walletClient.writeContract({
    address: ctContractAddress as `0x${string}`,
    abi: ERC1155_ABI,
    functionName: "setApprovalForAll",
    args: [exchangeAddress as `0x${string}`, true],
  });

  log.info(`CT approval tx sent: ${hash}`);

  const publicClientForReceipt = getPublicClient();
  await publicClientForReceipt.waitForTransactionReceipt({ hash });
  log.info("CT approval confirmed");

  ctApproved.set(cacheKey, Date.now());
}
