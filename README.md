<p align="center">
  <img src="logo.png" alt="HedgeFi" width="120" />
</p>

<h1 align="center">HedgeFi</h1>

<p align="center">
  <strong>Autonomous portfolio insurance agent on Virtuals ACP</strong><br/>
  Hedges crypto portfolios using prediction markets on Limitless Exchange
</p>

---

## What is HedgeFi?

HedgeFi is the first agent on Virtuals ACP that **autonomously hedges crypto portfolios** using prediction market positions. No frontend needed -- Butler IS the interface.

A user tells Butler: *"Hedge my ETH holdings"* or *"Protect my portfolio at 0xABC..."* and HedgeFi:

1. Reads the target wallet's on-chain token balances
2. Calculates exposure (which assets, concentration risk, volatility)
3. Scans Limitless Exchange for relevant price prediction markets
4. Buys YES/NO shares that pay out $1 each if the user's holdings drop in value
5. Returns a structured hedge report with positions, cost, coverage, and AI reasoning

**Think of it as on-chain portfolio insurance.** Users pay a small premium for downside protection. If prices crash, the hedge pays out. If prices stay stable, the premium is the only cost -- like car insurance you're glad you didn't need.

---

## Why Prediction Markets = Synthetic Options

| Feature | Traditional Options | Prediction Markets (Limitless) |
|---|---|---|
| Payoff | Complex (Greeks, strike, expiry) | Binary: $1 if correct, $0 if wrong |
| Liquidation risk | Yes (margin calls) | No -- premium is max loss |
| Margin required | Yes | No -- pay upfront |
| Duration | Fixed expiry cycles | Hourly / daily (perfect for rolling hedges) |
| Cost | Often expensive | Cheap -- $0.10 shares = 10x leverage |
| Complexity | Options knowledge required | Just "will price go up or down?" |

**Example:** User holds 2 ETH (~$5,000). Limitless has a market *"Will ETH close below $2,400 today?"* with YES shares at $0.12. HedgeFi buys 200 YES shares for $24. If ETH drops below $2,400, those shares pay $200 -- offsetting the loss. If ETH stays above, user loses only the $24 premium. That's a 4.8% cost for ~$200 of downside protection.

---

## Architecture

HedgeFi uses Virtuals ACP v2's **payable requirement** system. Every fund-transfer job runs in two phases -- the buyer always reviews the plan before paying.

```
PHASE 1: REQUEST (Analyze & Propose)
======================================
USER / BUTLER              HEDGEFI                  USER'S PORTFOLIO
     |                        |                           |
     | "Hedge my ETH"         |                           |
     |----------------------->|                           |
     |                        | Read balances (public RPC)|
     |                        |-------------------------->|
     |                        |<--------------------------|
     |                        | Analyze exposure          |
     |                        | Scan Limitless markets    |
     |                        | Build hedge plan          |
     |                        |                           |
     |                        | accept() +                |
     |                        | createPayableRequirement  |
     |                        | ("Send $X to 0xAgent...")  |
     |<-----------------------|                           |
     | Review plan + cost     |                           |
     | APPROVE or REJECT      |                           |


PHASE 2: TRANSACTION (Pay & Execute)
======================================
USER / BUTLER       ACP ESCROW         HEDGEFI WALLET        LIMITLESS
     |                   |                   |                     |
     | Approve + pay     |                   |                     |
     |   USDC            |                   |                     |
     |------------------>|                   |                     |
     |                   | Auto-transfer     |                     |
     |                   | USDC to agent's   |                     |
     |                   | external wallet   |                     |
     |                   |------------------>|                     |
     |                   |                   | Approve USDC to     |
     |                   |                   | exchange contract   |
     |                   |                   |                     |
     |                   |                   | Sign EIP-712 orders |
     |                   |                   | (HEDGEFI_PRIVATE_KEY)|
     |                   |                   |-------------------->|
     |                   |                   |   USDC debited      |
     |                   |                   |   YES/NO shares     |
     |                   |                   |   credited (ERC1155)|
     |                   |                   |<--------------------|
     |                   |                   |                     |
     |                   | deliverPayable:   |                     |
     |                   | return undeployed |                     |
     |                   | budget + report   |                     |
     |<------------------|<------------------|                     |
     | Hedge report +    |                   |                     |
     | AI reasoning +    |                   |                     |
     | unspent USDC      |                   |                     |
```

**Three wallets, zero key sharing:**

| Wallet | Owner | Purpose | Holds |
|---|---|---|---|
| User's portfolio wallet | Human | Holds crypto portfolio. Can be any external address. HedgeFi reads balances via public RPC -- **no keys needed**. | ETH, WBTC, LINK, etc. |
| Butler agent wallet | Virtuals Protocol | Routes USDC payment from user to ACP escrow smart contract. | USDC (temporarily) |
| HedgeFi external wallet | HedgeFi | Receives USDC from escrow, executes trades on Limitless, holds hedge positions. This is a standard EOA on Base with its own private key (`HEDGEFI_PRIVATE_KEY`). | USDC + YES/NO shares (ERC-1155) |

**Why does HedgeFi need its own private key?** The `HEDGEFI_PRIVATE_KEY` env var is for HedgeFi's external wallet on Base (not an ACP smart wallet). It's used to:

1. **Approve USDC** to Limitless Exchange contracts (ERC-20 approval tx)
2. **Sign EIP-712 orders** for prediction market trades (off-chain signatures submitted to Limitless CLOB)
3. **Approve conditional tokens** (ERC-1155) when selling/closing positions

The user **never** shares their private key. HedgeFi reads wallet balances via public RPC calls and trades with its own external wallet using USDC received from ACP escrow.

---

## How ACP v2 Fund Transfers Work

### REQUEST Phase -- Buyer Reviews Plan Before Paying

1. **Buyer creates job** via Butler -- e.g. "Hedge my 2 ETH holdings with $50 budget"
2. **HedgeFi validates inputs** -- wallet address, budget, risk tolerance
3. **HedgeFi analyzes portfolio** -- reads wallet balances via public RPC (no keys needed)
4. **HedgeFi builds hedge plan** -- scans Limitless markets, sizes positions, estimates costs
5. **HedgeFi accepts job** -- calls `job.accept()` to signal willingness
6. **HedgeFi sends payable requirement** -- calls `job.createPayableRequirement(plan, PAYABLE_REQUEST, fareAmount, HEDGEFI_WALLET_ADDRESS)` which tells ACP: "I need $50 USDC sent to my external wallet to execute this"
7. **Buyer reviews** -- sees the hedge plan with estimated positions, costs, coverage. Can APPROVE (pay) or REJECT (cancel, no charge)

### TRANSACTION Phase -- Payment Triggers Execution

1. **Buyer approves and pays** -- USDC flows from buyer wallet into ACP Escrow smart contract
2. **ACP SDK auto-transfers** -- escrow routes USDC to HedgeFi's external wallet (`HEDGEFI_WALLET_ADDRESS`). This happens automatically before `handleExecuteHedgeExecution()` is called
3. **Balance check** -- HedgeFi verifies USDC arrived in its wallet. If insufficient, refunds buyer via `job.rejectPayable()`
4. **USDC approval** -- HedgeFi signs an ERC-20 `approve()` tx allowing the Limitless Exchange contract to spend its USDC
5. **Order placement** -- HedgeFi signs EIP-712 orders with `HEDGEFI_PRIVATE_KEY` for each hedge position (FOK for small orders, GTC for larger)
6. **Exchange settlement** -- Limitless debits USDC from HedgeFi's wallet and credits YES/NO shares (ERC-1155 conditional tokens)
7. **Budget accountability** -- any undeployed USDC (e.g. from partially filled orders) is returned to the buyer via `job.deliverPayable(deliverable, undeployedAmount)`
8. **Delivery** -- hedge report with positions, costs, coverage ratio, and AI reasoning is delivered as the job result

### Key Points

- **Escrow is a routing mechanism** -- funds flow through it to the agent's external wallet, they don't sit there permanently
- **Two-phase safety** -- buyer sees the full plan BEFORE paying; can reject with zero cost
- **Budget returns** -- undeployed funds are automatically returned to buyer
- **No key sharing** -- user's portfolio is read via public blockchain data; HedgeFi trades with its own wallet

---

## ACP Job Offerings

### 1. `hedge_analysis` -- Portfolio Analysis (Service-Only)

Read-only exposure analysis + hedge recommendations. No funds transferred.

**Input:** `wallet_address`, `chain`, `risk_tolerance`, `hedge_budget`
**Output:** Portfolio exposure, recommended markets, AI reasoning
**Price:** $0.10 USDC

### 2. `execute_hedge` -- Place Hedge Positions (Fund-Transfer)

Full execution -- analyzes wallet AND places hedge positions on Limitless.

**Input:** `wallet_address`, `chain`, `risk_tolerance`, `hedge_budget_usdc`
**Output:** Positions placed, order IDs, cost/coverage summary, AI reasoning
**Price:** $0.50 USDC + hedge budget
**Budget cap:** $5 max during testing phase

### 3. `close_hedge` -- Close Positions (Fund-Transfer)

Sell existing hedge positions and return funds to buyer.

**Input:** `position_ids[]` or `close_all: true`
**Output:** Closed positions, realized P&L, USDC returned
**Price:** $0.25 USDC

### ACP Resources (Free Endpoints)

| Resource | Description |
|---|---|
| `active_positions` | Query a user's active hedge positions with current P&L |
| `available_markets` | Browse live Limitless prediction markets for hedging |

---

## Hedging Strategy

### How It Works

1. **Read wallet** -- Multicall `balanceOf` for WETH, WBTC, LINK, UNI, ARB, AAVE across Base/ETH/Arbitrum
2. **Price exposure** -- CoinGecko free API for live token prices
3. **Assess risk** -- Concentration risk scoring (>50% in one asset = high risk)
4. **Scan markets** -- Find Limitless prediction markets matching portfolio assets
5. **Score markets** -- Payout ratio (0-35pts), liquidity (0-25pts), time to expiry (0-20pts), cost efficiency (0-20pts)
6. **Size positions** -- Proportional allocation based on portfolio weight and risk tolerance
7. **Execute** -- EIP-712 signed orders (FOK for small, GTC for larger orders)
8. **Redistribute** -- Retry undeployed budget on best-performing markets (up to 2 rounds)

### Risk Tolerance Levels

| Level | Strike Selection | Max Markets | Description |
|---|---|---|---|
| Conservative | 3-5% below current | 3 | Wider strikes, more diversified |
| Moderate | 5-10% below current | 2 | Balanced cost vs coverage |
| Aggressive | 10-20% below current | 2 | Cheaper premiums, deeper OTM |

### Safety Features

- **$5 budget cap** during testing phase (configurable in `constants.ts`)
- **Market expiry buffer** -- skips markets expiring within 5 minutes
- **Price validation** -- rejects shares priced at $0 or $1 (no hedging value)
- **NaN/Infinity guards** -- all P&L calculations sanitized
- **Per-buyer locking** -- serializes fund-transfer jobs from the same buyer
- **Insufficient collateral detection** -- stops order placement if exchange balance runs out
- **Gemini API fallback** -- template-based reasoning if AI service is unavailable

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Runtime | **Bun** | Fast TypeScript runtime |
| ACP SDK | **@virtuals-protocol/acp-node** | Job lifecycle, fund transfers, notifications |
| Blockchain | **viem** | Multicall wallet reading, EIP-712 signing |
| Exchange | **Limitless Exchange API** | Prediction market orders (CLOB) |
| Prices | **CoinGecko API** (free tier) | Token price lookups |
| AI | **Gemini 2.0 Flash** (`@google/genai`) | Hedge strategy reasoning |
| Database | **bun:sqlite** | Position tracking, job state, order history |
| Chain | **Base** | ACP + Limitless both live here |

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) v1.0+
- Two wallets on Base (HedgeFi agent + TestBuyer)
- Both wallets registered on [ACP Service Registry](https://app.virtuals.io/acp)
- Agent wallet funded with USDC on Base (~$10-50 for operations)
- Gemini API key (optional -- falls back to template reasoning)

### Setup

```bash
# Clone and install
git clone <repo-url> && cd hedge
bun install

# Configure environment
cp .env.example .env
# Edit .env with your keys:
#   HEDGEFI_PRIVATE_KEY=0x...
#   HEDGEFI_ENTITY_ID=...
#   HEDGEFI_WALLET_ADDRESS=0x...
#   GEMINI_API_KEY=...  (optional)

# Run agent
bun run start

# Run tests
bun test
```

### Test a Hedge

```bash
# Start the agent
bun run start

# In another terminal -- run the test buyer
bun run start:buyer

# Or test individual flows
bun run scripts/test-execute-hedge.ts
bun run scripts/test-close-hedge.ts
```

---

## Project Structure

```
hedge/
├── src/
│   ├── index.ts                  # Entry point -- init ACP client, start agent
│   ├── acp/
│   │   ├── client.ts             # AcpClient initialization + socket connection
│   │   ├── handlers.ts           # Job dispatcher (REQUEST -> TRANSACTION flow)
│   │   ├── evaluation.ts         # Deliverable verification logic
│   │   ├── validation.ts         # Input validation for job requirements
│   │   └── jobs/
│   │       ├── hedge-analysis.ts # hedge_analysis job handler
│   │       ├── execute-hedge.ts  # execute_hedge fund-transfer job
│   │       └── close-hedge.ts    # close_hedge fund-transfer job
│   ├── limitless/
│   │   ├── auth.ts               # Limitless Exchange authentication
│   │   ├── client.ts             # API client + market fetching
│   │   ├── markets.ts            # Market scanning + scoring
│   │   ├── orders.ts             # EIP-712 order building + signing
│   │   └── approvals.ts          # USDC + ERC-1155 approval management
│   ├── portfolio/
│   │   ├── reader.ts             # Wallet balance reading (viem multicall)
│   │   ├── analyzer.ts           # Exposure + concentration risk analysis
│   │   └── pricer.ts             # CoinGecko token price lookups
│   ├── hedging/
│   │   ├── strategy.ts           # Market matching + recommendation engine
│   │   ├── sizing.ts             # Position sizing + budget allocation
│   │   └── reasoning.ts          # Gemini AI reasoning + fallbacks
│   ├── db/
│   │   ├── schema.ts             # SQLite schema initialization
│   │   ├── positions.ts          # Position CRUD operations
│   │   └── job-state.ts          # Job state management + recovery
│   ├── resources/
│   │   └── server.ts             # HTTP server for ACP Resources
│   ├── utils/
│   │   ├── constants.ts          # Addresses, configs, token registry
│   │   ├── types.ts              # TypeScript type definitions
│   │   ├── logger.ts             # Structured logging
│   │   ├── math.ts               # sanitizeNumber, safeDivide utilities
│   │   ├── env-validator.ts      # Startup environment validation
│   │   ├── job-lock.ts           # Per-buyer concurrency control
│   │   ├── retry.ts              # Retry with exponential backoff
│   │   └── rate-limiter.ts       # API rate limiting
│   └── tests/
│       ├── demo-readiness.test.ts # Core safety + math tests
│       ├── audit-fixes.test.ts    # Concurrency + position tests
│       └── phase6-5.test.ts       # Evaluation + job state tests
├── scripts/
│   ├── test-buyer.ts             # Test buyer agent
│   ├── test-execute-hedge.ts     # Test hedge execution
│   ├── test-close-hedge.ts       # Test position closing
│   └── test-edge-*.ts            # Edge case test scripts
├── docs/
│   └── hedgefi-plan.md           # Full development plan (Phases 1-7)
├── logo.png
└── package.json
```

---

## Environment Variables

```bash
# Required -- HedgeFi agent identity
HEDGEFI_PRIVATE_KEY=0x...           # Private key for HedgeFi's EXTERNAL wallet (EOA) on Base.
                                     # Used to: approve USDC, sign EIP-712 Limitless orders,
                                     # approve ERC-1155 tokens. NOT an ACP smart wallet key.
HEDGEFI_ENTITY_ID=...               # Numeric entity ID from ACP Service Registry
HEDGEFI_WALLET_ADDRESS=0x...        # HedgeFi's external wallet address (must match private key).
                                     # Receives USDC from ACP escrow, holds hedge positions.

# Optional -- Test buyer (for local testing with test-buyer.ts)
BUYER_PRIVATE_KEY=0x...             # Test buyer's wallet private key
BUYER_ENTITY_ID=...                 # Test buyer's ACP entity ID
BUYER_WALLET_ADDRESS=0x...          # Test buyer's wallet address

# Optional -- AI reasoning (falls back to template reasoning if missing)
GEMINI_API_KEY=...

# Optional -- RPC endpoints (defaults to public RPCs)
BASE_RPC_URL=https://...
ETH_RPC_URL=https://...
ARB_RPC_URL=https://...
ALCHEMY_API_KEY=...

# Optional -- CoinGecko (free tier works without key)
COINGECKO_API_KEY=...
```

---

## API Endpoints (Resource Server)

The resource server runs on port 3001 by default.

| Endpoint | Description |
|---|---|
| `GET /resources/active-positions?clientAddress=0x...` | Active hedge positions for a buyer |
| `GET /resources/historical-positions?clientAddress=0x...` | Closed positions with P&L |
| `GET /resources/market?marketId=<slug>` | Prediction market details |
| `GET /resources/available-markets?asset=ETH\|BTC\|all` | Available hedging markets |
| `GET /health` | Basic health check |
| `GET /status` | Detailed agent status (version, active positions, services) |

---

## Revenue Model

Every ACP job = payment. HedgeFi earns recurring revenue because prediction market positions expire hourly/daily -- users who want ongoing protection keep paying.

| Job Type | Revenue per Job | Budget Flow |
|---|---|---|
| `hedge_analysis` | $0.01 | No fund transfer -- service-only |
| `execute_hedge` | $0.1 | Buyer's budget → Escrow → HedgeFi wallet → Limitless (buys shares) |
| `close_hedge` | $0.1 | HedgeFi wallet → Limitless (sells shares) → USDC returned to buyer |

**Recurring revenue:** Prediction market positions expire hourly/daily. Users who want ongoing protection must re-hedge, generating recurring job fees.

**Testing phase:** Budget cap is $5 max per hedge (configurable in `constants.ts` → `MAX_HEDGE_BUDGET_USD`).

