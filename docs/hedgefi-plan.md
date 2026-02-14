# HedgeFi — Autonomous Portfolio Hedging Agent

> The first agent on Virtuals ACP that autonomously hedges crypto portfolios using prediction market positions on Limitless Exchange. No frontend needed — Butler IS the interface.

---

## Why This Wins

**Zero competition.** Butler search for "hedge my portfolio" returns monitoring agents and manual execution tools — nothing that actually constructs hedges. HedgeFi is the missing piece.

**Recurring revenue by design.** Limitless markets expire hourly/daily. Users who want ongoing protection keep paying. Every ACP job = payment.

**Perfect ACP v2 fit.** Virtuals literally has a prediction market use case guide with Fund-Transfer Jobs, Resources, and Place Bet flows. HedgeFi maps directly onto this pattern.

**Both chains aligned.** Limitless Exchange and Virtuals ACP both live on Base. Zero bridging, zero friction.

---

## Product Overview

### What It Does

User tells Butler: *"Hedge my ETH holdings"* or *"Protect my portfolio at 0xABC..."*

HedgeFi:
1. Reads the target wallet (user's own or any external address they specify)
2. Calculates token exposure (which assets, how concentrated, how volatile)
3. Scans Limitless Exchange for relevant price prediction markets
4. Buys YES/NO shares that pay out if the user's holdings drop in value
5. Returns a structured hedge report with positions, cost, coverage estimate, and AI reasoning

### Why Prediction Markets = Synthetic Options

| Feature | Traditional Options | Prediction Markets (Limitless) |
|---|---|---|
| Payoff | Complex (Greeks, strike, expiry) | Binary: $1 if correct, $0 if wrong |
| Liquidation risk | Yes (margin calls) | No — premium is max loss |
| Margin required | Yes | No — pay upfront |
| Duration | Fixed expiry cycles | Hourly / daily (perfect for rolling hedges) |
| Cost | Often expensive | Cheap — if "ETH below $2500" is unlikely, YES shares cost ~$0.10 |
| Complexity | Need options knowledge | Just "will price go up or down?" |

**Example hedge**: User holds 2 ETH (~$5,000). Limitless has a market "Will ETH close below $2,400 today?" with YES shares at $0.12. HedgeFi buys 200 YES shares for $24. If ETH drops below $2,400, those shares pay $200 — offsetting the portfolio loss. If ETH stays above $2,400, user loses only the $24 premium. That's a 4.8% cost for ~$200 of downside protection.

---

## Architecture

### Three Wallets

| Wallet | Owner | Chain | Purpose |
|---|---|---|---|
| User's wallet | Human user | Any EVM | Holds portfolio. Funds Butler. Can also be an external address to monitor. |
| Butler agent wallet | Virtuals Butler | Base | Intermediary. Routes USDC from user to ACP escrow. |
| HedgeFi agent wallet | Us (we control the private key) | Base | Receives USDC from ACP escrow. Signs Limitless EIP-712 orders. Holds hedge positions. |

### Signature Flow — Who Signs What

```
USER (signs once)          → Funds Butler wallet with USDC
BUTLER (auto-signs)        → Creates ACP Job, deposits to escrow (service fee + hedge budget)
ACP ESCROW (smart contract) → Holds funds trustlessly
HEDGEFI (our key signs)    → Accepts job, receives funds from escrow
HEDGEFI (our key signs)    → Signs EIP-712 orders on Limitless Exchange
HEDGEFI (our key signs)    → Delivers hedge report via ACP DeliverableMemo
BUTLER/EVALUATOR (signs)   → Approves deliverable, releases service fee
```

**Critical insight**: The user NEVER gives us their private key. We read their wallet balances via public RPC calls (`balanceOf`). We trade on Limitless with OUR agent wallet using THEIR deposited USDC. We track which positions belong to which user via ACP Accounts.

### End-to-End Flow

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│   User   │───▶│  Butler  │───▶│   ACP    │───▶│ HedgeFi  │───▶│Limitless │
│          │    │          │    │  Escrow  │    │  Agent   │    │ Exchange │
│ "Hedge   │    │ Creates  │    │ Holds    │    │ Analyzes │    │ EIP-712  │
│  my ETH" │    │ Fund-    │    │ USDC     │    │ wallet,  │    │ orders   │
│          │    │ Transfer │    │ until    │    │ picks    │    │ on Base  │
│ or:      │    │ Job      │    │ delivery │    │ markets, │    │          │
│ "Protect │    │          │    │          │    │ places   │    │ YES/NO   │
│  0xABC"  │    │          │    │          │    │ hedges   │    │ shares   │
└──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
```

---

## ACP Integration (Detailed)

### Agent Registration

Register HedgeFi on the ACP Service Registry at https://app.virtuals.io/acp with:
- **Agent Name**: HedgeFi
- **Role**: Provider (Seller)
- **Business Description**: Autonomous portfolio hedging agent using prediction markets
- **Agent Type**: ON-CHAIN

### Job Offerings

HedgeFi exposes **3 Job Offerings** on ACP:

#### Job 1: `hedge_analysis` (Service-Only Job)

Read-only portfolio analysis + hedge recommendations. No funds transferred.

```
Job Name: hedge_analysis
Description: Analyze wallet exposure and recommend prediction market hedges
Price: $0.10 USDC
SLA: 2 minutes
Fund Transfer: false

Requirements Schema:
{
  wallet_address: string,      // "0x..." — wallet to analyze (user's own OR external)
  chain: string,               // "base" | "ethereum" | "arbitrum" — which chain to read
  risk_tolerance: string,      // "conservative" | "moderate" | "aggressive"
  hedge_budget: number         // how much USDC they'd be willing to spend on hedges
}

Deliverable Schema:
{
  exposure: {
    total_value_usd: number,
    tokens: [{ symbol, balance, value_usd, percentage }],
    concentration_risk: string,  // "high" | "medium" | "low"
    top_exposure: string         // "70% in ETH"
  },
  recommended_hedges: [{
    market_id: string,           // Limitless market ID
    market_question: string,     // "Will ETH close below $2400?"
    action: "BUY_YES" | "BUY_NO",
    shares: number,
    estimated_cost_usd: number,
    coverage_usd: number,        // max payout if hedge triggers
    coverage_percentage: number,  // % of downside covered
    expiry: string
  }],
  total_hedge_cost: number,
  total_coverage: number,
  reasoning: string              // Gemini-generated plain English explanation
}
```

#### Job 2: `execute_hedge` (Fund-Transfer Job)

Full execution — analyzes wallet AND places hedge positions on Limitless.

```
Job Name: execute_hedge
Description: Analyze wallet and autonomously place hedge positions on Limitless
Price: $0.50 USDC (service fee)
SLA: 5 minutes
Fund Transfer: true            // ← This is key — buyer sends USDC for hedging

Requirements Schema:
{
  wallet_address: string,      // wallet to protect
  chain: string,
  risk_tolerance: string,
  hedge_budget_usdc: number    // USDC amount to use for buying prediction market shares
}

Deliverable Schema:
{
  exposure: { ... },           // same as hedge_analysis
  hedges_placed: [{
    market_id: string,
    market_question: string,
    action: string,
    shares_bought: number,
    price_per_share: number,
    total_cost_usd: number,
    max_payout_usd: number,
    order_id: string,          // Limitless order ID
    tx_hash: string,           // on-chain tx if applicable
    expiry: string
  }],
  summary: {
    total_spent: number,
    total_max_coverage: number,
    budget_remaining: number,
    coverage_ratio: string     // "Protecting ~40% of your $5,000 ETH exposure"
  },
  reasoning: string
}
```

#### Job 3: `close_hedge` (Fund-Transfer Job)

Sell/redeem existing hedge positions and return funds to buyer.

```
Job Name: close_hedge
Description: Close existing hedge positions and return funds
Price: $0.25 USDC
SLA: 5 minutes
Fund Transfer: true

Requirements Schema:
{
  position_ids: string[],      // which positions to close (from Resource query)
  // OR
  close_all: boolean           // close everything
}

Deliverable Schema:
{
  positions_closed: [{
    market_id: string,
    shares_sold: number,
    sale_price: number,
    realized_pnl: number
  }],
  total_returned_usdc: number, // USDC sent back to buyer
  return_tx_hash: string
}
```

### Resource Offerings

HedgeFi exposes **2 Resources** — free, read-only endpoints that Butler/agents can query anytime:

#### Resource 1: `available_markets`

Live prediction markets currently available for hedging on Limitless.

```
Resource Name: available_markets
Description: Browse available Limitless prediction markets for hedging

Query Schema:
{
  asset: string                // "ETH" | "BTC" | "SOL" | "all"
}

Response Schema:
{
  markets: [{
    market_id: string,
    question: string,          // "Will ETH close above $2800 today?"
    outcomes: ["Yes", "No"],
    current_prices: { yes: number, no: number },
    volume_24h: number,
    liquidity: number,
    expiry: string,
    hedging_utility: string    // "Good for protecting ETH longs"
  }]
}
```

#### Resource 2: `active_positions`

Query a user's active hedge positions held by HedgeFi.

```
Resource Name: active_positions
Description: View your active hedge positions and their current P&L

Query Schema:
{
  buyer_wallet: string         // the buyer's ACP wallet address
}

Response Schema:
{
  positions: [{
    market_id: string,
    market_question: string,
    side: "YES" | "NO",
    shares: number,
    entry_price: number,
    current_price: number,
    unrealized_pnl: number,
    max_payout: number,
    expiry: string,
    status: "active" | "won" | "lost" | "expired"
  }],
  total_invested: number,
  total_current_value: number,
  total_pnl: number
}
```

### ACP Account (Per-User State)

For each buyer, HedgeFi maintains an ACP Account storing:
- Buyer's wallet address (the one being hedged)
- Active Limitless positions held on their behalf
- Historical P&L
- Preferred risk tolerance
- Proof-of-custody: which shares in HedgeFi's wallet belong to this buyer

This follows ACP v2's Account pattern for fund-transfer agents: *"separate hot wallets for individual Buyers and include this under Accounts as proof of fund holdings."*

### Evaluation

HedgeFi uses **self-evaluation** for `hedge_analysis` (service-only, low stakes).

For `execute_hedge` and `close_hedge` (fund-transfer jobs), the evaluation verifies:
- Positions were actually placed on Limitless (verify via Limitless API)
- Cost matches what was reported
- No slippage beyond tolerance
- Funds not misallocated

In sandbox, we use self-evaluation. For production, an external evaluator can verify on-chain position data.

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Runtime | **Bun** | Fast TS runtime |
| ACP SDK | **@virtuals-protocol/acp-node** | AcpClient, AcpContractClientV2, job lifecycle |
| Limitless | **limitless-exchange-ts-sdk** | Type-safe CLOB + NegRisk market access, EIP-712 order signing |
| Wallet Reading | **viem** | Multicall `balanceOf` across tokens on Base/ETH/Arb |
| Price Data | **CoinGecko API** (free tier) | Token prices for exposure calculation |
| AI Reasoning | **Gemini 2.5 Flash** (`@google/genai`) | Hedge strategy reasoning + plain English explanations |
| Chain | **Base** | Both ACP and Limitless live here |
| State | **bun:sqlite** | Track positions per user, job history, P&L |

---

## Repo Structure

```
hedgefi/
├── package.json
├── .env.example
├── .env
├── tsconfig.json
│
├── src/
│   ├── index.ts              # Entry point — init ACP client, start agent loop
│   ├── acp/
│   │   ├── client.ts         # AcpClient init + config
│   │   ├── handlers.ts       # onNewTask dispatcher — routes to correct job handler
│   │   ├── jobs/
│   │   │   ├── hedge-analysis.ts   # hedge_analysis job handler
│   │   │   ├── execute-hedge.ts    # execute_hedge job handler (fund-transfer)
│   │   │   └── close-hedge.ts      # close_hedge job handler (fund-transfer)
│   │   └── resources/
│   │       ├── available-markets.ts # Resource: live Limitless markets
│   │       └── active-positions.ts  # Resource: user's hedge positions
│   │
│   ├── limitless/
│   │   ├── client.ts         # Limitless SDK wrapper — auth, order signing
│   │   ├── markets.ts        # Scan/filter markets relevant for hedging
│   │   ├── orders.ts         # Place buy orders (EIP-712 signed)
│   │   └── positions.ts      # Track positions, check resolution status
│   │
│   ├── portfolio/
│   │   ├── reader.ts         # Read wallet balances via viem multicall
│   │   ├── analyzer.ts       # Calculate exposure, concentration risk
│   │   └── pricer.ts         # Token price lookups (CoinGecko)
│   │
│   ├── hedging/
│   │   ├── strategy.ts       # Core hedging logic — match exposure to markets
│   │   ├── sizing.ts         # Position sizing based on budget + risk tolerance
│   │   └── reasoning.ts      # Gemini integration for hedge explanations
│   │
│   ├── db/
│   │   ├── schema.ts         # SQLite schema (positions, users, jobs)
│   │   ├── positions.ts      # CRUD for tracking positions per user
│   │   └── users.ts          # CRUD for user accounts/preferences
│   │
│   └── utils/
│       ├── constants.ts      # Contract addresses, chain configs, token lists
│       ├── types.ts          # All TypeScript types
│       └── logger.ts         # Structured logging
│
├── scripts/
│   ├── test-buyer.ts         # Test buyer agent that initiates jobs against HedgeFi
│   ├── seed-markets.ts       # Pre-check available Limitless markets
│   └── check-positions.ts    # Debug script to check position status
│
└── README.md
```

---

## Phase-by-Phase Build Plan

### Phase 1: ACP Agent Scaffold + Registration

**Goal**: HedgeFi agent is live on ACP sandbox, can accept jobs.

**Steps**:

1. Init Bun project, install deps:
   ```bash
   bun init
   bun add @virtuals-protocol/acp-node viem @google/genai
   ```
2. Register TWO agents on ACP Service Registry (https://app.virtuals.io/acp):
   - **HedgeFi** (seller/provider): the actual agent
   - **TestBuyer** (buyer): for testing against HedgeFi
3. Whitelist wallets for both agents on the Service Registry
4. Implement `src/acp/client.ts`:
   ```typescript
   import AcpClient, { AcpContractClientV2 } from "@virtuals-protocol/acp-node";

   export async function createAcpClient() {
     return new AcpClient({
       acpContractClient: await AcpContractClientV2.build(
         process.env.HEDGEFI_PRIVATE_KEY!,
         process.env.HEDGEFI_ENTITY_ID!,
         process.env.HEDGEFI_WALLET_ADDRESS!,
         process.env.BASE_RPC_URL  // custom RPC to avoid rate limits
       ),
       onNewTask: handleNewTask,
       onEvaluate: handleEvaluation,
     });
   }
   ```
5. Implement `src/acp/handlers.ts` — job dispatcher:
   ```typescript
   async function handleNewTask(job: AcpJob) {
     const serviceName = job.getServiceName(); // from ACP SDK
     switch (serviceName) {
       case "hedge_analysis":
         return handleHedgeAnalysis(job);
       case "execute_hedge":
         return handleExecuteHedge(job);
       case "close_hedge":
         return handleCloseHedge(job);
       default:
         await job.respond("Unknown service requested");
     }
   }
   ```
6. Implement stub handlers that accept jobs and return mock deliverables
7. Configure Job Offerings in ACP UI (all 3 jobs + 2 resources)
8. Run test: TestBuyer initiates a `hedge_analysis` job → HedgeFi accepts → returns mock response → job completes

**Test Criteria**:
- HedgeFi appears in ACP sandbox
- TestBuyer can discover HedgeFi via `browseAgents()`
- Full job lifecycle completes: Request → Negotiation → Transaction → Evaluation → Completed
- Mock deliverable delivered and approved
- Agent shows as ONLINE in ACP dashboard

---

### Phase 2: Portfolio Reading + Exposure Analysis

**Goal**: HedgeFi can read any wallet's token balances and calculate exposure.

**Steps**:

1. Implement `src/portfolio/reader.ts`:
   ```typescript
   // Use viem multicall to read ERC-20 balances
   // Support multiple chains: Base, Ethereum, Arbitrum
   // Read native ETH balance + top ERC-20 tokens
   // Token list: WETH, USDC, USDT, WBTC, SOL (wrapped), ARB, OP, LINK, UNI, etc.
   ```
2. Implement `src/portfolio/pricer.ts`:
   ```typescript
   // CoinGecko free API for token prices
   // Cache prices for 60 seconds to avoid rate limits
   // Fallback: hardcoded approximate prices for demo
   ```
3. Implement `src/portfolio/analyzer.ts`:
   ```typescript
   interface ExposureAnalysis {
     totalValueUsd: number;
     tokens: Array<{
       symbol: string;
       balance: string;
       valueUsd: number;
       percentage: number;
     }>;
     concentrationRisk: "high" | "medium" | "low";
     topExposure: string;  // "72% in ETH"
     volatileExposure: number;  // % in non-stablecoin assets
   }
   // concentration_risk = "high" if any single non-stable token > 50%
   // concentration_risk = "medium" if any single non-stable token > 30%
   ```
4. Implement `src/hedging/reasoning.ts`:
   ```typescript
   // Gemini prompt:
   // "You are a DeFi risk analyst. Given the following portfolio exposure,
   //  explain the key risks and what hedges would be appropriate.
   //  Be specific about which price movements would hurt this portfolio."
   ```
5. Wire into `hedge_analysis` job handler — now returns real exposure data instead of mocks
6. **External wallet support**: the `wallet_address` field accepts ANY valid address. If user says "protect 0xABC...", we just read that address. No signatures needed — it's all public on-chain data.

**Test Criteria**:
- Can read balances of any wallet on Base/ETH
- Exposure analysis correctly calculates percentages
- Concentration risk detection works (test with a whale wallet)
- Gemini generates coherent risk explanations
- `hedge_analysis` job returns real portfolio data

---

### Phase 3: Limitless Integration — Market Scanning

**Goal**: HedgeFi can query Limitless Exchange for relevant prediction markets and match them to portfolio exposure.

**Steps**:

1. Install Limitless SDK:
   ```bash
   bun add limitless-exchange-ts-sdk
   # OR use direct API if SDK has issues with Bun:
   # Limitless API at https://api.limitless.exchange/api-v1
   ```
2. Implement `src/limitless/client.ts`:
   ```typescript
   // Initialize Limitless SDK with HedgeFi's agent wallet
   // Auth: sign message with agent's private key → get session
   // EIP-712 domain for Base chain
   ```
3. Implement `src/limitless/markets.ts`:
   ```typescript
   // Fetch active markets from Limitless
   // Filter for crypto price prediction markets:
   //   - "Will ETH close above/below $X?"
   //   - "Will BTC close above/below $X?"
   //   - Hourly and daily markets preferred (short expiry = rolling hedges)
   // For each market, fetch orderbook depth (bid/ask prices for YES/NO)
   // Return structured market data with hedging utility scores
   ```
4. Implement `src/hedging/strategy.ts`:
   ```typescript
   // Core matching logic:
   // 1. User holds ETH → find markets like "ETH below $X"
   //    → Buy YES shares = profit if ETH drops (hedge!)
   // 2. User holds BTC → find markets like "BTC below $Y"
   //    → Buy YES shares = profit if BTC drops
   // 3. Calculate optimal strike selection:
   //    - Conservative: hedge against 5% drop (cheaper, less coverage)
   //    - Moderate: hedge against 10% drop
   //    - Aggressive: hedge against 15-20% drop (most expensive, most coverage)
   // 4. Price the hedge:
   //    - If "ETH below $2400" YES shares cost $0.12 each
   //    - $100 budget buys 833 shares → max payout $833 if ETH drops below $2400
   //    - Coverage ratio: $833 / $5000 portfolio = 16.7% of downside covered
   ```
5. Implement `src/hedging/sizing.ts`:
   ```typescript
   // Position sizing based on:
   // - User's hedge budget
   // - Risk tolerance
   // - Market liquidity (don't try to buy more than orderbook can fill)
   // - Diversification (spread across multiple markets/strikes if possible)
   //
   // Conservative: smaller positions, wider strikes, more markets
   // Aggressive: concentrated positions, tighter strikes, fewer markets
   ```
6. Wire into `hedge_analysis` job — now returns real market recommendations
7. Implement `available_markets` Resource endpoint

**Test Criteria**:
- Can fetch live Limitless markets via SDK/API
- Market filtering correctly identifies crypto price markets
- Strategy engine matches ETH exposure → ETH-related markets
- Position sizing respects budget and risk tolerance
- `available_markets` Resource returns current markets
- Recommendations include cost estimates and coverage ratios

---

### Phase 4: Limitless Execution — Placing Hedge Orders

**Goal**: HedgeFi can actually place orders on Limitless, buying YES/NO shares with the user's USDC.

**Steps**:

1. Implement `src/limitless/orders.ts`:
   ```typescript
   // EIP-712 order signing flow:
   // 1. Build order struct: maker, tokenId, side, amount, price, nonce, expiry
   // 2. Sign with HedgeFi's agent wallet private key
   // 3. Submit to Limitless API
   // 4. Track order ID and fill status
   //
   // Order types:
   // - Market order: buy at best available price (for quick execution)
   // - Limit order: specify max price (for better fills, slower)
   //
   // For hedging, prefer market orders — speed > price optimization
   ```
2. Implement `src/limitless/positions.ts`:
   ```typescript
   // Track positions held by HedgeFi:
   // - Query Limitless API for current positions
   // - Map positions to ACP buyer accounts
   // - Check if markets have resolved
   // - Calculate P&L
   ```
3. Implement `execute_hedge` job handler (the Fund-Transfer Job):
   ```typescript
   async function handleExecuteHedge(job: AcpJob) {
     // 1. Parse requirements (wallet_address, chain, risk_tolerance, budget)
     const { wallet_address, chain, risk_tolerance, hedge_budget_usdc } = parseRequirements(job);

     // 2. Accept the job + receive funds from escrow
     //    ACP SDK handles the fund transfer via MemoType.PAYABLE_TRANSFER
     await job.acceptAndReceiveFunds();

     // 3. Read wallet exposure
     const exposure = await analyzeWallet(wallet_address, chain);

     // 4. Scan Limitless markets
     const markets = await findHedgingMarkets(exposure);

     // 5. Build hedge strategy
     const strategy = buildHedgeStrategy(exposure, markets, risk_tolerance, hedge_budget_usdc);

     // 6. Execute: place orders on Limitless
     const results = [];
     for (const hedge of strategy.positions) {
       const order = await placeLimitlessOrder({
         marketId: hedge.market_id,
         side: hedge.action,         // BUY_YES or BUY_NO
         amount: hedge.shares,
         maxPrice: hedge.max_price,
       });
       results.push({ ...hedge, order_id: order.id, filled: order.filled });
     }

     // 7. Store positions in DB (mapped to this buyer's ACP account)
     await storePositions(job.buyerAddress, results);

     // 8. Generate reasoning with Gemini
     const reasoning = await generateHedgeExplanation(exposure, results);

     // 9. Deliver result via ACP
     await job.deliver(JSON.stringify({
       exposure,
       hedges_placed: results,
       summary: {
         total_spent: results.reduce((s, r) => s + r.total_cost_usd, 0),
         total_max_coverage: results.reduce((s, r) => s + r.max_payout_usd, 0),
         budget_remaining: hedge_budget_usdc - totalSpent,
         coverage_ratio: `Protecting ~${coveragePct}% of your $${exposure.totalValueUsd} exposure`
       },
       reasoning
     }));
   }
   ```
4. Handle evaluation:
   ```typescript
   async function handleEvaluation(job: AcpJob) {
     // Self-evaluation for sandbox:
     // Verify positions exist on Limitless
     // Verify amounts match deliverable
     await job.evaluate(true, "Hedge positions verified on Limitless Exchange");
   }
   ```
5. Implement `close_hedge` job handler:
   - Sell positions on Limitless (or wait for resolution)
   - Send USDC back to buyer via ACP payable memo
   - Log return transaction

6. Implement `active_positions` Resource

**Test Criteria**:
- Can place a real order on Limitless via EIP-712
- Order fills and shares appear in HedgeFi's wallet
- Fund-transfer flow works: USDC moves from ACP escrow → HedgeFi → Limitless
- Position tracking correctly maps positions to ACP buyer
- `active_positions` Resource returns real positions
- implement both resoruces in the agent ui 
- `close_hedge` sells positions and returns USDC
- Full lifecycle: analyze → execute → track → close

---

### Phase 5: End-to-End Testing & Close Hedge

**Goal**: Validate all 3 job types end-to-end. Wire up real `close_hedge` execution. Stress test with varying budgets.

**Steps**:

1. **Test `hedge_analysis`** — already working:
   - `scripts/test-buyer.ts` initiates analysis job, receives exposure + recommendations
   - Verify deliverable format matches schema

2. **Test `execute_hedge`** — already working:
   - `scripts/test-execute-hedge.ts` places real orders on Limitless with $1 budget
   - Verify positions recorded in SQLite, order IDs valid
   - Test with different budgets: $1, $5, $10, $50

3. **Wire up real `close_hedge` execution**:
   - Look up active positions from SQLite by buyer address
   - Ensure Conditional Token (ERC-1155) approval for selling
   - Place SELL orders via `placeHedgeOrder` for each position
   - Update position status in DB (closed, realized P&L)
   - Deliver real `CloseHedgeDeliverable` with actual amounts
   - Handle edge cases: no active positions, expired markets, already-resolved positions

4. **Test `close_hedge` end-to-end**:
   - Run `execute_hedge` first to create positions
   - Run `close_hedge` to sell them back
   - Verify positions marked as closed in DB
   - Verify USDC returned from sale

5. **Test Resources**:
   - Query `active-positions` via ngrok URL after placing hedges
   - Query `historical-positions` after closing hedges
   - Query `market` endpoint with a real market ID
   - Verify response format matches ACP prediction market resource standards

6. **Multi-budget stress test**:
   - $0.50 budget (minimum viable)
   - $5 budget (typical small test)
   - $50 budget (realistic production budget)
   - Verify budget deployment ratio improves with larger amounts

**Test Criteria**:
- All 3 job types complete successfully end-to-end
- `close_hedge` sells real positions and reports accurate P&L
- Resources return correct data accessible via HTTPS
- Agent handles edge cases gracefully (no positions, expired markets)
- Works reliably across different budget sizes

---

### Phase 5.5: ACP Compliance — Notifications, Validation & Exception Handling

**Goal**: Implement mandatory ACP features required for graduation: notification memos, request validation, job rejection/refund, and resource validation via Butler.

**Steps**:

1. **Notification memos** (mandatory for graduation):
   - Send notification memos after every job completion — without them, "users are left without context"
   - **After `execute_hedge` delivery**: `job.createNotification()` with hedge summary (markets, cost, coverage)
   - **After `close_hedge` delivery**: `job.createPayableNotification()` with P&L and returned USDC amount
     - Use `new FareAmount(amount, config.baseFare)` for payable notifications
   - **After `hedge_analysis` delivery**: `job.createNotification()` with exposure summary
   - For partial fills: send iterative notifications per fill with cumulative position tracking
   - Format: include market symbol, exit/entry price, realized P&L, payout amount

2. **Exception handling — reject and refund**:
   - **`job.reject(reason)`**: Use when job can't proceed but no funds were involved (e.g., `hedge_analysis` with invalid wallet address)
   - **`job.rejectPayable(reason, fareAmount)`**: Use when fund-transfer job fails after payment — refunds USDC from escrow back to buyer
   - Rejection scenarios for HedgeFi:
     - Invalid/empty wallet address → `job.reject("Invalid wallet address")`
     - Zero portfolio value / all stablecoins → `job.reject("No hedgeable exposure found")`
     - No suitable Limitless markets available → `job.reject("No prediction markets available for hedging")`
     - Limitless auth failure after retry → `job.rejectPayable("Trading service unavailable", fareAmount)`
     - All orders fail to fill → `job.rejectPayable("Order execution failed", fareAmount)` — refund full budget
     - Partial execution failure → deliver what succeeded, note failures in deliverable
   - Always include descriptive reason messages and tx hashes where applicable

3. **Request validation**:
   - Validate requirement schema before accepting any job:
     - `wallet_address`: valid hex address format (`0x` + 40 hex chars)
     - `chain`: must be `"base"` (only supported chain for now)
     - `risk_tolerance`: must be `"conservative"`, `"moderate"`, or `"aggressive"`
     - `hedge_budget_usdc`: must be > 0 and >= `MIN_HEDGE_BUDGET_USD`
     - `close_hedge`: `position_ids` must be non-empty array OR `close_all` must be true
   - Reject with clear error message on invalid input (don't crash, don't proceed)

4. **Resource validation via Butler sandbox**:
   - Fund the sandbox Butler agent with sufficient USDC
   - Search for HedgeFi in sandbox Butler to verify discovery
   - Test each resource individually through Butler:
     - `get_active_pm_positions` — after placing hedges
     - `get_historical_pm_positions` — after closing hedges
     - `get_prediction_market` — with a real market ID
   - Verify response format matches ACP prediction market resource standards
   - Confirm resources return intended data when queried through Butler

5. **Evaluation approach**:
   - For sandbox/graduation: use auto-approval (omit `onEvaluate` or `job.evaluate(true, ...)`)
   - SDK default handler auto-approves: `await job.evaluate(true, "Evaluated by default")`
   - For production consideration: external evaluator that verifies on-chain positions
   - Current self-evaluation is acceptable for graduation — Virtuals docs confirm auto-approval is valid for "testing and development phases"

**Test Criteria**:
- Notification memos sent after every job (visible in ACP visualizer)
- Invalid requests are rejected with clear error messages (not crashes)
- Fund-transfer failures trigger `rejectPayable()` with full refund
- Resources return correct data when queried via Butler sandbox
- Agent never hangs or crashes on bad input

---

### Phase 6: AI Reasoning + Polish

**Goal**: Make every interaction feel intelligent, not mechanical.

**Steps**:

1. Enhance Gemini prompts for different scenarios:
   - **Exposure analysis**: "Your portfolio is heavily concentrated in ETH (72%). This creates significant downside risk if ETH drops. A 10% ETH correction would reduce your portfolio by ~$360."
   - **Hedge recommendation**: "I've identified 3 Limitless markets to hedge your ETH exposure. The best value is 'ETH below $2,400 today' at $0.12/share — this gives you 8:1 payout on a 5% drop."
   - **Post-hedge summary**: "You're now protected against ETH drops below $2,400 for the next 24h. Your maximum loss without hedging was $500. With this hedge, your maximum loss is $276 (45% reduction). Cost: $24."
   - **Position update**: "Your hedge on 'ETH below $2,400' expired worthless — ETH closed at $2,650. Your portfolio gained value, so the hedge wasn't needed. Think of the $24 as insurance premium."

2. Add error handling + edge cases:
   - Wallet has only stablecoins → "Your portfolio is 100% in stablecoins. No directional hedge needed."
   - No relevant Limitless markets → "No suitable prediction markets found for SOL hedging right now. I'll monitor and notify when markets become available."
   - Budget too small → "Your $2 budget is insufficient for meaningful hedging. Minimum recommended: $10 for basic coverage."
   - Market liquidity too thin → "The best ETH market has only $50 in liquidity. I'll place a smaller position to avoid slippage."

3. Add structured logging for debugging and demo
4. Polish deliverable formatting for Butler display

**Test Criteria**:
- Gemini reasoning is specific, actionable, and references actual numbers
- Edge cases handled gracefully with helpful messages
- Logs are clean and informative
- Butler displays deliverables nicely

---

### Phase 6.5: Evaluation, Budget Accountability & Order Improvements

**Goal**: Add proper evaluation logic, solve the remaining-funds problem, and improve order execution for full budget deployment.

**Steps**:

1. **Evaluation phase for fund-transfer jobs**:
   - Replace self-evaluation with verification logic
   - Verify positions exist on Limitless (query `/portfolio/positions`)
   - Verify total cost matches deliverable's `summary.total_spent`
   - Verify no slippage beyond tolerance
   - For `close_hedge`: verify positions were actually sold and USDC returned
   - In sandbox, keep auto-approve but log verification results

2. **Remaining funds problem**:
   - Currently: buyer requests $1 budget → agent spends $0.91 → $0.09 sits unused in agent wallet
   - This is a trust/fairness issue — buyer paid for $1 of hedges but got $0.91
   - **Solution A — Redistribution loop**: After first round of orders, take remaining budget and retry on the highest-liquidity market. Stays with FOK (instant fills) but gets closer to 100% deployment.
   - **Solution B — Dynamic pricing via Resources**: Expose actual spend in the deliverable (already done). Buyer agent can verify spend matches budget before approving evaluation. If underspent, buyer can reject or agent can refund the difference.
   - **Solution C — GTC orders + position monitor** (production): Place GTC limit orders that commit the full amount on the order book. Requires a background monitor to wait for fills before delivering results. More complex but guarantees full deployment.
   - Implement Solution A first (quick win), design Solution C for production.

3. **FOK → GTC order support**:
   - Add GTC order building (`buildGtcBuyOrder`) — specify price + size instead of just USDC amount
   - GTC: `makerAmount` = ceil(price * size * 10^6), `takerAmount` = size * 10^6
   - Add background fill monitor that polls order status until filled or expired
   - Use GTC for larger budgets (>$10), FOK for small/quick hedges
   - Deliver partial results if some GTC orders haven't filled within SLA window

4. **Budget reconciliation in deliverable**:
   - Add `undeployed_usdc` field to deliverable summary
   - Add `deployment_ratio` (e.g., "91% of budget deployed")
   - Log clear accounting: budget → allocated → spent → remaining

**Test Criteria**:
- Evaluation verifies real positions exist on Limitless before approving
- Redistribution loop deploys >95% of budget on average
- GTC orders commit full budget to order book
- Deliverable accurately reports deployed vs undeployed amounts
- Buyer agent can verify spend matches expectations
- Positions persist across agent restarts on deployed infrastructure

---

### Phase 7: PostgreSQL Migration, Graduation, Token Launch + Demo

**Goal**: Migrate to persistent storage, graduate from sandbox, launch on Virtuals Protocol, and create demo video for submission.

**Steps**:

1. **Migrate SQLite → PostgreSQL**:
   - Local `bun:sqlite` won't survive deployment restarts (no persistent disk on free-tier hosting)
   - Use `Bun.sql` (built-in Postgres client) — no external packages needed
   - Migration scope:
     - Create `src/db/pg.ts` — Postgres connection via `Bun.sql` with `DATABASE_URL` env var
     - Migrate `src/db/schema.ts` — `CREATE TABLE IF NOT EXISTS` using Postgres syntax
     - Migrate `src/db/positions.ts` — swap `db.query(...).all()` → `await sql\`SELECT ...\``
     - Migrate `src/db/job-state.ts` — same pattern (sync → async)
     - All DB functions become `async` (Postgres is async, SQLite was sync)
     - Update all callers: `execute-hedge.ts`, `close-hedge.ts`, `hedge-analysis.ts`, `evaluation.ts`, `handlers.ts`, `resources/server.ts`
   - Same schema: `positions`, `order_history`, `job_state` tables
   - Add `DATABASE_URL` env var (Supabase free tier / Railway Postgres / Neon free tier)
   - For local dev: can keep SQLite as fallback if `DATABASE_URL` is not set
   - Test: verify all 3 job types work end-to-end with Postgres backend

2. **ACP Graduation** (requires 10 successful jobs):
   - Run automated test buyer script to complete 10+ successful sandbox transactions across all job types
   - Graduate via ACP UI → HedgeFi appears in Agent-to-Agent view
   - Butler can now route real users to HedgeFi
   - Verify agent is discoverable via `browseAgents("hedgefi")`

3. **Virtuals Standard Launch** on app.virtuals.io:
   - Name: HedgeFi
   - Ticker: HEDGE
   - Type: ON-CHAIN
   - Description: "The first autonomous portfolio hedging agent. Protects your crypto holdings using prediction market positions on Limitless Exchange. Works through Butler — just say 'hedge my portfolio'."
   - Cost: 100 $VIRTUAL

4. **Demo recording** (2-3 minutes):
   ```
   0:00-0:15  "HedgeFi — the first agent that actually hedges your portfolio"
              Show Butler search returning HedgeFi
   0:15-0:35  User tells Butler: "Analyze my wallet 0xABC for hedging"
              Show hedge_analysis job being created
              Show exposure analysis result: "72% ETH, 15% WBTC, 13% USDC"
   0:35-0:55  User tells Butler: "Execute the hedge with $50 budget"
              Show execute_hedge fund-transfer job
              Show USDC moving through escrow → HedgeFi → Limitless
   0:55-1:15  Show the deliverable: positions placed, coverage analysis
              "Protected 35% of your ETH downside for 24h. Cost: $42"
              Show Gemini reasoning
   1:15-1:35  Show Resources: active_positions query
              "Here are your live hedge positions with real-time P&L"
   1:35-1:55  Show close_hedge: user exits positions, USDC returned
   1:55-2:15  Show the Virtuals token launch
   2:15-2:30  "HedgeFi — portfolio protection on autopilot"
   ```

5. **README** with:
   - Architecture diagram
   - Setup instructions (env vars, ACP registration, Limitless setup)
   - Demo walkthrough
   - Track-specific sections explaining how it hits each judging criteria

**Test Criteria**:
- Demo runs 3x without issues
- Full flow visible: analyze → hedge → track → close
- Virtuals token live
- Clean README

---

## Environment Variables

```bash
# HedgeFi Agent (Seller)
HEDGEFI_PRIVATE_KEY=0x...           # Agent wallet private key (Base)
HEDGEFI_ENTITY_ID=...               # From ACP Service Registry
HEDGEFI_WALLET_ADDRESS=0x...        # Agent wallet address

# Test Buyer Agent
BUYER_PRIVATE_KEY=0x...
BUYER_ENTITY_ID=...
BUYER_WALLET_ADDRESS=0x...

# Base RPC (recommended: Alchemy/Infura to avoid rate limits)
BASE_RPC_URL=https://...

# Limitless Exchange
LIMITLESS_API_URL=https://api.limitless.exchange

# AI
GEMINI_API_KEY=...

# CoinGecko (optional, has free tier)
COINGECKO_API_KEY=...
```

---

## SDK Bug Reports → Extra Points

Reporting SDK issues to the Virtuals team demonstrates deep integration knowledge and earns goodwill/extra points. Track all bugs found during development and report them with clear reproduction steps.

### Reported Issues

1. **AJV "Address" Format Crash** — The ACP UI lets you set "Address" subtype on String fields, generating `format: "address"` in the JSON schema. The SDK's AJV validator (`new Ajv({ allErrors: true })`) doesn't register the `"address"` format, so `initiateJob()` crashes with a validation error. Workaround: use "Plain" subtype. Reported to @celesteanglm.

2. **Double `init()` → Duplicate Socket Connections** — The constructor calls `this.init(options.skipSocketConnection)` without `await`. If you don't pass `skipSocketConnection: true` and also call `await acpClient.init()` (as README examples show), two sockets are created. Fix: pass `skipSocketConnection: true` in constructor, then call `await client.init()`. Not a bug, but undocumented — worth flagging as docs improvement.

### How to Report

- Contact: Virtuals team lead @celesteanglm on Telegram
- Include: SDK version, minimal reproduction steps, workaround used, relevant code snippet
- Reference our agent wallet address for context: `0xC2CD85B007AE1EfCec2679AA37A2e162DE85E804`

### Issues to Watch For (Future Phases)

- Limitless SDK compatibility with Bun runtime
- Fund-transfer job edge cases (partial fills, timeouts)
- Resource endpoint registration/discovery issues
- Any ACP v2 beta breaking changes between versions

---

## Pre-Build Checklist

- [ ] Create 2 wallets on Base (HedgeFi agent + TestBuyer)
- [ ] Fund TestBuyer with ~$5-10 USDC on Base (for testing)
- [ ] Fund HedgeFi with ~$2 USDC on Base (for initial Limitless auth)
- [ ] Register both agents on ACP Service Registry
- [ ] Whitelist both wallets
- [ ] Configure 3 Job Offerings + 2 Resources in ACP UI
- [ ] Get Gemini API key
- [ ] Test Limitless API access (fetch markets, no auth needed for public data)
- [ ] Budget ~$50-100 in $VIRTUAL for Virtuals Standard Launch

---

## Reference Links

**ACP**:
- ACP Node SDK: https://www.npmjs.com/package/@virtuals-protocol/acp-node
- ACP Node Examples (prediction market): https://github.com/Virtual-Protocol/acp-node/tree/main/examples/acp-base/funds/prediction-market
- ACP Concepts & Architecture: https://whitepaper.virtuals.io/acp-product-resources/acp-concepts-terminologies-and-architecture
- ACP v2 Prediction Market Use Case: https://whitepaper.virtuals.io/acp-product-resources/introducing-acp-v2/acp-v2-prediction-market-use-case
- ACP Tech Playbook: https://whitepaper.virtuals.io/builders-hub/acp-tech-playbook
- ACP FAQ & Best Practices: https://whitepaper.virtuals.io/info-hub/builders-hub/agent-commerce-protocol-acp-builder-guide/acp-faq-debugging-tips-and-best-practices
- Service Registry: https://app.virtuals.io/acp

**Limitless Exchange**:
- Limitless Exchange: https://limitless.exchange
- Limitless TS SDK: https://github.com/limitless-labs-group/limitless-exchange-ts-sdk
- Limitless API: https://api.limitless.exchange/api-v1
- Limitless CTF Exchange (forked from Polymarket): https://github.com/limitless-labs-group/limitless-ctf-exchange

**Virtuals**:
- Virtuals Agent Launch Guide: https://whitepaper.virtuals.io/info-hub/builders-hub/agent-launch-guide
- Standard Launch How-to: https://whitepaper.virtuals.io/builders-hub/agent-launch-mechanisms/how-to-standard-launch

---

## Judging Criteria Mapping

| Criteria | How HedgeFi Delivers | Phase |
|---|---|---|
| Executes trades / DeFi actions | Places real orders on Limitless Exchange via EIP-712 | 4 |
| Risk controls | Position sizing, budget limits, slippage protection, diversification | 3, 4 |
| Explains why it acted | Gemini reasoning on every hedge decision in plain English | 2, 6 |
| Auditable trail | ACP memos on-chain + Limitless order IDs + full job history | 4, 5 |
| Multiple data sources | Wallet balances (viem), token prices (CoinGecko), Limitless markets, Gemini AI | 2, 3 |
| Customized for users | 3 risk levels, configurable budgets, any wallet address, per-user ACP Accounts | 1, 2 |
| Live product people use | Butler routes real users to HedgeFi. Zero competition on ACP. | 5, 7 |
| Revenue generation | Every job = ACP payment. Recurring because hedges expire daily. | All |
| ACP multiplier (2x) | Full ACP v2 integration: Fund-Transfer Jobs, Resources, Accounts | All |
| Virtuals launch multiplier (2x) | Standard Launch as $HEDGE | 7 |
