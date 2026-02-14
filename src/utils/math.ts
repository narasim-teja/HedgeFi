/**
 * Sanitize a numeric value: replace NaN/Infinity with a fallback.
 */
export function sanitizeNumber(n: number, fallback: number = 0): number {
  if (!Number.isFinite(n)) return fallback;
  return n;
}

/**
 * Safe division: returns fallback if divisor is 0 or result is non-finite.
 */
export function safeDivide(numerator: number, denominator: number, fallback: number = 0): number {
  if (denominator === 0 || !Number.isFinite(denominator)) return fallback;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : fallback;
}
