import {
  createPublicClient,
  http,
  formatUnits,
  type PublicClient,
  type Address,
} from "viem";
import { base, mainnet, arbitrum } from "viem/chains";
import { createLogger } from "../utils/logger.ts";
import {
  TOKENS,
  ERC20_ABI,
  CHAIN_CONFIG,
  type SupportedChain,
} from "../utils/constants.ts";

const log = createLogger("portfolio-reader");

const VIEM_CHAINS = {
  base,
  ethereum: mainnet,
  arbitrum,
} as const;

export interface RawTokenBalance {
  symbol: string;
  balance: bigint;
  decimals: number;
  formatted: string;
  coingeckoId: string;
  isStablecoin: boolean;
}

const clientCache = new Map<SupportedChain, PublicClient>();

function getClient(chain: SupportedChain): PublicClient {
  let client = clientCache.get(chain);
  if (!client) {
    const config = CHAIN_CONFIG[chain];
    client = createPublicClient({
      chain: VIEM_CHAINS[chain],
      transport: http(config.rpcUrl),
      batch: { multicall: true },
    }) as PublicClient;
    clientCache.set(chain, client);
  }
  return client;
}

export async function readWalletBalances(
  walletAddress: string,
  chain: SupportedChain
): Promise<RawTokenBalance[]> {
  const address = walletAddress as Address;
  const client = getClient(chain);
  const results: RawTokenBalance[] = [];

  log.info(`Reading balances for ${walletAddress} on ${chain}`);

  // Read native ETH/gas token balance
  try {
    const nativeBalance = await client.getBalance({ address });
    if (nativeBalance > 0n) {
      results.push({
        symbol: "ETH",
        balance: nativeBalance,
        decimals: 18,
        formatted: formatUnits(nativeBalance, 18),
        coingeckoId: "ethereum",
        isStablecoin: false,
      });
    }
  } catch (err) {
    log.error("Failed to read native balance", err);
  }

  // Filter tokens that have addresses on this chain
  const tokensForChain = TOKENS.filter(
    (t) => t.addresses[chain] !== undefined
  );

  if (tokensForChain.length === 0) {
    log.info(`No ERC-20 tokens configured for chain ${chain}`);
    return results;
  }

  // Batch balanceOf calls via multicall
  try {
    const contracts = tokensForChain.map((token) => ({
      address: token.addresses[chain]! as Address,
      abi: ERC20_ABI,
      functionName: "balanceOf" as const,
      args: [address] as const,
    }));

    const multicallResults = await client.multicall({ contracts });

    for (let i = 0; i < tokensForChain.length; i++) {
      const token = tokensForChain[i]!;
      const result = multicallResults[i]!;

      if (result.status === "success") {
        const balance = result.result as bigint;
        if (balance > 0n) {
          results.push({
            symbol: token.symbol,
            balance,
            decimals: token.decimals,
            formatted: formatUnits(balance, token.decimals),
            coingeckoId: token.coingeckoId,
            isStablecoin: token.isStablecoin,
          });
        }
      } else {
        log.warn(`Failed to read ${token.symbol} balance`);
      }
    }
  } catch (err) {
    log.error("Multicall failed", err);
  }

  log.info(`Found ${results.length} tokens with non-zero balances`);
  return results;
}
