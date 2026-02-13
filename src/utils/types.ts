// =============================================
// hedge_analysis types
// =============================================

export interface HedgeAnalysisRequirement {
  wallet_address: string;
  chain: "base" | "ethereum" | "arbitrum";
  risk_tolerance: "conservative" | "moderate" | "aggressive";
  hedge_budget: number;
}

export interface TokenExposure {
  symbol: string;
  balance: string;
  value_usd: number;
  percentage: number;
}

export interface PortfolioExposure {
  total_value_usd: number;
  tokens: TokenExposure[];
  concentration_risk: "high" | "medium" | "low";
  top_exposure: string;
}

export interface HedgeRecommendation {
  market_id: string;
  market_question: string;
  action: "BUY_YES" | "BUY_NO";
  shares: number;
  estimated_cost_usd: number;
  coverage_usd: number;
  coverage_percentage: number;
  expiry: string;
}

export interface HedgeAnalysisDeliverable {
  exposure: PortfolioExposure;
  recommended_hedges: HedgeRecommendation[];
  total_hedge_cost: number;
  total_coverage: number;
  reasoning: string;
}

// =============================================
// execute_hedge types
// =============================================

export interface ExecuteHedgeRequirement {
  wallet_address: string;
  chain: "base" | "ethereum" | "arbitrum";
  risk_tolerance: "conservative" | "moderate" | "aggressive";
  hedge_budget_usdc: number;
}

export interface HedgePlaced {
  market_id: string;
  market_question: string;
  action: string;
  shares_bought: number;
  price_per_share: number;
  total_cost_usd: number;
  max_payout_usd: number;
  order_id: string;
  tx_hash: string;
  expiry: string;
  expiry_human?: string;
  market_slug?: string;
}

export interface ExecuteHedgeDeliverable {
  exposure: PortfolioExposure;
  hedges_placed: HedgePlaced[];
  summary: {
    total_spent: number;
    total_max_coverage: number;
    budget_remaining: number;
    coverage_ratio: string;
    undeployed_usdc?: number;
    deployment_ratio?: string;
    redistribution_rounds?: number;
  };
  reasoning: string;
}

// =============================================
// close_hedge types
// =============================================

export interface CloseHedgeRequirement {
  position_ids?: string[];
  close_all?: boolean;
}

export interface PositionClosed {
  market_id: string;
  shares_sold: number;
  sale_price: number;
  realized_pnl: number;
}

export interface CloseHedgeDeliverable {
  positions_closed: PositionClosed[];
  total_returned_usdc: number;
  return_tx_hash: string;
  reasoning?: string;
}

// =============================================
// Limitless Exchange types
// =============================================

/** Raw market data as returned by Limitless API /markets/active */
export interface LimitlessMarketRaw {
  id: number;
  slug: string;
  title: string;
  description?: string;
  collateralToken: {
    address: string;
    decimals: number;
    symbol: string;
  };
  expirationTimestamp: number; // milliseconds
  tokens: {
    yes: string;
    no: string;
  };
  prices: [number, number]; // [yesPrice, noPrice]
  venue?: {
    exchange: string;
    adapter: string | null;
  };
  priceOracleMetadata?: {
    ticker: string;
    assetType: string;
    pythAddress?: string;
    symbol?: string;
    name?: string;
  };
  metadata?: {
    fee: boolean;
    openPrice?: string; // strike price as string
  };
  volume?: string;
  volumeFormatted?: string;
  liquidity?: number | null;
  tradeType?: string;
  marketType?: string;
  status?: string;
  expired?: boolean;
}

/** Metadata from /markets/active/slugs endpoint */
export interface LimitlessMarketSlug {
  slug: string;
  strikePrice: string | null;
  ticker: string | null;
  deadline: string | null;
  markets?: { slug: string }[];
}

/** Orderbook snapshot from /markets/{slug}/orderbook */
export interface LimitlessOrderbook {
  adjustedMidpoint: number;
  asks: Array<{ price: number; size: number }>;
  bids: Array<{ price: number; size: number }>;
  lastTradePrice: number;
  maxSpread: number;
  minSize: number;
  tokenId: string;
}

/** Active markets API response wrapper */
export interface LimitlessActiveMarketsResponse {
  data: LimitlessMarketRaw[];
  totalMarketsCount: number;
}

/** A market enriched with hedging-relevant metadata and scores */
export interface ScoredLimitlessMarket {
  raw: LimitlessMarketRaw;
  slug: string;
  title: string;
  ticker: string;
  strikePrice: number | null;
  direction: "below" | "above";
  expirationDate: Date;
  yesPriceUsd: number;
  noPriceUsd: number;
  hedgeAction: "BUY_YES" | "BUY_NO";
  hedgeScore: number;
  liquidityUsd: number;
  maxFillableShares: number;
  payoutRatio: number;
}

// =============================================
// Limitless Order types (Phase 4)
// =============================================

export enum LimitlessOrderSide {
  BUY = 0,
  SELL = 1,
}

export enum LimitlessOrderType {
  FOK = "FOK",
  GTC = "GTC",
}

export enum LimitlessSignatureType {
  EOA = 0,
}

export interface UnsignedOrder {
  salt: bigint;
  maker: `0x${string}`;
  signer: `0x${string}`;
  taker: `0x${string}`;
  tokenId: string;
  makerAmount: bigint;
  takerAmount: bigint;
  expiration: bigint;
  nonce: bigint;
  feeRateBps: bigint;
  side: LimitlessOrderSide;
  signatureType: LimitlessSignatureType;
}

export interface SignedOrder extends UnsignedOrder {
  signature: `0x${string}`;
}

export interface NewOrderPayload {
  order: Record<string, unknown>;
  orderType: LimitlessOrderType;
  marketSlug: string;
  ownerId: number;
}

export interface LimitlessOrderResponse {
  order: {
    id: string;
    createdAt: string;
    price: number | null;
    side: number;
    makerAmount: number;
    takerAmount: number;
    tokenId: string;
    marketId: number;
  };
  makerMatches?: Array<{
    id: string;
    matchedSize: string;
    orderId: string;
  }>;
}

export interface LimitlessUserProfile {
  id: number;
  account: string;
  displayName?: string;
  rank?: {
    feeRateBps: number;
  };
}

export interface AllowanceResponse {
  allowance: string;
  hasMinimumAllowance: boolean;
  type: "clob" | "negrisk";
  spender: string;
  checkedAddress: string;
}

export interface PortfolioPositionsResponse {
  clob: LimitlessApiPosition[];
  amm: unknown[];
  accumulativePoints: number;
}

export interface LimitlessApiPosition {
  marketSlug: string;
  marketTitle: string;
  tokenId: string;
  outcomeIndex: number;
  shares: number;
  avgPrice: number;
  currentPrice: number;
  pnl: number;
  value: number;
}

/** Params for placing a hedge order */
export interface PlaceOrderParams {
  marketSlug: string;
  tokenId: string;
  side: LimitlessOrderSide;
  usdcAmount: number;
  orderType: LimitlessOrderType;
  venueExchangeAddress: string;
  /** Required for GTC orders: price per share in USD */
  pricePerShare?: number;
  /** Required for GTC orders: market expiration timestamp in ms */
  expirationTimestamp?: number;
}

/** Result of a placed order */
export interface PlaceOrderResult {
  orderId: string;
  filledSize: number;
  avgPrice: number;
  totalCost: number;
  matched: boolean;
}

// =============================================
// Database position types (Phase 4)
// =============================================

export interface DbPosition {
  id: string;
  job_id: string;
  buyer_address: string;
  market_slug: string;
  market_title: string;
  token_id: string;
  side: string;
  action: string;
  shares: number;
  entry_price: number;
  total_cost_usdc: number;
  order_id: string;
  status: string;
  expiry: string;
  venue_exchange: string;
  created_at: string;
  closed_at: string | null;
  close_price: number | null;
  realized_pnl: number | null;
}

export interface CreatePositionParams {
  jobId: string;
  buyerAddress: string;
  marketSlug: string;
  marketTitle: string;
  tokenId: string;
  side: string;
  action: string;
  shares: number;
  entryPrice: number;
  totalCostUsdc: number;
  orderId: string;
  expiry: string;
  venueExchange: string;
}

export interface ClosingData {
  closePrice: number;
  realizedPnl: number;
}

// =============================================
// Generic
// =============================================

export type JobName = "hedge_analysis" | "execute_hedge" | "close_hedge";

// =============================================
// Job state types (Phase 6.5)
// =============================================

export interface JobState {
  job_id: string;
  job_name: string;
  phase: JobInternalPhase;
  confirmation_sent: number; // 0 or 1
  confirmation_payload: string | null;
  buyer_address: string | null;
  created_at: string;
  updated_at: string;
}

export type JobInternalPhase =
  | "initialized"
  | "analysis_complete"
  | "awaiting_confirmation"
  | "confirmed"
  | "executing"
  | "delivered"
  | "failed";

// =============================================
// Confirmation flow types (Phase 6.5)
// =============================================

export interface HedgePlanConfirmation {
  exposure: PortfolioExposure;
  recommendations: HedgeRecommendation[];
  diagnostics_message: string | null;
  estimated_total_cost: number;
  estimated_total_coverage: number;
  coverage_ratio: string;
  budget: number;
  risk_tolerance: string;
  market_details: Array<{
    market_question: string;
    action: "BUY_YES" | "BUY_NO";
    estimated_shares: number;
    estimated_cost_usd: number;
    max_payout_usd: number;
    expiry: string;
    expiry_human: string;
    market_slug: string;
  }>;
}

export interface ClosePlanConfirmation {
  positions: Array<{
    position_id: string;
    market_title: string;
    side: string;
    shares: number;
    entry_price: number;
    total_cost_usdc: number;
    estimated_current_value: number;
    estimated_pnl: number;
    expiry: string;
  }>;
  total_estimated_return: number;
  total_estimated_pnl: number;
}
