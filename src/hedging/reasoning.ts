import { GoogleGenAI } from "@google/genai";
import { createLogger } from "../utils/logger.ts";
import { formatUsd } from "../portfolio/analyzer.ts";
import type {
  PortfolioExposure,
  HedgeRecommendation,
  HedgePlaced,
  PositionClosed,
} from "../utils/types.ts";

const log = createLogger("reasoning");

// =============================================
// Gemini client singleton
// =============================================

let genai: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!genai) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("Missing GEMINI_API_KEY environment variable");
    }
    genai = new GoogleGenAI({ apiKey });
  }
  return genai;
}

// =============================================
// Scenario types
// =============================================

export type ReasoningScenario =
  | { type: "exposure_analysis"; exposure: PortfolioExposure; riskTolerance: string }
  | { type: "hedge_recommendation"; exposure: PortfolioExposure; riskTolerance: string; recommendations: HedgeRecommendation[] }
  | { type: "post_hedge_summary"; exposure: PortfolioExposure; hedgesPlaced: HedgePlaced[]; summary: { totalSpent: number; totalMaxCoverage: number; budgetRemaining: number } }
  | { type: "position_close"; positionsClosed: PositionClosed[]; totalReturned: number };

export type EdgeCaseType =
  | "stablecoins_only"
  | "no_markets_found"
  | "budget_too_small"
  | "liquidity_too_thin"
  | "no_holdings";

// =============================================
// Scenario-specific system prompts
// =============================================

const BASE_PERSONA = `You are a DeFi risk analyst working for HedgeFi, an autonomous portfolio hedging agent.
HedgeFi uses prediction markets on Limitless Exchange to construct hedges — buying YES/NO shares that pay $1 each if the outcome triggers.
Do NOT include disclaimers or financial advice warnings. Speak directly to the user ("Your portfolio...", "You are exposed to...").
Be concise: 2-3 short paragraphs maximum.`;

const SCENARIO_PROMPTS: Record<ReasoningScenario["type"], string> = {
  exposure_analysis: `${BASE_PERSONA}

Your task: Analyze portfolio exposure and explain the risks in plain English.
Focus on:
- Concentration risk: is the portfolio dominated by one volatile asset?
- What specific price movements would hurt this portfolio the most?
- Quantify the impact: "A 10% drop in ETH would reduce your portfolio by ~$X."
- If well-diversified, say so.

Structure: 1) Portfolio summary, 2) Key risk identification with numbers, 3) What hedging could help with.`,

  hedge_recommendation: `${BASE_PERSONA}

Your task: Explain the recommended hedge strategy and why each market was chosen.
Focus on:
- Why each specific prediction market protects against the identified risk
- The cost vs coverage tradeoff: what you pay vs what you get if the hedge triggers
- How prediction market payouts work: "If ETH drops below $X, these shares pay $1 each, offsetting your loss."
- The strike price selection: why this particular level was chosen relative to current price

Structure: 1) Strategy summary (one sentence), 2) Market-by-market explanation, 3) Net protection achieved and cost.`,

  post_hedge_summary: `${BASE_PERSONA}

Your task: Summarize the hedge positions that were just placed and what protection is now active.
Focus on:
- What protection is now in place and for how long
- Before/after risk comparison: maximum loss without hedge vs with hedge
- What happens at expiry: if hedge triggers (shares pay $1), if it doesn't (premium lost as insurance cost)
- Be reassuring but honest about coverage limits

Structure: 1) "You're now protected against..." summary, 2) Cost and coverage numbers, 3) What to expect at expiry.`,

  position_close: `${BASE_PERSONA}

Your task: Explain the results of closing hedge positions.
Focus on:
- Whether the hedge was profitable or expired as insurance
- P&L breakdown: what was spent vs what was returned
- If the hedge paid out, explain how it offset portfolio losses
- If it expired worthless, frame it as insurance premium — the portfolio stayed healthy

Structure: 1) Outcome summary, 2) P&L numbers, 3) Brief forward-looking note.`,
};

// =============================================
// Main scenario reasoning function
// =============================================

export async function generateScenarioReasoning(scenario: ReasoningScenario): Promise<string> {
  const systemPrompt = SCENARIO_PROMPTS[scenario.type];
  const userPrompt = buildUserPrompt(scenario);

  try {
    const client = getClient();
    const t = log.time(`Gemini reasoning (${scenario.type})`);

    const response = await client.models.generateContent({
      model: "gemini-2.0-flash",
      contents: userPrompt,
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: 600,
        temperature: 0.7,
      },
    });

    t.end();

    const text = response.text;
    if (!text) {
      log.warn(`Gemini returned empty response for ${scenario.type}, using fallback`);
      return generateFallbackReasoning(scenario);
    }

    log.info(`Reasoning generated for ${scenario.type}`);
    return text.trim();
  } catch (err) {
    log.error(`Gemini API failed for ${scenario.type}, using fallback`, err);
    return generateFallbackReasoning(scenario);
  }
}

// =============================================
// Backward-compatible wrapper
// =============================================

export async function generateReasoning(
  exposure: PortfolioExposure,
  riskTolerance: string,
  recommendations?: HedgeRecommendation[]
): Promise<string> {
  if (recommendations && recommendations.length > 0) {
    return generateScenarioReasoning({
      type: "hedge_recommendation",
      exposure,
      riskTolerance,
      recommendations,
    });
  }
  return generateScenarioReasoning({
    type: "exposure_analysis",
    exposure,
    riskTolerance,
  });
}

// =============================================
// Deterministic edge case messages (no Gemini)
// =============================================

export function generateEdgeCaseMessage(
  edgeCase: EdgeCaseType,
  context: Record<string, unknown>
): string {
  switch (edgeCase) {
    case "stablecoins_only":
      return (
        `Your portfolio is 100% in stablecoins ($${formatUsd(context.totalValue as number)}). ` +
        `Stablecoins are pegged to the US dollar, so there's no directional market risk to hedge against. ` +
        `No action needed — your holdings are already in a risk-off position.`
      );

    case "no_markets_found":
      return (
        `No suitable prediction markets are currently available on Limitless Exchange to hedge ` +
        `your ${context.topAsset ?? "portfolio"} exposure. Markets for major crypto assets typically ` +
        `appear during active trading hours with hourly and daily expiries. ` +
        `HedgeFi will be able to construct hedges when matching markets are listed.`
      );

    case "budget_too_small": {
      const budget = context.budget as number;
      const minRec = context.minRecommended as number;
      return (
        `Your $${formatUsd(budget)} hedge budget is too small for meaningful coverage. ` +
        `At current market prices, the minimum recommended budget is $${formatUsd(minRec)} ` +
        `to achieve basic downside protection. Consider increasing your budget for effective hedging.`
      );
    }

    case "liquidity_too_thin": {
      const ticker = context.ticker as string;
      const liquidity = context.liquidity as number;
      return (
        `The best available market for ${ticker} has only $${formatUsd(liquidity)} in liquidity. ` +
        `To avoid excessive slippage, position sizes have been reduced. ` +
        `Your actual coverage may be lower than optimal — consider waiting for deeper liquidity.`
      );
    }

    case "no_holdings":
      return (
        `No significant token holdings were detected in this wallet on ${context.chain ?? "the specified chain"}. ` +
        `Please verify the wallet address and chain are correct. ` +
        `HedgeFi reads on-chain balances for major tokens (ETH, WBTC, USDC, LINK, UNI, ARB, AAVE).`
      );
  }
}

// =============================================
// Scenario-specific user prompts
// =============================================

function buildUserPrompt(scenario: ReasoningScenario): string {
  switch (scenario.type) {
    case "exposure_analysis":
      return buildExposurePrompt(scenario.exposure, scenario.riskTolerance);

    case "hedge_recommendation":
      return buildRecommendationPrompt(
        scenario.exposure,
        scenario.riskTolerance,
        scenario.recommendations
      );

    case "post_hedge_summary":
      return buildPostHedgePrompt(
        scenario.exposure,
        scenario.hedgesPlaced,
        scenario.summary
      );

    case "position_close":
      return buildClosePrompt(scenario.positionsClosed, scenario.totalReturned);
  }
}

function buildExposurePrompt(exposure: PortfolioExposure, riskTolerance: string): string {
  return `Analyze this portfolio exposure and explain the risks:

Portfolio Total Value: $${formatUsd(exposure.total_value_usd)}
Concentration Risk: ${exposure.concentration_risk}
Top Exposure: ${exposure.top_exposure}
Risk Tolerance: ${riskTolerance}

Token Holdings:
${exposure.tokens
  .map(
    (t) =>
      `- ${t.symbol}: ${t.balance} ($${formatUsd(t.value_usd)}, ${t.percentage}%)`
  )
  .join("\n")}

No prediction market hedges are being recommended yet — focus on explaining the portfolio risks and what price movements would hurt most.`;
}

function buildRecommendationPrompt(
  exposure: PortfolioExposure,
  riskTolerance: string,
  recommendations: HedgeRecommendation[]
): string {
  return `Analyze this portfolio and explain the recommended hedges:

Portfolio Total Value: $${formatUsd(exposure.total_value_usd)}
Concentration Risk: ${exposure.concentration_risk}
Top Exposure: ${exposure.top_exposure}
Risk Tolerance: ${riskTolerance}

Token Holdings:
${exposure.tokens
  .map(
    (t) =>
      `- ${t.symbol}: ${t.balance} ($${formatUsd(t.value_usd)}, ${t.percentage}%)`
  )
  .join("\n")}

Recommended Hedges (Limitless Exchange prediction markets):
${recommendations
  .map(
    (r) =>
      `- Market: "${r.market_question}"
  Action: ${r.action} | Shares: ${Math.round(r.shares)} | Cost: $${formatUsd(r.estimated_cost_usd)} | Max Payout: $${formatUsd(r.coverage_usd)} (${r.coverage_percentage}% of exposure) | Expiry: ${r.expiry}`
  )
  .join("\n")}

Total hedge cost: $${formatUsd(recommendations.reduce((s, r) => s + r.estimated_cost_usd, 0))}
Total max coverage: $${formatUsd(recommendations.reduce((s, r) => s + r.coverage_usd, 0))}

Explain why these markets were chosen and how the cost vs coverage tradeoff works.`;
}

function buildPostHedgePrompt(
  exposure: PortfolioExposure,
  hedgesPlaced: HedgePlaced[],
  summary: { totalSpent: number; totalMaxCoverage: number; budgetRemaining: number }
): string {
  return `Summarize the hedge positions just placed:

Portfolio Value: $${formatUsd(exposure.total_value_usd)}
Top Exposure: ${exposure.top_exposure}

Hedges Placed:
${hedgesPlaced
  .map(
    (h) =>
      `- Market: "${h.market_question}"
  Action: ${h.action} | Shares: ${h.shares_bought} | Price: $${h.price_per_share.toFixed(4)}/share | Cost: $${formatUsd(h.total_cost_usd)} | Max Payout: $${formatUsd(h.max_payout_usd)} | Expiry: ${h.expiry}`
  )
  .join("\n")}

Summary:
- Total spent: $${formatUsd(summary.totalSpent)}
- Max coverage if hedges trigger: $${formatUsd(summary.totalMaxCoverage)}
- Budget remaining: $${formatUsd(summary.budgetRemaining)}

Explain what protection is now in place and what happens at expiry.`;
}

function buildClosePrompt(
  positionsClosed: PositionClosed[],
  totalReturned: number
): string {
  const totalPnl = positionsClosed.reduce((s, p) => s + p.realized_pnl, 0);

  return `Explain the results of closing these hedge positions:

Positions Closed:
${positionsClosed
  .map(
    (p) =>
      `- Market: ${p.market_id} | Shares Sold: ${p.shares_sold} | Sale Price: $${p.sale_price.toFixed(4)} | P&L: ${p.realized_pnl >= 0 ? "+" : ""}$${formatUsd(p.realized_pnl)}`
  )
  .join("\n")}

Total USDC returned: $${formatUsd(totalReturned)}
Net P&L: ${totalPnl >= 0 ? "+" : ""}$${formatUsd(totalPnl)}

Explain whether the hedges worked, the P&L, and frame the outcome appropriately (profitable hedge or insurance premium).`;
}

// =============================================
// Scenario-aware fallback reasoning
// =============================================

function generateFallbackReasoning(scenario: ReasoningScenario): string {
  switch (scenario.type) {
    case "exposure_analysis":
      return buildExposureFallback(scenario.exposure, scenario.riskTolerance);

    case "hedge_recommendation":
      return buildRecommendationFallback(
        scenario.exposure,
        scenario.riskTolerance,
        scenario.recommendations
      );

    case "post_hedge_summary":
      return buildPostHedgeFallback(
        scenario.exposure,
        scenario.hedgesPlaced,
        scenario.summary
      );

    case "position_close":
      return buildCloseFallback(scenario.positionsClosed, scenario.totalReturned);
  }
}

function buildExposureFallback(exposure: PortfolioExposure, riskTolerance: string): string {
  const topToken = exposure.tokens[0];
  if (!topToken) {
    return "No significant token holdings detected in this wallet.";
  }

  const lines: string[] = [];

  if (exposure.concentration_risk === "high") {
    lines.push(
      `Your portfolio is heavily concentrated in ${topToken.symbol} at ${topToken.percentage}% ` +
      `($${formatUsd(topToken.value_usd)}). This creates significant downside risk.`
    );
    lines.push(
      `A 10% drop in ${topToken.symbol} would reduce your portfolio by approximately ` +
      `$${formatUsd(topToken.value_usd * 0.1)}.`
    );
  } else if (exposure.concentration_risk === "medium") {
    lines.push(
      `Your portfolio has moderate concentration in ${topToken.symbol} at ${topToken.percentage}%. ` +
      `A significant ${topToken.symbol} price movement would still meaningfully impact your portfolio.`
    );
  } else {
    lines.push(
      `Your portfolio is relatively well diversified across ${exposure.tokens.length} tokens. ` +
      `No single volatile asset dominates your exposure.`
    );
  }

  lines.push(
    `Risk tolerance: ${riskTolerance}. Total portfolio value: $${formatUsd(exposure.total_value_usd)}.`
  );

  return lines.join(" ");
}

function buildRecommendationFallback(
  exposure: PortfolioExposure,
  riskTolerance: string,
  recommendations: HedgeRecommendation[]
): string {
  const totalCost = recommendations.reduce((s, r) => s + r.estimated_cost_usd, 0);
  const totalCoverage = recommendations.reduce((s, r) => s + r.coverage_usd, 0);

  const lines: string[] = [];
  lines.push(
    `Based on your ${exposure.concentration_risk} concentration risk and ${riskTolerance} risk tolerance, ` +
    `${recommendations.length} hedge position(s) are recommended.`
  );

  lines.push(
    `Total cost: $${formatUsd(totalCost)} for up to $${formatUsd(totalCoverage)} in downside protection. ` +
    `Each prediction market share pays $1 if the outcome triggers, offsetting your portfolio losses.`
  );

  if (recommendations[0]) {
    lines.push(
      `Primary hedge: "${recommendations[0].market_question}" — ` +
      `${recommendations[0].action} ${Math.round(recommendations[0].shares)} shares at $${formatUsd(recommendations[0].estimated_cost_usd)}.`
    );
  }

  return lines.join(" ");
}

function buildPostHedgeFallback(
  exposure: PortfolioExposure,
  hedgesPlaced: HedgePlaced[],
  summary: { totalSpent: number; totalMaxCoverage: number; budgetRemaining: number }
): string {
  if (hedgesPlaced.length === 0) {
    return "No hedge positions were placed. Budget has been preserved.";
  }

  const coveragePct = exposure.total_value_usd > 0
    ? Math.round((summary.totalMaxCoverage / exposure.total_value_usd) * 100)
    : 0;

  const lines: string[] = [];
  lines.push(
    `${hedgesPlaced.length} hedge position(s) placed, protecting approximately ${coveragePct}% of your ` +
    `$${formatUsd(exposure.total_value_usd)} portfolio.`
  );
  lines.push(
    `Total spent: $${formatUsd(summary.totalSpent)}. Maximum payout if hedges trigger: $${formatUsd(summary.totalMaxCoverage)}.`
  );
  lines.push(
    `If market conditions stay stable, the hedge cost serves as an insurance premium. ` +
    `If prices drop past the strike levels, the hedge shares pay out $1 each, offsetting your losses.`
  );

  return lines.join(" ");
}

function buildCloseFallback(
  positionsClosed: PositionClosed[],
  totalReturned: number
): string {
  if (positionsClosed.length === 0) {
    return "No positions were closed.";
  }

  const netPnl = positionsClosed.reduce((s, p) => s + p.realized_pnl, 0);
  const pnlSign = netPnl >= 0 ? "+" : "";

  if (netPnl >= 0) {
    return (
      `Closed ${positionsClosed.length} position(s) with a net profit of ${pnlSign}$${formatUsd(netPnl)}. ` +
      `$${formatUsd(totalReturned)} USDC returned. ` +
      `The hedge positions paid off, helping offset portfolio downside.`
    );
  }

  return (
    `Closed ${positionsClosed.length} position(s) with a net cost of $${formatUsd(Math.abs(netPnl))}. ` +
    `$${formatUsd(totalReturned)} USDC returned. ` +
    `The hedge cost served as an insurance premium — your portfolio stayed healthy, ` +
    `so the protection wasn't needed this time.`
  );
}
