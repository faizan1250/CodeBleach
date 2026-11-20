import {
  MAX_LLM_MAX_OUTPUT_TOKENS,
  MAX_LLM_MAX_REVIEW_UNIT_INPUT_TOKENS,
} from "../config/defaults.ts";

// Local enforcement bounds for muse-spark-1.3-contributor via opencode-go.
// Provenance: the P4-00 authenticated catalog read verified ONLY
// api.responses.base_url (docs/opencode-spike.md); limit.* was never observed
// and no completed response was ever verified. The sizes below mirror
// third-party reports (context 1048576, output 131072) as LOCAL safety
// ceilings, never as model guarantees. Validated catalog metadata can only
// tighten these bounds, never widen them. Never raise them without a verified
// completed-response plus authenticated limit.* read (record in ADR).
export const MODEL_CONTEXT_TOKENS = 1_048_576;
export const MODEL_MAX_OUTPUT_TOKENS = MAX_LLM_MAX_OUTPUT_TOKENS;
export const MODEL_MAX_INPUT_TOKENS = MAX_LLM_MAX_REVIEW_UNIT_INPUT_TOKENS;
// Headroom so a request sized exactly at the remaining window cannot spill
// over from estimator error (estimateTokens already overestimates ~15%).
export const CONTEXT_SAFETY_MARGIN_TOKENS = 8192;

export interface CatalogLimits {
  contextTokens: number;
  maxOutputTokens: number;
}

export type CatalogLimitsResult =
  | { ok: true; limits: CatalogLimits }
  | { ok: false; reason: string };

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

// Strict validator for an already-fetched catalog record. Missing or
// incomplete limit.* metadata is a rejection, never a silent default: the
// caller keeps the local hard limits. Context prefers limit.context with
// limit.input as the documented fallback; output requires limit.output.
export function resolveCatalogLimits(entry: unknown): CatalogLimitsResult {
  if (typeof entry !== "object" || entry === null) {
    return { ok: false, reason: "catalog entry is not an object" };
  }
  const limit = (entry as Record<string, unknown>)["limit"];
  if (typeof limit !== "object" || limit === null) {
    return { ok: false, reason: "catalog entry lacks limit.* metadata" };
  }
  const record = limit as Record<string, unknown>;
  const context = asPositiveInt(record["context"]) ?? asPositiveInt(record["input"]);
  const output = asPositiveInt(record["output"]);
  if (context === undefined || output === undefined) {
    return {
      ok: false,
      reason: "catalog limit.* is missing or incomplete (need positive integer context/input and output)",
    };
  }
  return { ok: true, limits: { contextTokens: context, maxOutputTokens: output } };
}

export interface UnitBudgetInput {
  estimatedInputTokens: number;
  maxOutputTokens: number;
  inputBudget: number;
}

export type UnitBudgetResult =
  | { ok: true; effectiveInputCeiling: number }
  | {
      ok: false;
      code: "INVALID_BUDGET" | "OUTPUT_CEILING_EXCEEDED" | "INPUT_CEILING_EXCEEDED" | "BUDGET_EXCEEDS_CONTEXT" | "INPUT_BUDGET_EXCEEDED";
      message: string;
    };

// Output tokens ride inside the context window, so the input ceiling is the
// configured budget further capped by context minus reserved output minus margin.
export function effectiveInputCeiling(maxOutputTokens: number, inputBudget: number): number {
  return Math.min(inputBudget, MODEL_CONTEXT_TOKENS - maxOutputTokens - CONTEXT_SAFETY_MARGIN_TOKENS);
}

export function validateUnitBudgets(input: UnitBudgetInput): UnitBudgetResult {
  const { estimatedInputTokens, maxOutputTokens, inputBudget } = input;
  const fields = { estimatedInputTokens, maxOutputTokens, inputBudget } as const;
  for (const [name, value] of Object.entries(fields)) {
    if (!Number.isInteger(value) || (value as number) <= 0) {
      return {
        ok: false,
        code: "INVALID_BUDGET",
        message: `invalid token budget: ${name} must be a positive integer, got ${String(value)}`,
      };
    }
  }
  if (maxOutputTokens > MODEL_MAX_OUTPUT_TOKENS) {
    return {
      ok: false,
      code: "OUTPUT_CEILING_EXCEEDED",
      message: `max_output_tokens ${maxOutputTokens} exceeds the local hard ceiling ${MODEL_MAX_OUTPUT_TOKENS}`,
    };
  }
  if (inputBudget > MODEL_MAX_INPUT_TOKENS) {
    return {
      ok: false,
      code: "INPUT_CEILING_EXCEEDED",
      message: `max_review_unit_input_tokens ${inputBudget} exceeds the local hard ceiling ${MODEL_MAX_INPUT_TOKENS}`,
    };
  }
  const ceiling = effectiveInputCeiling(maxOutputTokens, inputBudget);
  if (ceiling <= 0 || inputBudget + maxOutputTokens + CONTEXT_SAFETY_MARGIN_TOKENS > MODEL_CONTEXT_TOKENS) {
    return {
      ok: false,
      code: "BUDGET_EXCEEDS_CONTEXT",
      message:
        `budgets do not fit the ${MODEL_CONTEXT_TOKENS}-token local context ceiling: ` +
        `input budget ${inputBudget} + reserved output ${maxOutputTokens} + margin ${CONTEXT_SAFETY_MARGIN_TOKENS} exceeds it`,
    };
  }
  if (estimatedInputTokens > ceiling) {
    return {
      ok: false,
      code: "INPUT_BUDGET_EXCEEDED",
      message:
        `estimated prompt ${estimatedInputTokens} tokens exceeds the effective input ceiling ${ceiling} ` +
        `(budget ${inputBudget}, reserved output ${maxOutputTokens})`,
    };
  }
  return { ok: true, effectiveInputCeiling: ceiling };
}
