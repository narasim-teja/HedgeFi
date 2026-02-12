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
// Generic
// =============================================

export type JobName = "hedge_analysis" | "execute_hedge" | "close_hedge";
