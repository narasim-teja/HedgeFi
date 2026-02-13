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
}

export interface ExecuteHedgeDeliverable {
  exposure: PortfolioExposure;
  hedges_placed: HedgePlaced[];
  summary: {
    total_spent: number;
    total_max_coverage: number;
    budget_remaining: number;
    coverage_ratio: string;
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
// Generic
// =============================================

export type JobName = "hedge_analysis" | "execute_hedge" | "close_hedge";
