// Deterministic, conservative token approximation for review payloads.
//
// No LLM provider exists in Phase 3, so exact model token counts are
// unavailable. This heuristic overestimates (bytes/4 baseline plus a 15%
// safety margin) and is replaceable in Phase 4. Never returns NaN.

const encoder = new TextEncoder();

const SAFETY_NUMERATOR = 23;
const SAFETY_DENOMINATOR = 80;

export function estimateTokens(text: string): number {
  if (text === "") return 0;
  const bytes = encoder.encode(text).length;
  return Math.max(1, Math.ceil((bytes * SAFETY_NUMERATOR) / SAFETY_DENOMINATOR));
}
