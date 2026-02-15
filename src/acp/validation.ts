import { MIN_HEDGE_BUDGET_USD } from "../utils/constants.ts";

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateWalletAddress(address: unknown): ValidationResult {
  if (typeof address !== "string") {
    return { valid: false, error: "wallet_address must be a string" };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return { valid: false, error: `Invalid wallet address format: "${address}". Expected 0x + 40 hex characters.` };
  }
  if (address === "0x0000000000000000000000000000000000000000") {
    return { valid: false, error: "wallet_address cannot be the zero address" };
  }
  return { valid: true };
}

export function validateChain(chain: unknown): ValidationResult {
  const VALID_CHAINS = ["base", "ethereum", "arbitrum"];
  if (typeof chain !== "string" || !VALID_CHAINS.includes(chain)) {
    return { valid: false, error: `Invalid chain: "${chain}". Must be one of: ${VALID_CHAINS.join(", ")}` };
  }
  return { valid: true };
}

export function validateRiskTolerance(tolerance: unknown): ValidationResult {
  const VALID = ["conservative", "moderate", "aggressive"];
  if (typeof tolerance !== "string" || !VALID.includes(tolerance)) {
    return { valid: false, error: `Invalid risk_tolerance: "${tolerance}". Must be one of: ${VALID.join(", ")}` };
  }
  return { valid: true };
}

export function validateHedgeBudget(budget: unknown): ValidationResult {
  if (typeof budget !== "number" || isNaN(budget)) {
    return { valid: false, error: `hedge_budget must be a number, got: ${typeof budget}` };
  }
  if (budget < MIN_HEDGE_BUDGET_USD) {
    return { valid: false, error: `hedge_budget must be >= $${MIN_HEDGE_BUDGET_USD}, got: $${budget}` };
  }
  return { valid: true };
}

export function validateAdditionalAddresses(addresses: unknown): ValidationResult {
  if (addresses === undefined || addresses === null) {
    return { valid: true }; // optional field
  }
  if (!Array.isArray(addresses)) {
    return { valid: false, error: "additional_addresses must be an array of wallet addresses" };
  }
  if (addresses.length > 5) {
    return { valid: false, error: "additional_addresses supports up to 5 addresses" };
  }
  for (const addr of addresses) {
    const check = validateWalletAddress(addr);
    if (!check.valid) {
      return { valid: false, error: `Invalid additional address: ${check.error}` };
    }
  }
  return { valid: true };
}

export function validateMarketTimeframe(timeframe: unknown): ValidationResult {
  if (timeframe === undefined || timeframe === null) {
    return { valid: true };
  }
  const VALID = ["hourly", "daily", "weekly", "all"];
  if (typeof timeframe !== "string" || !VALID.includes(timeframe)) {
    return { valid: false, error: `Invalid market_timeframe: "${timeframe}". Must be one of: ${VALID.join(", ")}` };
  }
  return { valid: true };
}

export function validateCloseHedgeReq(req: unknown): ValidationResult {
  if (!req || typeof req !== "object") {
    return { valid: false, error: "close_hedge requirement must be an object" };
  }
  const r = req as Record<string, unknown>;
  const hasPositionIds = Array.isArray(r.position_ids) && r.position_ids.length > 0;
  const hasCloseAll = r.close_all === true;
  if (!hasPositionIds && !hasCloseAll) {
    return { valid: false, error: "close_hedge requires either position_ids (non-empty array) or close_all: true" };
  }
  return { valid: true };
}

export function validateHedgeAnalysisReq(req: Record<string, unknown>): ValidationResult {
  for (const check of [
    validateWalletAddress(req.wallet_address),
    validateAdditionalAddresses(req.additional_addresses),
    validateChain(req.chain),
    validateRiskTolerance(req.risk_tolerance),
    validateHedgeBudget(req.hedge_budget),
    validateMarketTimeframe(req.market_timeframe),
  ]) {
    if (!check.valid) return check;
  }
  return { valid: true };
}

export function validateExecuteHedgeReq(req: Record<string, unknown>): ValidationResult {
  // Accept either hedge_budget_usdc (canonical) or hedge_budget (backward compat)
  const budget = req.hedge_budget_usdc ?? req.hedge_budget;
  for (const check of [
    validateWalletAddress(req.wallet_address),
    validateAdditionalAddresses(req.additional_addresses),
    validateChain(req.chain),
    validateRiskTolerance(req.risk_tolerance),
    validateHedgeBudget(budget),
    validateMarketTimeframe(req.market_timeframe),
  ]) {
    if (!check.valid) return check;
  }
  return { valid: true };
}
