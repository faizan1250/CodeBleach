import type { ResolvedConfig } from "../config/schema.ts";
import { ReviewerError } from "../core/errors.ts";
import { API_KEY_ENV, FIXED_MODEL_ID, resolveModelId } from "./constants.ts";
import { CONTEXT_SAFETY_MARGIN_TOKENS, MODEL_CONTEXT_TOKENS } from "./limits.ts";
import { requireTrainingOptIn } from "./training-gate.ts";

export interface LlmPreflightInput {
  config: ResolvedConfig;
  env?: Record<string, string | undefined> | undefined;
}

// Fail fast for runs that will call the model: consent, key, fixed-model
// wiring, and usable budgets — all before diff (git) and context (~7s of
// parse). Offline/canned runs skip this via ReviewEngine.requiresLlm.
export function requireLlmPreflight(input: LlmPreflightInput): void {
  const env = input.env ?? process.env;
  requireTrainingOptIn(env);
  const key = env[API_KEY_ENV];
  if (key === undefined || key.length === 0) {
    throw new ReviewerError({
      code: "CONFIG_INVALID",
      message: `${API_KEY_ENV} is required for live review`,
    });
  }
  // Pins the fixed-model wiring: any override attempt fails closed here,
  // before any prompt is built or any provider call is made.
  resolveModelId(FIXED_MODEL_ID);
  const { max_review_unit_input_tokens, max_output_tokens } = input.config.llm;
  if (max_review_unit_input_tokens + max_output_tokens + CONTEXT_SAFETY_MARGIN_TOKENS > MODEL_CONTEXT_TOKENS) {
    throw new ReviewerError({
      code: "CONFIG_INVALID",
      message:
        `llm budgets do not fit the ${MODEL_CONTEXT_TOKENS}-token local context ceiling: ` +
        `max_review_unit_input_tokens (${max_review_unit_input_tokens}) + max_output_tokens ` +
        `(${max_output_tokens}) + margin (${CONTEXT_SAFETY_MARGIN_TOKENS}) exceeds it`,
    });
  }
}
