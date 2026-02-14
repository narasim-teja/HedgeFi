# HedgeFi -- Technical


**HedgeFi autonomously hedges crypto portfolios using prediction market positions on Limitless Exchange, running on Virtuals ACP v2.**

---

## 1. DeFi Action Executed

HedgeFi executes **real on-chain trades** on Limitless Exchange (Base chain):

- **BUY YES/NO shares** -- prediction market conditional tokens (ERC-1155) acting as binary options for downside protection
- **SELL shares** -- closes hedge positions, returns USDC to buyer
- **ERC-20 USDC approvals** -- approves Limitless Exchange contract to spend agent's USDC
- **ERC-1155 approvals** -- approves conditional token transfers when selling positions
- **EIP-712 signed orders** -- cryptographically signed off-chain orders submitted to Limitless CLOB (Fill-or-Kill and Good-Til-Cancel)

Every order is signed with the agent's external wallet private key and settled on-chain by the Limitless Exchange contract.

> **Code:** `src/limitless/orders.ts` (order building + EIP-712 signing), `src/limitless/approvals.ts` (token approvals), `src/acp/jobs/execute-hedge.ts` (full execution flow)

---

## 2. Risk Controls & Safeguards

### Budget Cap

$5 maximum hedge budget during testing phase. Enforced before any trade is placed.

> **Code:** `src/utils/constants.ts:227` -- `MAX_HEDGE_BUDGET_USD = 5`
> **Enforcement:** `src/acp/jobs/execute-hedge.ts:232-240` -- rejects jobs exceeding cap

### Human Approval (Two-Phase Flow)

Buyers always review the full hedge plan before paying. The agent analyzes the portfolio, builds a plan with specific markets/costs/coverage, and presents it. The buyer can APPROVE (pay and proceed) or REJECT (cancel with zero cost).

> **Code:** `src/acp/jobs/execute-hedge.ts:205-347` (Phase A: build plan) and `src/acp/jobs/execute-hedge.ts:353-752` (Phase B: execute after payment)

### Price Validation

Rejects shares priced at $0 (worthless) or $1 (no hedging value -- outcome already determined). Only trades shares with genuine hedging potential.

> **Code:** `src/acp/jobs/execute-hedge.ts:450-457`

### Market Expiry Buffer

Skips markets expiring within 5 minutes to avoid settlement risk.

> **Code:** `src/acp/jobs/execute-hedge.ts:442-447`

### Position Sizing

No single market gets more than 50% of the hedge budget. Allocation is proportional to hedge score with liquidity caps.

> **Code:** `src/hedging/strategy.ts:217-218` (50% cap), `src/hedging/strategy.ts:295-352` (allocation logic), `src/hedging/sizing.ts:27-93` (validation + adjustment)

### Balance Check Before Trading

Agent checks its USDC balance on-chain before placing any orders. If insufficient, refunds the buyer's full budget via `rejectPayable`.

> **Code:** `src/acp/jobs/execute-hedge.ts:381-396`

### Per-Buyer Concurrency Lock

Serializes fund-transfer jobs per buyer address to prevent double-sells and race conditions. Different buyers run in parallel.

> **Code:** `src/utils/job-lock.ts:1-50`, enforced at `src/acp/handlers.ts:228,231`

### Insufficient Collateral Detection

Stops order placement immediately if the exchange reports insufficient collateral, preventing failed transactions.

> **Code:** `src/acp/jobs/execute-hedge.ts:525-531`

### NaN/Infinity Guards

All P&L and financial calculations use `sanitizeNumber()` and `safeDivide()` to prevent NaN/Infinity propagation.

> **Code:** `src/utils/math.ts:1-16`

### Budget Accountability

Any undeployed USDC (from partially filled orders or skipped markets) is automatically returned to the buyer via ACP's `deliverPayable`.

> **Code:** `src/acp/jobs/execute-hedge.ts:691-700`

---

## 3. Explainability -- Why It Acted

HedgeFi uses **Gemini 2.0 Flash** to generate natural-language reasoning for every action, with template fallbacks if the AI service is unavailable.

The AI reasoning explains:
- **Why these markets were chosen** -- strike proximity, payout ratio, expiry timing
- **Why this sizing** -- portfolio weight, risk tolerance, budget constraints
- **Post-execution summary** -- what was hedged, coverage achieved, what-if scenarios
- **Position close reasoning** -- realized P&L context, whether hedge served its purpose

Every deliverable includes a `reasoning` field alongside the raw position data, so the buyer always knows why the agent acted the way it did.

> **Code:** `src/hedging/reasoning.ts` (Gemini integration + prompt engineering), template fallbacks at lines 141-176

---

## 4. Auditable Trail

### Database Records

Every trade creates permanent records across three tables:

| Table | What It Stores |
|---|---|
| `positions` | Position ID, job ID, buyer address, market slug, token ID, side, shares, entry price, cost, order ID, status, close price, realized P&L |
| `order_history` | Order ID, position ID, order type (open/close), market, side, amounts, price, fill size, status |
| `job_state` | Job ID, job name, phase, buyer address, frozen confirmation payload, timestamps |

> **Code:** `src/db/schema.ts` (table definitions), `src/db/positions.ts` (CRUD), `src/db/job-state.ts` (job lifecycle)

### Order IDs

Every Limitless order returns a unique order ID (e.g., `7f789759-96fa-47a6-90b7-ad1a96139429`) that maps to the on-chain settlement. These are stored in both the `positions` and `order_history` tables.

### Structured Logging

All operations are logged with job ID context, timestamps, and structured metadata:

```
[2026-02-14T07:03:28.023Z] [INFO] [limitless-orders] Order placed: 7f789759-... {"matched":true,"filledSize":617283,"totalCost":0.25}
```

> **Code:** `src/utils/logger.ts` (logger with `withJob()` method for job-scoped logs)

### Deliverables

Every job result includes full position details (market, shares, price, cost, payout, expiry, order ID) plus AI reasoning, sent back to the buyer as a structured JSON deliverable.

---

## 5. Performance Logic & Objective Function

### Objective: Maximize coverage-to-cost ratio within the user's budget and risk tolerance

HedgeFi optimizes for **maximum downside protection per dollar spent**, subject to:
- User's risk tolerance (conservative/moderate/aggressive)
- Budget constraints
- Available market liquidity
- Position diversification

### Multi-Factor Market Scoring (0-100 points)

Each candidate market is scored on four factors:

| Factor | Weight | What It Measures |
|---|---|---|
| Payout ratio | 0-35 pts | How much $1 of premium buys in coverage ($10 payout per $1 cost = 35 pts) |
| Liquidity | 0-25 pts | Market depth ($1000+ = 25 pts, $50 = 10 pts) |
| Expiry timing | 0-20 pts | Sweet spot is 1-24 hours (20 pts); avoids near-expiry and far-dated |
| Cost efficiency | 0-20 pts | Share price ($0.10 = 20 pts, $0.35 = 10 pts) |

> **Code:** `src/limitless/markets.ts:164-204` -- `computeHedgeScore()` function

### Budget Optimization

After initial placement, HedgeFi runs up to 2 **redistribution rounds** -- retrying undeployed budget on the best-performing markets to maximize deployment ratio.

> **Code:** `src/acp/jobs/execute-hedge.ts:535-625`

### Metrics in Every Deliverable

| Metric | Description |
|---|---|
| `coverage_ratio_pct` | Total hedge coverage as % of portfolio value |
| `budget_utilization_pct` | % of budget successfully deployed |
| `cost_efficiency` | Coverage dollars per cost dollar |
| `deployment_ratio` | Final deployment after redistribution |

> **Code:** `src/hedging/sizing.ts:76-89`

---

## 6. Multiple Data Sources + Reasoning

HedgeFi combines **four data sources** with **AI reasoning** to make informed hedging decisions:

| Source | Purpose | Code |
|---|---|---|
| **On-chain RPC** (viem multicall) | Read wallet token balances across Base/Ethereum/Arbitrum | `src/portfolio/reader.ts` |
| **CoinGecko API** | Live token prices in USD for exposure calculation | `src/portfolio/pricer.ts` |
| **Limitless Exchange API** | Active prediction markets, prices, liquidity, order book | `src/limitless/client.ts` |
| **Gemini 2.0 Flash** | AI reasoning to explain strategy, analyze risk, generate recommendations | `src/hedging/reasoning.ts` |

The agent doesn't just execute -- it **researches** (reads wallet, fetches prices, scans markets), **analyzes** (exposure risk, concentration, market scoring), **reasons** (AI-generated strategy explanation), and **then** executes.

---

## 7. Autonomous & Customized User Services

### Per-User Customization

Every hedge is tailored to the user's specific inputs:

| Parameter | How It Affects the Hedge |
|---|---|
| `wallet_address` | Reads that specific wallet's holdings to calculate exposure |
| `risk_tolerance` | Conservative = wider strikes, more diversification. Aggressive = deeper OTM, cheaper premiums |
| `hedge_budget_usdc` | Sizes positions to fit budget with proportional allocation |
| `market_timeframe` | Filters to hourly, daily, or weekly markets based on user preference |
| `chain` | Reads balances from Base, Ethereum, or Arbitrum |

> **Code:** `src/utils/constants.ts:199-215` (risk tolerance configs + timeframe bounds), `src/hedging/strategy.ts:22-40` (per-tolerance strategy configs)

### Autonomous Lifecycle

HedgeFi handles the full lifecycle without human intervention:
1. **Analyze** -- portfolio reading + risk assessment
2. **Recommend** -- market scanning + scoring + sizing
3. **Execute** -- order signing + placement + redistribution
4. **Track** -- position storage + status management
5. **Close** -- sell shares + return funds + P&L reporting

---

## 8. ACP v2 Integration

HedgeFi is built on **Virtuals ACP v2** with full fund-transfer support:

- **Payable requirements** -- `createPayableRequirement()` for buyer-approved fund transfers
- **Fund delivery** -- `deliverPayable()` to return undeployed budget and close proceeds
- **Refund on failure** -- `rejectPayable()` when execution fails
- **Job lifecycle** -- REQUEST (analyze) -> TRANSACTION (execute) -> EVALUATION (verify)
- **Per-buyer locking** -- serialized fund-transfer jobs prevent race conditions
- **External wallet trading** -- standard ACP pattern using agent's EOA on Base

### Three Job Offerings

| Job | Type | What It Does |
|---|---|---|
| `hedge_analysis` | Service-only | Read-only portfolio analysis + hedge recommendations |
| `execute_hedge` | Fund-transfer | Full hedge execution on Limitless Exchange |
| `close_hedge` | Fund-transfer | Sell positions + return USDC to buyer |

