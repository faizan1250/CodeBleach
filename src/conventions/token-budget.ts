// Phase 6 advisory token measurement (P6-00, ADR 0043).
//
// The configured provider exposes no tokenizer or token-count facility
// (OpenCodeProvider is transport-only: pre-request ceilings use
// estimateTokens), so advisory budgets are measured with the documented
// conservative UTF-8-byte upper-bound counter. Mode is pinned here and
// recorded by the contract tests.
import { estimateTokens } from "../utils/tokens.ts";
import {
  MAX_ADVISORY_FIXED_INPUT_TOKENS,
  MAX_ADVISORY_INPUT_TOKENS_PER_REQUEST,
  MAX_ADVISORY_UNIT_TOKENS,
} from "./constants.ts";
import type { ConventionAdvisoryBatchInput, ConventionAdvisoryUnit } from "../types/conventions.ts";

export const ADVISORY_TOKEN_COUNTER_MODE = "utf8-byte-upper-bound" as const;

export function countAdvisoryTokens(text: string): number {
  return estimateTokens(text);
}

export interface AdvisoryBatchMeasurement {
  unitsAndConventionsTokens: number;
  reservedFixedTokens: number;
  totalTokens: number;
}

// Measures the serialized units-plus-conventions payload plus the fixed
// framing reserve. The P6-03 packer and P6-04 engine add the real template and
// schema framing; the 900-token reserve covers it in P6-00.
export function measureAdvisoryBatchInput(input: ConventionAdvisoryBatchInput): AdvisoryBatchMeasurement {
  const serialized = JSON.stringify({ units: input.units, conventions: input.conventions });
  const unitsAndConventionsTokens = countAdvisoryTokens(serialized);
  return {
    unitsAndConventionsTokens,
    reservedFixedTokens: MAX_ADVISORY_FIXED_INPUT_TOKENS,
    totalTokens: unitsAndConventionsTokens + MAX_ADVISORY_FIXED_INPUT_TOKENS,
  };
}

export function fitsAdvisoryRequestBudget(input: ConventionAdvisoryBatchInput): boolean {
  return measureAdvisoryBatchInput(input).totalTokens <= MAX_ADVISORY_INPUT_TOKENS_PER_REQUEST;
}

export function fitsAdvisoryUnitBudget(unit: ConventionAdvisoryUnit): boolean {
  return countAdvisoryTokens(JSON.stringify(unit)) <= MAX_ADVISORY_UNIT_TOKENS;
}
