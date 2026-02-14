<p align="center">
  <img src="logo.png" alt="HedgeFi" width="120" />
</p>

<h1 align="center">HedgeFi</h1>

<p align="center">
  <strong>Autonomous portfolio insurance agent on Virtuals ACP</strong><br/>
  Hedges crypto portfolios using prediction markets on Limitless Exchange
</p>

<p align="center">
  <a href="https://app.virtuals.io/acp">ACP Service Registry</a> &middot;
  <a href="https://limitless.exchange">Limitless Exchange</a> &middot;
  <a href="https://whitepaper.virtuals.io/acp-product-resources/introducing-acp-v2/acp-v2-prediction-market-use-case">ACP v2 Prediction Market Guide</a>
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

```
USER                  BUTLER               ACP ESCROW           HEDGEFI              LIMITLESS
 |                      |                      |                   |                    |
 | "Hedge my ETH"       |                      |                   |                    |
 |--------------------->|                      |                   |                    |
 |                      | Create Fund-Transfer |                   |                    |
 |                      | Job + deposit USDC   |                   |                    |
 |                      |--------------------->|                   |                    |
 |                      |                      | Release funds     |                    |
 |                      |                      |------------------>|                    |
 |                      |                      |                   | Read wallet        |
 |                      |                      |                   | Scan markets       |
 |                      |                      |                   | Place EIP-712      |
 |                      |                      |                   | signed orders      |
 |                      |                      |                   |------------------>|
 |                      |                      |                   |    Shares filled   |
 |                      |                      |                   |<------------------|
 |                      |                      |   Deliver result  |                    |
 |                      |                      |<------------------|                    |
 |                      |  Hedge report + AI   |                   |                    |
 |<---------------------|  reasoning           |                   |                    |
```

**Three wallets, zero key sharing:**

| Wallet | Owner | Purpose |
|---|---|---|
| User's wallet | Human | Holds portfolio. Funds Butler. Can be any external address. |
| Butler agent wallet | Virtuals | Routes USDC from user to ACP escrow. |
| HedgeFi agent wallet | Us | Receives USDC, signs Limitless orders, holds positions. |

The user **never** shares their private key. HedgeFi reads wallet balances via public RPC calls and trades with its own agent wallet using the user's deposited USDC.

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
# Required -- Agent identity
HEDGEFI_PRIVATE_KEY=0x...           # 64-char hex private key (Base)
HEDGEFI_ENTITY_ID=...               # Numeric entity ID from ACP registry
HEDGEFI_WALLET_ADDRESS=0x...        # Agent wallet address

# Optional -- Test buyer
BUYER_PRIVATE_KEY=0x...
BUYER_ENTITY_ID=...
BUYER_WALLET_ADDRESS=0x...

# Optional -- AI reasoning (falls back to templates if missing)
GEMINI_API_KEY=...

# Optional -- RPC endpoints (defaults to public RPCs)
BASE_RPC_URL=https://...
ETH_RPC_URL=https://...
ARB_RPC_URL=https://...
ALCHEMY_API_KEY=...

# Optional -- CoinGecko (free tier works without key)
COINGECKO_API_KEY=...

# Optional -- Resource server port (default: 3001)
RESOURCE_PORT=3001
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

| Job Type | Revenue per Job | Frequency |
|---|---|---|
| `hedge_analysis` | $0.10 | Per analysis request |
| `execute_hedge` | $0.50 + hedge budget flow | Per hedge placement |
| `close_hedge` | $0.25 | Per position close |

---

## Supported Assets

| Asset | Symbol | Chains | Hedging Via |
|---|---|---|---|
| Ethereum | WETH/ETH | Base, Ethereum, Arbitrum | Limitless ETH markets |
| Bitcoin | WBTC/cbBTC | Base, Ethereum, Arbitrum | Limitless BTC markets |
| Chainlink | LINK | Ethereum, Arbitrum | Limitless LINK markets |
| Uniswap | UNI | Ethereum, Arbitrum | Limitless UNI markets |
| Arbitrum | ARB | Arbitrum | Limitless ARB markets |
| Aave | AAVE | Ethereum, Arbitrum | Limitless AAVE markets |

Stablecoins (USDC, USDT, DAI) are detected but excluded from hedging -- they have no directional risk.

---

## SDK Bug Reports

Issues found and reported to the Virtuals team:

1. **AJV "Address" Format Crash** -- The ACP UI generates `format: "address"` in JSON schemas, but the SDK's AJV validator doesn't register this format. **Workaround:** Use "Plain" subtype instead.

2. **Double `init()` Duplicate Sockets** -- The constructor calls `this.init()` without `await`. If you also call `await acpClient.init()`, two sockets are created. **Fix:** Pass `skipSocketConnection: true` in constructor, then call `await client.init()`.

---

## Judging Criteria

| Criteria | How HedgeFi Delivers |
|---|---|
| Executes trades / DeFi actions | Places real EIP-712 signed orders on Limitless Exchange |
| Risk controls | Position sizing, budget caps, slippage protection, diversification |
| Explains why it acted | Gemini AI reasoning on every hedge decision in plain English |
| Auditable trail | ACP memos on-chain + Limitless order IDs + full job history in SQLite |
| Multiple data sources | Wallet balances (viem), token prices (CoinGecko), prediction markets (Limitless), AI (Gemini) |
| Customized for users | 3 risk levels, configurable budgets, any wallet address, per-user ACP accounts |
| Live product | Butler routes real users to HedgeFi. Zero competition on ACP. |
| Revenue generation | Every job = ACP payment. Recurring because hedges expire daily. |
| ACP multiplier (2x) | Full ACP v2: Fund-Transfer Jobs, Resources, Notifications, Evaluation |
| Virtuals launch multiplier (2x) | Standard Launch as $HEDGE |

---

<p align="center">
  Built for the Virtuals Protocol Hackathon<br/>
  <strong>HedgeFi</strong> -- portfolio insurance on autopilot
</p>
