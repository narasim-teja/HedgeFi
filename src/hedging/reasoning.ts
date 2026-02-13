import { GoogleGenAI } from "@google/genai";
import { createLogger } from "../utils/logger.ts";
import type { PortfolioExposure, HedgeRecommendation } from "../utils/types.ts";

const log = createLogger("reasoning");

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

const SYSTEM_PROMPT = `You are a DeFi risk analyst working for HedgeFi, an autonomous portfolio hedging agent.
Your job is to analyze portfolio exposure and explain risks in plain English.
HedgeFi uses prediction markets on Limitless Exchange to construct hedges.

Guidelines:
- Be specific: reference actual token names, percentages, and dollar amounts from the data.
- Be concise: 2-3 short paragraphs maximum.
- Focus on: concentration risk, volatility exposure, and what price movements would hurt this portfolio.
- When hedge recommendations are provided, explain why each market was chosen and how the payout works.
- Explain prediction market hedging simply: "If ETH drops below $X, these shares pay out $1 each, offsetting your loss."
- If the portfolio is well-diversified, say so.
- If concentration is high, explain why that is risky and what a hedge would protect against.
- Do NOT include disclaimers or financial advice warnings.
- Speak directly to the user ("Your portfolio...", "You are exposed to...").`;

export async function generateReasoning(
  exposure: PortfolioExposure,
  riskTolerance: string,
  recommendations?: HedgeRecommendation[]
): Promise<string> {
  const client = getClient();

  let userPrompt = `Analyze this portfolio exposure and explain the risks:

Portfolio Total Value: $${exposure.total_value_usd.toLocaleString()}
Concentration Risk: ${exposure.concentration_risk}
Top Exposure: ${exposure.top_exposure}
Risk Tolerance: ${riskTolerance}

Token Holdings:
${exposure.tokens
  .map(
    (t) =>
      `- ${t.symbol}: ${t.balance} ($${t.value_usd.toLocaleString()}, ${t.percentage}%)`
  )
  .join("\n")}`;

  if (recommendations && recommendations.length > 0) {
    userPrompt += `

Recommended Hedges (from Limitless Exchange prediction markets):
${recommendations
  .map(
    (r) =>
      `- Market: "${r.market_question}" | Action: ${r.action} | Shares: ${r.shares} | ` +
      `Cost: $${r.estimated_cost_usd} | Coverage: $${r.coverage_usd} (${r.coverage_percentage}%) | Expiry: ${r.expiry}`
  )
  .join("\n")}

Explain why these specific markets were chosen and how they protect the portfolio. Reference the strike prices and how they relate to current exposure. Explain the cost vs coverage tradeoff.`;
  } else {
    userPrompt += `

No suitable prediction markets are currently available on Limitless Exchange for hedging this portfolio. Explain the risks and what kinds of markets would be useful when they become available.`;
  }

  try {
    log.info("Generating reasoning with Gemini");

    const response = await client.models.generateContent({
      model: "gemini-2.0-flash",
      contents: userPrompt,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        maxOutputTokens: 500,
        temperature: 0.7,
      },
    });

    const text = response.text;

    if (!text) {
      log.warn("Gemini returned empty response, using fallback");
      return generateFallbackReasoning(exposure, riskTolerance);
    }

    log.info("Reasoning generated successfully");
    return text.trim();
  } catch (err) {
    log.error("Gemini API failed, using fallback reasoning", err);
    return generateFallbackReasoning(exposure, riskTolerance);
  }
}

function generateFallbackReasoning(
  exposure: PortfolioExposure,
  riskTolerance: string
): string {
  const topToken = exposure.tokens[0];
  if (!topToken) {
    return "No significant token holdings detected in this wallet.";
  }

  const lines: string[] = [];

  if (exposure.concentration_risk === "high") {
    lines.push(
      `Your portfolio is heavily concentrated in ${topToken.symbol} at ${topToken.percentage}% ` +
        `($${topToken.value_usd.toLocaleString()}). This creates significant downside risk ` +
        `if ${topToken.symbol} drops in price.`
    );
    lines.push(
      `A 10% drop in ${topToken.symbol} would reduce your portfolio value by approximately ` +
        `$${Math.round(topToken.value_usd * 0.1).toLocaleString()}.`
    );
  } else if (exposure.concentration_risk === "medium") {
    lines.push(
      `Your portfolio has moderate concentration in ${topToken.symbol} at ${topToken.percentage}%. ` +
        `While somewhat diversified, a significant ${topToken.symbol} price movement would ` +
        `still meaningfully impact your portfolio.`
    );
  } else {
    lines.push(
      `Your portfolio is relatively well diversified across ${exposure.tokens.length} tokens. ` +
        `No single volatile asset dominates your exposure.`
    );
  }

  lines.push(
    `Risk tolerance: ${riskTolerance}. Total portfolio value: $${exposure.total_value_usd.toLocaleString()}.`
  );

  return lines.join(" ");
}
