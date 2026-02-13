/**
 * Debug script: inspects positions from both local DB and on-chain state.
 *
 * Usage:
 *   bun run scripts/check-positions.ts          # show all (DB + on-chain)
 *   bun run scripts/check-positions.ts active    # active only
 *   bun run scripts/check-positions.ts closed    # closed/historical only
 *   bun run scripts/check-positions.ts orders    # recent order history
 *   bun run scripts/check-positions.ts onchain   # on-chain only (Limitless API + CT balances)
 */
import { Database } from "bun:sqlite";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import {
  LIMITLESS_API_BASE_URL,
  LIMITLESS_CT_CONTRACT,
  USDC_BASE,
  CHAIN_CONFIG,
  ERC20_ABI,
} from "../src/utils/constants.ts";

const filter = process.argv[2] ?? "all";

// =============================================
// On-chain helpers
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

function getAccount() {
  const pk = process.env.HEDGEFI_PRIVATE_KEY;
  if (!pk) throw new Error("HEDGEFI_PRIVATE_KEY not set");
  return privateKeyToAccount(pk as `0x${string}`);
}

function getPublicClient() {
  return createPublicClient({
    chain: base,
    transport: http(CHAIN_CONFIG.base.rpcUrl),
  });
}

// =============================================
// Limitless API auth (standalone — doesn't import agent modules)
// =============================================

interface ClobPositionSide {
  cost: string;
  fillPrice: string;
  marketValue: string;
  unrealizedPnl: string;
}

interface ClobEntry {
  market: {
    slug: string;
    title: string;
    status: string;
    closed: boolean;
    winningOutcomeIndex: number | null;
    expirationDate: string;
  };
  positions: { yes: ClobPositionSide; no: ClobPositionSide };
  tokensBalance: { yes: string; no: string };
  latestTrade: { latestYesPrice: number; latestNoPrice: number };
}

interface LimitlessPortfolio {
  clob: ClobEntry[];
  amm: unknown[];
  accumulativePoints: number;
}

async function authenticateAndFetchPortfolio(): Promise<unknown> {
  const account = getAccount();
  const address = account.address;

  // Step 1: Get signing message
  const signingMsgRes = await fetch(`${LIMITLESS_API_BASE_URL}/auth/signing-message`, {
    headers: { Accept: "application/json" },
  });
  if (!signingMsgRes.ok) throw new Error(`Failed to get signing message: ${signingMsgRes.status}`);
  const rawMsg = await signingMsgRes.text();
  const cleanMsg = rawMsg.replace(/^"|"$/g, "");

  // Step 2: Sign
  const signature = await account.signMessage({ message: cleanMsg });

  // Step 3: Login
  const messageHex = "0x" + Buffer.from(cleanMsg, "utf-8").toString("hex");
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
  if (!loginRes.ok) throw new Error(`Login failed: ${loginRes.status}`);

  const setCookie = loginRes.headers.get("set-cookie");
  const cookieMatch = setCookie?.match(/limitless_session=([^;]+)/);
  const sessionCookie = cookieMatch?.[1] ?? setCookie?.split(";")?.[0] ?? "";

  // Step 4: Fetch portfolio positions
  const portfolioRes = await fetch(`${LIMITLESS_API_BASE_URL}/portfolio/positions`, {
    headers: {
      Accept: "application/json",
      Cookie: `limitless_session=${sessionCookie}`,
    },
  });
  if (!portfolioRes.ok) throw new Error(`Portfolio fetch failed: ${portfolioRes.status}`);
  return portfolioRes.json() as Promise<LimitlessPortfolio>;
}

// =============================================
// DB section
// =============================================

let db: Database;
try {
  db = new Database("hedgefi.sqlite", { readonly: true });
} catch (err) {
  console.error("Failed to open hedgefi.sqlite — is the agent running in this directory?");
  console.error(err);
  process.exit(1);
}

if (filter !== "onchain") {
  const stats = db.query(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed,
      SUM(CASE WHEN status = 'close_failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as won,
      SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) as lost,
      SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired,
      ROUND(SUM(total_cost_usdc), 4) as total_invested,
      ROUND(SUM(CASE WHEN realized_pnl IS NOT NULL THEN realized_pnl ELSE 0 END), 4) as total_pnl
    FROM positions
  `).get() as Record<string, unknown>;

  console.log("\n=== Position Summary (DB) ===");
  console.table(stats);

  if (filter === "all" || filter === "active") {
    const active = db.query(
      "SELECT id, market_slug, side, shares, entry_price, total_cost_usdc, status, expiry, created_at FROM positions WHERE status = 'active' ORDER BY created_at DESC"
    ).all();
    console.log(`\n=== Active Positions (${active.length}) ===`);
    if (active.length > 0) {
      console.table(active);
    } else {
      console.log("  No active positions.");
    }
  }

  if (filter === "all" || filter === "closed") {
    const closed = db.query(
      "SELECT id, market_slug, side, shares, entry_price, close_price, total_cost_usdc, realized_pnl, status, closed_at FROM positions WHERE status != 'active' ORDER BY closed_at DESC"
    ).all();
    console.log(`\n=== Historical Positions (${closed.length}) ===`);
    if (closed.length > 0) {
      console.table(closed);
    } else {
      console.log("  No historical positions.");
    }
  }

  if (filter === "all" || filter === "orders") {
    const orders = db.query(
      "SELECT id, position_id, order_type, market_slug, side, price, filled_size, order_id, status, created_at FROM order_history ORDER BY created_at DESC LIMIT 20"
    ).all();
    console.log(`\n=== Recent Orders (last 20) ===`);
    if (orders.length > 0) {
      console.table(orders);
    } else {
      console.log("  No orders recorded.");
    }
  }
}

// =============================================
// On-chain section
// =============================================

if (filter === "all" || filter === "onchain" || filter === "active") {
  console.log("\n=== On-Chain State ===");

  const account = getAccount();
  const publicClient = getPublicClient();

  // USDC balance
  try {
    const usdcBalance = await publicClient.readContract({
      address: USDC_BASE,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    }) as bigint;
    const usdcHuman = Number(usdcBalance) / 1e6;
    console.log(`\nAgent wallet: ${account.address}`);
    console.log(`USDC balance: $${usdcHuman.toFixed(6)}`);
  } catch (err) {
    console.error("Failed to read USDC balance:", err);
  }

  // On-chain CT balances for active/failed DB positions
  interface DbPosRow {
    id: string;
    market_slug: string;
    token_id: string;
    shares: number;
    total_cost_usdc: number;
    status: string;
  }

  const dbPositions = db.query(
    "SELECT id, market_slug, token_id, shares, total_cost_usdc, status FROM positions WHERE status IN ('active', 'close_failed') ORDER BY created_at DESC"
  ).all() as DbPosRow[];

  if (dbPositions.length > 0) {
    console.log(`\n--- CT Balances for ${dbPositions.length} active/failed positions ---`);

    interface CtRow {
      id: string;
      market: string;
      status: string;
      db_shares: number;
      onchain_raw: string;
      match: string;
    }

    const ctRows: CtRow[] = [];

    for (const pos of dbPositions) {
      try {
        const balance = await publicClient.readContract({
          address: LIMITLESS_CT_CONTRACT as `0x${string}`,
          abi: ERC1155_BALANCE_ABI,
          functionName: "balanceOf",
          args: [account.address, BigInt(pos.token_id)],
        }) as bigint;

        const onchainRaw = Number(balance);
        const matches = onchainRaw === pos.shares ? "YES" : `NO (diff: ${onchainRaw - pos.shares})`;

        ctRows.push({
          id: pos.id.slice(-10),
          market: pos.market_slug.slice(0, 40) + "...",
          status: pos.status,
          db_shares: pos.shares,
          onchain_raw: onchainRaw.toString(),
          match: matches,
        });
      } catch (err) {
        ctRows.push({
          id: pos.id.slice(-10),
          market: pos.market_slug.slice(0, 40) + "...",
          status: pos.status,
          db_shares: pos.shares,
          onchain_raw: "ERROR",
          match: String(err).slice(0, 40),
        });
      }
    }
    console.table(ctRows);
  } else {
    console.log("  No active/failed positions to check on-chain.");
  }

  // Limitless API portfolio
  try {
    console.log("\n--- Limitless API Portfolio ---");
    const portfolio = await authenticateAndFetchPortfolio() as LimitlessPortfolio;
    const entries = portfolio.clob ?? [];

    if (entries.length > 0) {
      const apiRows = entries.map((e) => {
        const noTokens = parseInt(e.tokensBalance.no) || 0;
        const yesTokens = parseInt(e.tokensBalance.yes) || 0;
        const hasNo = noTokens > 0;
        const side = hasNo ? "NO" : "YES";
        const tokens = hasNo ? noTokens : yesTokens;
        const pos = hasNo ? e.positions.no : e.positions.yes;
        const cost = parseInt(pos.cost) / 1e6;
        const marketValue = parseInt(pos.marketValue) / 1e6;
        const unrealizedPnl = parseInt(pos.unrealizedPnl) / 1e6;

        return {
          market: e.market.slug.slice(0, 45),
          status: e.market.closed ? "RESOLVED" : "ACTIVE",
          side,
          tokens,
          cost_usdc: `$${cost.toFixed(4)}`,
          mkt_value: `$${marketValue.toFixed(4)}`,
          pnl: `$${unrealizedPnl.toFixed(4)}`,
          winner: e.market.winningOutcomeIndex !== null
            ? (e.market.winningOutcomeIndex === 0 ? "YES" : "NO")
            : "-",
        };
      });
      console.log(`Markets with positions: ${entries.length}`);
      console.table(apiRows);

      let totalCost = 0;
      let totalValue = 0;
      for (const e of entries) {
        const noVal = parseInt(e.positions.no.marketValue) || 0;
        const yesVal = parseInt(e.positions.yes.marketValue) || 0;
        const noCost = parseInt(e.positions.no.cost) || 0;
        const yesCost = parseInt(e.positions.yes.cost) || 0;
        totalValue += (noVal + yesVal);
        totalCost += (noCost + yesCost);
      }
      console.log(`Total cost:  $${(totalCost / 1e6).toFixed(4)}`);
      console.log(`Total value: $${(totalValue / 1e6).toFixed(4)}`);
      console.log(`Total P&L:   $${((totalValue - totalCost) / 1e6).toFixed(4)}`);
    } else {
      console.log("  No positions on Limitless.");
    }
  } catch (err) {
    console.error("Failed to fetch Limitless portfolio:", err);
  }
}

db.close();
