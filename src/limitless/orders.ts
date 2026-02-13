import { privateKeyToAccount } from "viem/accounts";
import { createLogger } from "../utils/logger.ts";
import {
  LIMITLESS_EIP712_DOMAIN_NAME,
  LIMITLESS_EIP712_DOMAIN_VERSION,
  BASE_CHAIN_ID,
  ZERO_ADDRESS,
  USDC_DECIMALS,
  EIP712_ORDER_TYPES,
  DEFAULT_FEE_RATE_BPS,
} from "../utils/constants.ts";
import {
  LimitlessOrderSide,
  LimitlessOrderType,
  LimitlessSignatureType,
} from "../utils/types.ts";
import type {
  UnsignedOrder,
  NewOrderPayload,
  PlaceOrderParams,
  PlaceOrderResult,
} from "../utils/types.ts";
import { submitOrder } from "./client.ts";
import { getUserProfile, ensureAuthenticated } from "./auth.ts";
import { ensureUsdcApproval } from "./approvals.ts";
import { withRetry } from "../utils/retry.ts";

const log = createLogger("limitless-orders");

// =============================================
// Salt generation
// =============================================

/**
 * Generate a unique salt for the order.
 * Matches Limitless SDK pattern: timestamp * 1000 + nanoOffset + 86400000
 */
function generateSalt(): bigint {
  const timestamp = BigInt(Date.now());
  const nanoOffset = BigInt(Math.floor(performance.now() * 1000) % 1000000);
  return timestamp * 1000n + nanoOffset + 86400000n;
}

// =============================================
// Order building
// =============================================

function getAccount() {
  const pk = process.env.HEDGEFI_PRIVATE_KEY;
  if (!pk) throw new Error("HEDGEFI_PRIVATE_KEY not set");
  return privateKeyToAccount(pk as `0x${string}`);
}

/**
 * Build an unsigned FOK BUY order.
 * FOK: makerAmount = USDC to spend (6 decimals), takerAmount = 1 (FOK marker)
 */
function buildFokBuyOrder(
  tokenId: string,
  usdcAmount: number,
  feeRateBps: number
): UnsignedOrder {
  const account = getAccount();
  const makerAmount = BigInt(Math.ceil(usdcAmount * 10 ** USDC_DECIMALS));

  return {
    salt: generateSalt(),
    maker: account.address,
    signer: account.address,
    taker: ZERO_ADDRESS,
    tokenId,
    makerAmount,
    takerAmount: 1n, // FOK marker
    expiration: 0n, // no expiry for FOK
    nonce: 0n,
    feeRateBps: BigInt(feeRateBps),
    side: LimitlessOrderSide.BUY,
    signatureType: LimitlessSignatureType.EOA,
  };
}

/**
 * Build an unsigned FOK SELL order.
 * FOK SELL: makerAmount = shares to sell (6 decimals), takerAmount = 1 (FOK marker)
 */
function buildFokSellOrder(
  tokenId: string,
  shares: number,
  feeRateBps: number
): UnsignedOrder {
  const account = getAccount();
  const makerAmount = BigInt(Math.ceil(shares * 10 ** USDC_DECIMALS));

  return {
    salt: generateSalt(),
    maker: account.address,
    signer: account.address,
    taker: ZERO_ADDRESS,
    tokenId,
    makerAmount,
    takerAmount: 1n, // FOK marker
    expiration: 0n,
    nonce: 0n,
    feeRateBps: BigInt(feeRateBps),
    side: LimitlessOrderSide.SELL,
    signatureType: LimitlessSignatureType.EOA,
  };
}

// =============================================
// GTC order building (Phase 6.5)
// =============================================

/**
 * Build an unsigned GTC BUY order.
 * GTC: makerAmount = USDC to spend (6 decimals), takerAmount = shares to receive (6 decimals)
 * Expiration = market expiry - 60 seconds
 */
function buildGtcBuyOrder(
  tokenId: string,
  usdcAmount: number,
  pricePerShare: number,
  expirationTimestamp: number,
  feeRateBps: number
): UnsignedOrder {
  const account = getAccount();
  const makerAmount = BigInt(Math.ceil(usdcAmount * 10 ** USDC_DECIMALS));
  const shares = usdcAmount / pricePerShare;
  const takerAmount = BigInt(Math.ceil(shares * 10 ** USDC_DECIMALS));
  // Expire 60 seconds before market closes (in seconds, not ms)
  const expiration = BigInt(Math.floor((expirationTimestamp - 60000) / 1000));

  return {
    salt: generateSalt(),
    maker: account.address,
    signer: account.address,
    taker: ZERO_ADDRESS,
    tokenId,
    makerAmount,
    takerAmount,
    expiration,
    nonce: 0n,
    feeRateBps: BigInt(feeRateBps),
    side: LimitlessOrderSide.BUY,
    signatureType: LimitlessSignatureType.EOA,
  };
}

/**
 * Build an unsigned GTC SELL order.
 * GTC SELL: makerAmount = shares to sell (6 decimals), takerAmount = USDC to receive (6 decimals)
 */
function buildGtcSellOrder(
  tokenId: string,
  shares: number,
  pricePerShare: number,
  expirationTimestamp: number,
  feeRateBps: number
): UnsignedOrder {
  const account = getAccount();
  const makerAmount = BigInt(Math.ceil(shares * 10 ** USDC_DECIMALS));
  const usdcToReceive = shares * pricePerShare;
  const takerAmount = BigInt(Math.ceil(usdcToReceive * 10 ** USDC_DECIMALS));
  const expiration = BigInt(Math.floor((expirationTimestamp - 60000) / 1000));

  return {
    salt: generateSalt(),
    maker: account.address,
    signer: account.address,
    taker: ZERO_ADDRESS,
    tokenId,
    makerAmount,
    takerAmount,
    expiration,
    nonce: 0n,
    feeRateBps: BigInt(feeRateBps),
    side: LimitlessOrderSide.SELL,
    signatureType: LimitlessSignatureType.EOA,
  };
}

// =============================================
// EIP-712 signing
// =============================================

/**
 * Sign an order using EIP-712 typed data signing with viem.
 */
async function signOrder(
  order: UnsignedOrder,
  exchangeAddress: string
): Promise<`0x${string}`> {
  const account = getAccount();

  const signature = await account.signTypedData({
    domain: {
      name: LIMITLESS_EIP712_DOMAIN_NAME,
      version: LIMITLESS_EIP712_DOMAIN_VERSION,
      chainId: BASE_CHAIN_ID,
      verifyingContract: exchangeAddress as `0x${string}`,
    },
    types: EIP712_ORDER_TYPES,
    primaryType: "Order",
    message: {
      salt: order.salt,
      maker: order.maker,
      signer: order.signer,
      taker: order.taker,
      tokenId: BigInt(order.tokenId),
      makerAmount: order.makerAmount,
      takerAmount: order.takerAmount,
      expiration: order.expiration,
      nonce: order.nonce,
      feeRateBps: order.feeRateBps,
      side: order.side,
      signatureType: order.signatureType,
    },
  });

  return signature;
}

/**
 * Serialize an order for API submission.
 * Based on actual Limitless API validation:
 * - salt, makerAmount, takerAmount, nonce, feeRateBps → number
 * - expiration → string
 * - side, signatureType → number
 */
function serializeOrder(
  order: UnsignedOrder,
  signature: `0x${string}`
): Record<string, unknown> {
  return {
    salt: Number(order.salt),
    maker: order.maker,
    signer: order.signer,
    taker: order.taker,
    tokenId: order.tokenId,
    makerAmount: Number(order.makerAmount),
    takerAmount: Number(order.takerAmount),
    expiration: order.expiration.toString(),
    nonce: Number(order.nonce),
    feeRateBps: Number(order.feeRateBps),
    side: order.side,
    signatureType: order.signatureType,
    signature,
  };
}

// =============================================
// Public: Place hedge order
// =============================================

/**
 * Place a hedge order on Limitless Exchange.
 * Full flow: authenticate → approve USDC → build order → sign → submit.
 */
export async function placeHedgeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
  const { marketSlug, tokenId, side, usdcAmount, orderType, venueExchangeAddress } = params;

  log.info(`Placing ${orderType} ${side === LimitlessOrderSide.BUY ? "BUY" : "SELL"} order`, {
    marketSlug,
    tokenId: tokenId.substring(0, 10) + "...",
    usdcAmount,
  });

  // 1. Ensure authenticated
  await ensureAuthenticated();

  // 2. Ensure USDC approved (for BUY orders)
  if (side === LimitlessOrderSide.BUY) {
    await ensureUsdcApproval(venueExchangeAddress);
  }

  // 3. Get user profile for ownerId and feeRateBps
  const profile = getUserProfile();
  const ownerId = profile?.id ?? 0;
  const feeRateBps = profile?.rank?.feeRateBps ?? DEFAULT_FEE_RATE_BPS;

  // 4. Build order (FOK or GTC)
  let order: UnsignedOrder;
  if (orderType === LimitlessOrderType.GTC) {
    if (!params.pricePerShare || !params.expirationTimestamp) {
      throw new Error("GTC orders require pricePerShare and expirationTimestamp");
    }
    if (side === LimitlessOrderSide.BUY) {
      order = buildGtcBuyOrder(tokenId, usdcAmount, params.pricePerShare, params.expirationTimestamp, feeRateBps);
    } else {
      order = buildGtcSellOrder(tokenId, usdcAmount, params.pricePerShare, params.expirationTimestamp, feeRateBps);
    }
  } else {
    if (side === LimitlessOrderSide.BUY) {
      order = buildFokBuyOrder(tokenId, usdcAmount, feeRateBps);
    } else {
      order = buildFokSellOrder(tokenId, usdcAmount, feeRateBps);
    }
  }

  // 5. Sign order
  const signature = await signOrder(order, venueExchangeAddress);
  log.debug("Order signed");

  // 6. Submit to API (with retry for transient failures)
  const payload: NewOrderPayload = {
    order: serializeOrder(order, signature),
    orderType: orderType,
    marketSlug,
    ownerId,
  };

  const response = await withRetry(() => submitOrder(payload), {
    maxRetries: 2,
    baseDelayMs: 1000,
    maxDelayMs: 5000,
  });

  // 7. Parse result
  const orderId = response.order?.id ?? "unknown";
  const matched = (response.makerMatches?.length ?? 0) > 0;
  let filledSize = 0;
  let totalCost = 0;

  if (matched && response.makerMatches) {
    for (const match of response.makerMatches) {
      filledSize += parseFloat(match.matchedSize || "0");
    }
    totalCost = usdcAmount; // FOK: either full fill or nothing
  } else if (side === LimitlessOrderSide.BUY) {
    // FOK may have filled directly without makerMatches in some cases
    filledSize = usdcAmount > 0
      ? Math.floor(usdcAmount / 1) // approximate, will be refined by position tracking
      : 0;
    totalCost = usdcAmount;
  }

  const avgPrice = filledSize > 0 ? totalCost / filledSize : 0;

  log.info(`Order placed: ${orderId}`, { matched, filledSize, avgPrice, totalCost });

  return {
    orderId,
    filledSize,
    avgPrice,
    totalCost,
    matched,
  };
}
