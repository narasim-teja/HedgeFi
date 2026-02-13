// USDC on Base mainnet
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

// Agent names
export const HEDGEFI_AGENT_NAME = "HedgeFi";
export const TEST_BUYER_AGENT_NAME = "TestBuyer";

// =============================================
// ERC-20 ABI (minimal — balanceOf + decimals)
// =============================================
export const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

// =============================================
// Supported chains + RPC endpoints
// =============================================
export type SupportedChain = "base" | "ethereum" | "arbitrum";

export const CHAIN_CONFIG: Record<SupportedChain, { rpcUrl: string; chainId: number }> = {
  base: {
    rpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
    chainId: 8453,
  },
  ethereum: {
    rpcUrl: process.env.ETH_RPC_URL || "https://eth.llamarpc.com",
    chainId: 1,
  },
  arbitrum: {
    rpcUrl: process.env.ARB_RPC_URL || "https://arb1.arbitrum.io/rpc",
    chainId: 42161,
  },
};

// =============================================
// Token registry
// =============================================
export interface TokenInfo {
  symbol: string;
  decimals: number;
  addresses: Partial<Record<SupportedChain, `0x${string}`>>;
  coingeckoId: string;
  isStablecoin: boolean;
}

export const TOKENS: TokenInfo[] = [
  {
    symbol: "WETH",
    decimals: 18,
    addresses: {
      base: "0x4200000000000000000000000000000000000006",
      ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      arbitrum: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    },
    coingeckoId: "ethereum",
    isStablecoin: false,
  },
  {
    symbol: "USDC",
    decimals: 6,
    addresses: {
      base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    },
    coingeckoId: "usd-coin",
    isStablecoin: true,
  },
  {
    symbol: "USDT",
    decimals: 6,
    addresses: {
      base: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      ethereum: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      arbitrum: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    },
    coingeckoId: "tether",
    isStablecoin: true,
  },
  {
    symbol: "DAI",
    decimals: 18,
    addresses: {
      base: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
      ethereum: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      arbitrum: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    },
    coingeckoId: "dai",
    isStablecoin: true,
  },
  {
    symbol: "WBTC",
    decimals: 8,
    addresses: {
      ethereum: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      arbitrum: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    },
    coingeckoId: "wrapped-bitcoin",
    isStablecoin: false,
  },
  {
    symbol: "cbBTC",
    decimals: 8,
    addresses: {
      base: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    },
    coingeckoId: "wrapped-bitcoin",
    isStablecoin: false,
  },
  {
    symbol: "LINK",
    decimals: 18,
    addresses: {
      ethereum: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
      arbitrum: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
    },
    coingeckoId: "chainlink",
    isStablecoin: false,
  },
  {
    symbol: "UNI",
    decimals: 18,
    addresses: {
      ethereum: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
      arbitrum: "0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0",
    },
    coingeckoId: "uniswap",
    isStablecoin: false,
  },
  {
    symbol: "ARB",
    decimals: 18,
    addresses: {
      arbitrum: "0x912CE59144191C1204E64559FE8253a0e49E6548",
    },
    coingeckoId: "arbitrum",
    isStablecoin: false,
  },
  {
    symbol: "AAVE",
    decimals: 18,
    addresses: {
      ethereum: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
      arbitrum: "0xba5DdD1f9d7F570dc94a51479a000E3BCE967196",
    },
    coingeckoId: "aave",
    isStablecoin: false,
  },
];

// =============================================
// Convenience lookups
// =============================================
export const SYMBOL_TO_COINGECKO: Record<string, string> = Object.fromEntries(
  TOKENS.map((t) => [t.symbol, t.coingeckoId])
);
SYMBOL_TO_COINGECKO["ETH"] = "ethereum";

export const STABLECOIN_SYMBOLS = new Set(
  TOKENS.filter((t) => t.isStablecoin).map((t) => t.symbol)
);

// =============================================
// Limitless Exchange API
// =============================================

export const LIMITLESS_API_BASE_URL = "https://api.limitless.exchange";

/** Map portfolio token symbols to Limitless market tickers */
export const SYMBOL_TO_LIMITLESS_TICKER: Record<string, string> = {
  ETH: "ETH",
  WETH: "ETH",
  WBTC: "BTC",
  cbBTC: "BTC",
  LINK: "LINK",
  UNI: "UNI",
  ARB: "ARB",
  AAVE: "AAVE",
};

/** Risk tolerance to target drop percentage range for strike selection */
export const RISK_TOLERANCE_DROP_TARGETS: Record<string, number[]> = {
  conservative: [0.03, 0.05],
  moderate: [0.05, 0.10],
  aggressive: [0.10, 0.20],
};

/** Max percentage of budget for a single market */
export const MAX_SINGLE_MARKET_ALLOCATION = 0.50;

/** Minimum liquidity (USD) for a market to be considered */
export const MIN_MARKET_LIQUIDITY_USD = 10;

/** Minimum hedge budget to provide meaningful coverage */
export const MIN_HEDGE_BUDGET_USD = 5;

/** Market data cache TTL */
export const MARKET_CACHE_TTL_MS = 120_000;
