import type { AcpJob } from "@virtuals-protocol/acp-node";
import { Fare, FareAmount } from "@virtuals-protocol/acp-node";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { createLogger } from "../../utils/logger.ts";
import { STABLECOIN_SYMBOLS, USDC_BASE, ERC20_ABI, CHAIN_CONFIG, BASE_CHAIN_ID, MAX_HEDGE_BUDGET_USD } from "../../utils/constants.ts";

/**
 * Ensure the Fare object has chainId set (required by deliverPayable).
 * The SDK's deliverPayable checks fare.chainId to decide same-chain vs cross-chain.
 * If chainId is undefined, it incorrectly routes to cross-chain and fails.
 */
function ensureFareChainId(fare: InstanceType<typeof Fare>): InstanceType<typeof Fare> {
  if (!fare.chainId) {
    return new Fare(fare.contractAddress, fare.decimals, BASE_CHAIN_ID);
  }
  return fare;
}
import type {
  AnalysisResult,
  ExecuteHedgeRequirement,
  ExecuteHedgeDeliverable,
  HedgePlaced,
  ScoredLimitlessMarket,
  HedgePlanConfirmation,
} from "../../utils/types.ts";
import { LimitlessOrderSide, LimitlessOrderType } from "../../utils/types.ts";
import { readWalletBalances } from "../../portfolio/reader.ts";
import { getTokenPrices } from "../../portfolio/pricer.ts";
import { analyzeExposure, isStablecoinOnly, formatUsd } from "../../portfolio/analyzer.ts";
import { generateScenarioReasoning, generateEdgeCaseMessage } from "../../hedging/reasoning.ts";
import { findHedgingMarkets } from "../../limitless/markets.ts";
import { fetchMarketBySlug } from "../../limitless/client.ts";
import { placeHedgeOrder } from "../../limitless/orders.ts";
import { buildHedgeRecommendations, formatDiagnosticMessage } from "../../hedging/strategy.ts";
import { validateAndAdjustSizing, formatCoverageRatio } from "../../hedging/sizing.ts";
import { createPosition, recordOrder } from "../../db/positions.ts";
import { upsertJobState, setConfirmationSent, setDelivered, setFailed } from "../../db/job-state.ts";

const log = createLogger("execute-hedge");

// =============================================
// GTC threshold: use GTC for individual orders >= this amount
// =============================================
const GTC_ORDER_THRESHOLD_USD = 10;
const REDISTRIBUTION_THRESHOLD_USD = 0.10;
const MAX_REDISTRIBUTION_ROUNDS = 2;

// =============================================
// Agent wallet USDC balance check
// =============================================

async function getAgentUsdcBalance(): Promise<number> {
  const walletAddress = process.env.HEDGEFI_WALLET_ADDRESS;
  if (!walletAddress) return 0;

  const client = createPublicClient({
    chain: base,
    transport: http(CHAIN_CONFIG.base.rpcUrl),
  });

  const raw = await client.readContract({
    address: USDC_BASE,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [walletAddress as `0x${string}`],
  });

  return Number(raw) / 1e6; // USDC has 6 decimals
}

// =============================================
// Helpers
// =============================================

function parseRequirement(job: AcpJob): ExecuteHedgeRequirement {
  const raw = job.requirement;
  const fallback: ExecuteHedgeRequirement = {
    wallet_address: "0x0000000000000000000000000000000000000000",
    chain: "base",
    risk_tolerance: "moderate",
    hedge_budget_usdc: 50,
  };

  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return fallback; }
  }
  if (raw && typeof raw === "object") return raw as ExecuteHedgeRequirement;
  return fallback;
}

function formatExecutionNotification(
  hedgesPlaced: HedgePlaced[],
  summary: ExecuteHedgeDeliverable["summary"]
): string {
  if (hedgesPlaced.length === 0) {
    return "Hedge Execution: No positions opened. Budget returned.";
  }
  const marketNames = hedgesPlaced.map((h) => {
    const shortQ = h.market_question.length > 40
      ? h.market_question.slice(0, 37) + "..."
      : h.market_question;
    return shortQ;
  });
  return [
    `${hedgesPlaced.length} hedge(s) placed`,
    `Spent: $${formatUsd(summary.total_spent)}`,
    `Max payout: $${formatUsd(summary.total_max_coverage)}`,
    `Deployed: ${summary.deployment_ratio ?? "N/A"}`,
    `Markets: ${marketNames.join("; ")}`,
  ].join(" | ");
}

/**
 * Format a human-readable time-until string from an ISO expiry date.
 */
function formatExpiryHuman(expiryIso: string): string {
  const expiry = new Date(expiryIso);
  const now = Date.now();
  const diffMs = expiry.getTime() - now;

  if (diffMs <= 0) return "expired";

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  if (hours >= 48) return `in ${Math.floor(hours / 24)} days`;
  if (hours >= 1) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

/**
 * Format the hedge plan as a human-readable confirmation message.
 */
function formatConfirmationMessage(plan: HedgePlanConfirmation): string {
  const lines: string[] = [];

  lines.push("HEDGE PLAN FOR REVIEW");
  lines.push("=====================");
  lines.push(`Portfolio: $${formatUsd(plan.exposure.total_value_usd)} (${plan.exposure.top_exposure})`);
  lines.push(`Concentration Risk: ${plan.exposure.concentration_risk}`);
  lines.push(`Budget: $${formatUsd(plan.budget)} | Risk Tolerance: ${plan.risk_tolerance}`);
  lines.push("");
  lines.push("Proposed Orders:");

  for (let i = 0; i < plan.market_details.length; i++) {
    const detail = plan.market_details[i]!;
    lines.push(`${i + 1}. "${detail.market_question}" -- ${detail.action}`);
    lines.push(`   Est. ~${Math.round(detail.estimated_shares)} shares @ $${formatUsd(detail.estimated_cost_usd / Math.max(detail.estimated_shares, 1))}/share = $${formatUsd(detail.estimated_cost_usd)}`);
    lines.push(`   Max payout: $${formatUsd(detail.max_payout_usd)}`);
    lines.push(`   Expires: ${new Date(detail.expiry).toUTCString()} (${detail.expiry_human})`);
  }

  lines.push("");
  lines.push(`Estimated Total Cost: $${formatUsd(plan.estimated_total_cost)}`);
  lines.push(`Estimated Max Coverage: $${formatUsd(plan.estimated_total_coverage)} (${plan.coverage_ratio})`);
  const undeployed = plan.budget - plan.estimated_total_cost;
  if (undeployed > 0.01) {
    lines.push(`Estimated Undeployed: ~$${formatUsd(undeployed)}`);
  }

  if (plan.diagnostics_message) {
    lines.push("");
    lines.push(`Note: ${plan.diagnostics_message}`);
  }

  lines.push("");
  lines.push("Reply APPROVE to execute these hedges or REJECT to cancel with full refund.");

  return lines.join("\n");
}

/**
 * Try to reject with refund; fall back to delivering an error deliverable.
 */
async function rejectWithRefund(
  job: AcpJob,
  _jlog: ReturnType<ReturnType<typeof createLogger>["withJob"]>,
  reason: string,
  budgetUsdc: number
): Promise<void> {
  try {
    const payable = job.netPayableAmount;
    if (payable && payable > 0) {
      const fareAmount = new FareAmount(payable, ensureFareChainId(job.baseFare));
      await job.rejectPayable(reason, fareAmount);
      try { await job.createNotification(reason); } catch { /* non-fatal */ }
      return;
    }
  } catch { /* fall through */ }
  const deliverable: ExecuteHedgeDeliverable = {
    exposure: { total_value_usd: 0, tokens: [], concentration_risk: "low", top_exposure: "Error" },
    hedges_placed: [],
    summary: { total_spent: 0, total_max_coverage: 0, budget_remaining: budgetUsdc, coverage_ratio: reason },
    reasoning: reason,
  };
  await job.deliver(JSON.stringify(deliverable));
}

// =============================================
// Phase A: Analyze wallet and propose hedge plan
// =============================================

/**
 * Analyze wallet and build hedge plan. Returns an AnalysisResult:
 * - { type: "plan", message } for a successful hedge plan
 * - { type: "error", message } when hedging is not possible
 *
 * IMPORTANT: This function NEVER calls job.reject() because it runs
 * AFTER accept(). Calling reject() post-accept causes "Already signed"
 * nonce conflicts on the Alchemy proxy. The caller handles the result.
 *
 * Called during REQUEST phase so buyer sees the plan before paying.
 */
export async function handleExecuteHedgeAnalysis(job: AcpJob): Promise<AnalysisResult> {
  const jlog = log.withJob(job.id);
  jlog.info("Phase A: Analyzing wallet for hedge plan");

  const req = parseRequirement(job);
  jlog.info("Requirement parsed", req);

  // Track job state
  upsertJobState(String(job.id), {
    jobName: "execute_hedge",
    phase: "initialized",
    buyerAddress: job.clientAddress,
  });

  // Budget cap check (testing phase safety)
  if (req.hedge_budget_usdc > MAX_HEDGE_BUDGET_USD) {
    jlog.warn(`Budget $${req.hedge_budget_usdc} exceeds testing cap $${MAX_HEDGE_BUDGET_USD}`);
    setFailed(String(job.id));
    return {
      type: "error",
      message: `Budget cap: $${MAX_HEDGE_BUDGET_USD} max during testing phase. Requested: $${req.hedge_budget_usdc}. Please reduce your budget.`,
    };
  }

  try {
    // Step 1: Read real wallet exposure
    const tWallet = jlog.time("Read wallet balances");
    const rawBalances = await readWalletBalances(req.wallet_address, req.chain);
    const coingeckoIds = rawBalances.map((b) => b.coingeckoId);
    const prices = await getTokenPrices(coingeckoIds);
    const exposure = analyzeExposure(rawBalances, prices);
    tWallet.end();

    // Edge case: stablecoin-only portfolio
    if (isStablecoinOnly(exposure)) {
      jlog.info("Portfolio is stablecoin-only, cannot hedge");
      setFailed(String(job.id));
      const reasoning = generateEdgeCaseMessage("stablecoins_only", { totalValue: exposure.total_value_usd });
      return { type: "error", message: reasoning };
    }

    // Step 2: Scan Limitless markets + build strategy
    const tMarkets = jlog.time("Limitless market scan");
    let scoredMarkets: ScoredLimitlessMarket[] = [];
    try {
      scoredMarkets = await findHedgingMarkets(exposure);
    } catch (err) {
      jlog.warn("Failed to fetch Limitless markets", err);
    }
    tMarkets.end();

    // Edge case: no markets available
    if (scoredMarkets.length === 0) {
      jlog.info("No hedging markets found");
      setFailed(String(job.id));
      const topNonStable = exposure.tokens.find((t) => !STABLECOIN_SYMBOLS.has(t.symbol));
      const reasoning = generateEdgeCaseMessage("no_markets_found", { topAsset: topNonStable?.symbol ?? "your holdings" });
      return { type: "error", message: reasoning };
    }

    const { recommendations: rawRecommendations, diagnostics } = buildHedgeRecommendations(
      exposure, scoredMarkets, req.risk_tolerance, req.hedge_budget_usdc, prices
    );

    const { adjusted: recommendations, summary: sizingSummary } = validateAndAdjustSizing(
      rawRecommendations,
      { hedgeBudget: req.hedge_budget_usdc, riskTolerance: req.risk_tolerance, portfolioValueUsd: exposure.total_value_usd }
    );

    if (recommendations.length === 0) {
      jlog.info("No viable recommendations after sizing");
      setFailed(String(job.id));
      return { type: "error", message: "No viable hedge positions could be constructed within your budget and risk parameters." };
    }

    // Build the confirmation plan
    const diagMsg = formatDiagnosticMessage(diagnostics);
    const coverageRatio = formatCoverageRatio(sizingSummary, exposure.total_value_usd, req.risk_tolerance);

    const marketDetails = recommendations.map((rec) => {
      const market = scoredMarkets.find(
        (m) => m.slug === String(rec.market_id) || String(m.raw.id) === String(rec.market_id)
      );
      return {
        market_question: rec.market_question,
        action: rec.action,
        estimated_shares: rec.shares,
        estimated_cost_usd: rec.estimated_cost_usd,
        max_payout_usd: rec.coverage_usd,
        expiry: rec.expiry,
        expiry_human: formatExpiryHuman(rec.expiry),
        market_slug: market?.slug ?? String(rec.market_id),
      };
    });

    const plan: HedgePlanConfirmation = {
      exposure,
      recommendations,
      diagnostics_message: diagMsg,
      estimated_total_cost: recommendations.reduce((s, r) => s + r.estimated_cost_usd, 0),
      estimated_total_coverage: recommendations.reduce((s, r) => s + r.coverage_usd, 0),
      coverage_ratio: coverageRatio,
      budget: req.hedge_budget_usdc,
      risk_tolerance: req.risk_tolerance,
      market_details: marketDetails,
    };

    // Store the frozen plan for execution after buyer pays
    setConfirmationSent(String(job.id), JSON.stringify(plan));

    // Return the formatted plan text — caller will pass to createRequirement
    const confirmationMsg = formatConfirmationMessage(plan);
    jlog.info("Hedge plan built, returning to caller");
    return { type: "plan", message: confirmationMsg };

  } catch (err) {
    jlog.error("Failed during hedge analysis phase", err);
    setFailed(String(job.id));
    return {
      type: "error",
      message: `Hedge analysis failed: ${err instanceof Error ? err.message : "Unknown error"}. Please try again.`,
    };
  }
}

// =============================================
// Phase B: Execute confirmed hedge plan
// =============================================

export async function handleExecuteHedgeExecution(job: AcpJob): Promise<void> {
  const jlog = log.withJob(job.id);
  jlog.info("Phase B: Executing confirmed hedge plan");

  const req = parseRequirement(job);

  // Retrieve the frozen plan from job state
  const { getJobState } = await import("../../db/job-state.ts");
  const state = getJobState(String(job.id));
  if (!state?.confirmation_payload) {
    jlog.error("No confirmation payload found for confirmed job");
    await rejectWithRefund(job, jlog, "Internal error: hedge plan not found. Please retry.", req.hedge_budget_usdc);
    return;
  }

  let plan: HedgePlanConfirmation;
  try {
    plan = JSON.parse(state.confirmation_payload);
  } catch {
    jlog.error("Failed to parse stored confirmation payload");
    await rejectWithRefund(job, jlog, "Internal error: corrupted hedge plan. Please retry.", req.hedge_budget_usdc);
    return;
  }

  upsertJobState(String(job.id), { jobName: "execute_hedge", phase: "executing" });

  try {
    // Pre-check: verify agent wallet has enough USDC to cover the budget
    try {
      const agentBalance = await getAgentUsdcBalance();
      jlog.info(`Agent USDC balance: $${agentBalance.toFixed(2)}, budget: $${req.hedge_budget_usdc}`);
      if (agentBalance < req.hedge_budget_usdc) {
        jlog.warn(`Insufficient agent balance ($${agentBalance.toFixed(2)}) for budget ($${req.hedge_budget_usdc})`);
        await rejectWithRefund(
          job, jlog,
          `Insufficient agent liquidity ($${agentBalance.toFixed(2)} available) for requested budget ($${req.hedge_budget_usdc}). Please try again later or reduce budget.`,
          req.hedge_budget_usdc
        );
        setFailed(String(job.id));
        return;
      }
    } catch (balErr) {
      jlog.warn("Failed to check agent balance, proceeding anyway", balErr);
    }

    const { exposure, recommendations } = plan;

    // Re-fetch scored markets for venue/token data (needed for order placement)
    // The recommendations are frozen but we need live venue addresses
    const tOrders = jlog.time("Place hedge orders");
    const hedges_placed: HedgePlaced[] = [];
    let totalSpent = 0;
    let redistributionRounds = 0;

    // Collect successful market slugs for redistribution
    const successfulSlugs: string[] = [];

    // First pass: execute all recommended orders
    for (const rec of recommendations) {
      if (totalSpent >= req.hedge_budget_usdc) break;

      try {
        const detail = plan.market_details.find((d) => d.market_slug === rec.market_id || d.market_question === rec.market_question);
        let marketSlug = detail?.market_slug ?? String(rec.market_id);

        // Fetch market details for venue exchange address
        jlog.info(`Fetching market details for ${marketSlug}`);
        const fullMarket = await fetchMarketBySlug(marketSlug);
        const venueExchange = fullMarket.venue?.exchange;
        const tokensYes = fullMarket.tokens.yes;
        const tokensNo = fullMarket.tokens.no;

        if (!venueExchange) {
          jlog.warn(`No venue exchange address for market ${marketSlug}, skipping`);
          continue;
        }

        const tokenId = rec.action === "BUY_YES" ? tokensYes : tokensNo;
        if (!tokenId) {
          jlog.warn(`No token ID for ${rec.action} on market ${marketSlug}, skipping`);
          continue;
        }

        const remainingBudget = req.hedge_budget_usdc - totalSpent;
        const orderAmount = Math.min(rec.estimated_cost_usd, remainingBudget);

        // Determine order type: GTC for larger orders with expiration data
        const expirationTimestamp = fullMarket.expirationTimestamp;

        // Skip markets expiring within 5 minutes
        const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
        if (expirationTimestamp <= Date.now() + EXPIRY_BUFFER_MS) {
          jlog.warn(`Market ${marketSlug} expires in <5 min, skipping`);
          continue;
        }

        const useGtc = orderAmount >= GTC_ORDER_THRESHOLD_USD && expirationTimestamp > Date.now();
        const hedgePrice = rec.action === "BUY_YES"
          ? (fullMarket.prices?.[0] ?? null)
          : (fullMarket.prices?.[1] ?? null);

        if (hedgePrice === null || hedgePrice <= 0 || hedgePrice >= 1) {
          jlog.warn(`Invalid hedge price (${hedgePrice}) for ${marketSlug}, skipping`);
          continue;
        }

        const result = await placeHedgeOrder({
          marketSlug,
          tokenId,
          side: LimitlessOrderSide.BUY,
          usdcAmount: orderAmount,
          orderType: useGtc ? LimitlessOrderType.GTC : LimitlessOrderType.FOK,
          venueExchangeAddress: venueExchange,
          ...(useGtc ? { pricePerShare: hedgePrice, expirationTimestamp } : {}),
        });

        // Record in database
        const buyerAddress = job.clientAddress ?? "unknown";
        const positionId = createPosition({
          jobId: String(job.id),
          buyerAddress,
          marketSlug,
          marketTitle: rec.market_question,
          tokenId,
          side: rec.action === "BUY_YES" ? "YES" : "NO",
          action: rec.action,
          shares: result.filledSize,
          entryPrice: result.avgPrice,
          totalCostUsdc: result.totalCost,
          orderId: result.orderId,
          expiry: rec.expiry,
          venueExchange,
        });

        recordOrder({
          positionId,
          orderType: "open",
          marketSlug,
          side: LimitlessOrderSide.BUY,
          makerAmount: String(Math.ceil(orderAmount * 1e6)),
          takerAmount: "1",
          price: result.avgPrice,
          filledSize: result.filledSize,
          orderId: result.orderId,
          status: result.matched ? "filled" : "placed",
        });

        hedges_placed.push({
          market_id: rec.market_id,
          market_question: rec.market_question,
          action: rec.action,
          shares_bought: result.filledSize,
          price_per_share: result.avgPrice,
          total_cost_usd: result.totalCost,
          max_payout_usd: result.filledSize / 1e6,
          order_id: result.orderId,
          tx_hash: `limitless:${result.orderId}`,
          expiry: rec.expiry,
          expiry_human: formatExpiryHuman(rec.expiry),
          market_slug: marketSlug,
        });

        totalSpent += result.totalCost;
        successfulSlugs.push(marketSlug);
        jlog.info(`Hedge placed for ${marketSlug}`, {
          orderId: result.orderId,
          filledSize: result.filledSize,
          cost: result.totalCost,
          orderType: useGtc ? "GTC" : "FOK",
        });
      } catch (err) {
        jlog.error(`Failed to place order for market ${rec.market_id}`, err);
        // Stop placing orders if we're out of collateral — subsequent orders will also fail
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("Insufficient collateral") || errMsg.includes("Insufficient balance")) {
          jlog.warn("Stopping order placement — insufficient collateral on exchange");
          break;
        }
      }
    }

    // Budget redistribution: retry remaining budget on successful markets
    while (
      redistributionRounds < MAX_REDISTRIBUTION_ROUNDS &&
      (req.hedge_budget_usdc - totalSpent) > REDISTRIBUTION_THRESHOLD_USD &&
      successfulSlugs.length > 0
    ) {
      redistributionRounds++;
      const remaining = req.hedge_budget_usdc - totalSpent;
      jlog.info(`Redistribution round ${redistributionRounds}: $${remaining.toFixed(2)} remaining`);

      // Retry on the first successful market (most likely to accept more)
      const retrySlug = successfulSlugs[0]!;
      try {
        const fullMarket = await fetchMarketBySlug(retrySlug);
        const venueExchange = fullMarket.venue?.exchange;
        if (!venueExchange) break;

        // Find the matching recommendation for token selection
        const matchingRec = recommendations.find((r) => {
          const detail = plan.market_details.find((d) => d.market_slug === retrySlug);
          return detail?.market_question === r.market_question;
        });
        if (!matchingRec) break;

        const tokenId = matchingRec.action === "BUY_YES" ? fullMarket.tokens.yes : fullMarket.tokens.no;
        if (!tokenId) break;

        const result = await placeHedgeOrder({
          marketSlug: retrySlug,
          tokenId,
          side: LimitlessOrderSide.BUY,
          usdcAmount: remaining,
          orderType: LimitlessOrderType.FOK,
          venueExchangeAddress: venueExchange,
        });

        if (result.totalCost > 0) {
          const buyerAddress = job.clientAddress ?? "unknown";
          const positionId = createPosition({
            jobId: String(job.id),
            buyerAddress,
            marketSlug: retrySlug,
            marketTitle: matchingRec.market_question,
            tokenId,
            side: matchingRec.action === "BUY_YES" ? "YES" : "NO",
            action: matchingRec.action,
            shares: result.filledSize,
            entryPrice: result.avgPrice,
            totalCostUsdc: result.totalCost,
            orderId: result.orderId,
            expiry: matchingRec.expiry,
            venueExchange,
          });

          recordOrder({
            positionId,
            orderType: "open",
            marketSlug: retrySlug,
            side: LimitlessOrderSide.BUY,
            makerAmount: String(Math.ceil(remaining * 1e6)),
            takerAmount: "1",
            price: result.avgPrice,
            filledSize: result.filledSize,
            orderId: result.orderId,
            status: result.matched ? "filled" : "placed",
          });

          hedges_placed.push({
            market_id: matchingRec.market_id,
            market_question: matchingRec.market_question,
            action: matchingRec.action,
            shares_bought: result.filledSize,
            price_per_share: result.avgPrice,
            total_cost_usd: result.totalCost,
            max_payout_usd: result.filledSize / 1e6,
            order_id: result.orderId,
            tx_hash: `limitless:${result.orderId}`,
            expiry: matchingRec.expiry,
            expiry_human: formatExpiryHuman(matchingRec.expiry),
            market_slug: retrySlug,
          });

          totalSpent += result.totalCost;
          jlog.info(`Redistribution fill on ${retrySlug}`, { cost: result.totalCost, remaining: req.hedge_budget_usdc - totalSpent });
        } else {
          break; // No fill, stop redistributing
        }
      } catch (err) {
        jlog.warn(`Redistribution order failed on ${retrySlug}`, err);
        break;
      }
    }

    tOrders.end();

    // If all orders failed but we had recommendations, refund
    if (hedges_placed.length === 0 && recommendations.length > 0) {
      jlog.warn(`All ${recommendations.length} orders failed to fill`);
      setFailed(String(job.id));
      await rejectWithRefund(
        job, jlog,
        "All hedge orders failed to execute on Limitless Exchange. No positions were opened. Full refund issued.",
        req.hedge_budget_usdc
      );
      return;
    }

    // Generate POST-EXECUTION reasoning
    const tReasoning = jlog.time("AI reasoning generation");
    let reasoning: string;
    if (hedges_placed.length > 0) {
      reasoning = await generateScenarioReasoning({
        type: "post_hedge_summary",
        exposure,
        hedgesPlaced: hedges_placed,
        summary: {
          totalSpent: Math.round(totalSpent * 100) / 100,
          totalMaxCoverage: hedges_placed.reduce((s, h) => s + h.max_payout_usd, 0),
          budgetRemaining: Math.round((req.hedge_budget_usdc - totalSpent) * 100) / 100,
        },
      });
    } else {
      reasoning = await generateScenarioReasoning({
        type: "exposure_analysis",
        exposure,
        riskTolerance: req.risk_tolerance,
      });
    }
    tReasoning.end();

    if (plan.diagnostics_message) {
      reasoning += `\n\nNote: ${plan.diagnostics_message}`;
    }

    // Budget accountability
    const undeployedUsdc = Math.round((req.hedge_budget_usdc - totalSpent) * 100) / 100;
    const deploymentPct = req.hedge_budget_usdc > 0
      ? Math.round((totalSpent / req.hedge_budget_usdc) * 1000) / 10
      : 0;

    const deliverable: ExecuteHedgeDeliverable = {
      exposure,
      hedges_placed,
      summary: {
        total_spent: Math.round(totalSpent * 100) / 100,
        total_max_coverage: hedges_placed.reduce((s, h) => s + h.max_payout_usd, 0),
        budget_remaining: undeployedUsdc,
        coverage_ratio: plan.coverage_ratio,
        undeployed_usdc: undeployedUsdc,
        deployment_ratio: `${deploymentPct}% of budget deployed`,
        redistribution_rounds: redistributionRounds,
      },
      reasoning,
    };

    jlog.info("Delivering execute_hedge result");

    // Return undeployed budget to buyer via deliverPayable if there's a meaningful remainder
    const UNDEPLOYED_RETURN_THRESHOLD = 0.01; // $0.01 minimum to bother returning
    if (undeployedUsdc > UNDEPLOYED_RETURN_THRESHOLD) {
      const fareAmount = new FareAmount(undeployedUsdc, ensureFareChainId(job.baseFare));
      await job.deliverPayable(JSON.stringify(deliverable), fareAmount);
      jlog.info(`Delivered with undeployed budget return ($${undeployedUsdc.toFixed(2)})`);
    } else {
      await job.deliver(JSON.stringify(deliverable));
      jlog.info("Delivered (full budget deployed)");
    }
    setDelivered(String(job.id));

    // Notification memo
    try {
      const notifMsg = formatExecutionNotification(hedges_placed, deliverable.summary);
      await job.createNotification(notifMsg);
      jlog.info("Notification memo sent");
    } catch (notifErr) {
      jlog.warn("Failed to send notification memo", notifErr);
    }
  } catch (err) {
    jlog.error("Failed during hedge execution phase", err);
    setFailed(String(job.id));

    try {
      const payable = job.netPayableAmount;
      if (payable && payable > 0) {
        const fareAmount = new FareAmount(payable, ensureFareChainId(job.baseFare));
        await job.rejectPayable(
          `Hedge execution failed: ${err instanceof Error ? err.message : "Unknown error"}`,
          fareAmount
        );
        jlog.info("Refund issued via rejectPayable");
      } else {
        const errorDeliverable: ExecuteHedgeDeliverable = {
          exposure: { total_value_usd: 0, tokens: [], concentration_risk: "low", top_exposure: "Error reading portfolio" },
          hedges_placed: [],
          summary: { total_spent: 0, total_max_coverage: 0, budget_remaining: req.hedge_budget_usdc, coverage_ratio: "Error: execution failed" },
          reasoning: `Failed to execute hedge: ${err instanceof Error ? err.message : "Unknown error"}. Please try again.`,
        };
        await job.deliver(JSON.stringify(errorDeliverable));
      }
    } catch (rejectErr) {
      jlog.error("Failed to reject/deliver error", rejectErr);
      try {
        const errorDeliverable: ExecuteHedgeDeliverable = {
          exposure: { total_value_usd: 0, tokens: [], concentration_risk: "low", top_exposure: "Error" },
          hedges_placed: [],
          summary: { total_spent: 0, total_max_coverage: 0, budget_remaining: req.hedge_budget_usdc, coverage_ratio: "Error" },
          reasoning: `Failed to execute hedge: ${err instanceof Error ? err.message : "Unknown error"}.`,
        };
        await job.deliver(JSON.stringify(errorDeliverable));
      } catch { /* truly fatal */ }
    }

    try {
      await job.createNotification(
        `Hedge Execution Failed: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    } catch { /* non-fatal */ }
  }
}
