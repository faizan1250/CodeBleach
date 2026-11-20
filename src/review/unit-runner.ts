import {
  CONTEXT_SAFETY_MARGIN_TOKENS,
  MODEL_CONTEXT_TOKENS,
  MODEL_MAX_OUTPUT_TOKENS,
  validateUnitBudgets,
} from "../llm/limits.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { ReviewerError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import { collectLlmSecrets } from "../llm/training-gate.ts";
import { completeJsonWithStats, newJsonCallStats } from "../providers/json.ts";
import type { LlmProvider } from "../providers/types.ts";
import type { Finding } from "../types/finding.ts";
import { RawReviewOutputSchema } from "../types/finding.ts";
import type { ReviewUnit } from "../types/context.ts";
import type { ReviewDiagnostic, ReviewUsage } from "../types/review.ts";
import { redact } from "../utils/redact.ts";
import { buildReviewPrompt, CODE_REVIEW_PROMPT_VERSION, type BuiltReviewPrompt } from "./prompt.ts";
import { normalizeFinding } from "./normalize.ts";
import { emptyReviewUsage, mergeReviewUsage, type UnitOutcome } from "./result.ts";
import { stopCode, type StopReason } from "./stage.ts";

export interface UnitRunnerDeps {
  provider: LlmProvider;
  logger: Logger;
  env: Record<string, string | undefined>;
  /** Extra secret bytes redacted from diagnostics; the API key comes from env. */
  secrets: string[];
}

export interface UnitRunContext {
  signal: AbortSignal;
  stopped: () => StopReason;
  headSha: string;
  throwIfFatal: () => void;
}

// P4-05: Responses `incomplete` is not a parse failure and is never
// JSON-repaired. Only `max_output_tokens` gets one bounded cap escalation per
// unit, matched on the typed `incompleteReason` the provider sets from
// `incomplete_details.reason`. Message text never affects classification.
export function isIncompleteCapError(error: unknown): boolean {
  return (
    error instanceof ReviewerError && error.code === "PROVIDER_FAILED" && error.incompleteReason === "max_output_tokens"
  );
}

/** One focused pass, one provider request per ReviewUnit. No batching. */
export async function runReviewUnit(
  deps: UnitRunnerDeps,
  unit: ReviewUnit,
  config: ResolvedConfig,
  ctx: UnitRunContext,
): Promise<UnitOutcome> {
  const built = buildReviewPrompt(unit, config);
  // Pre-request enforcement: the effective input ceiling is the configured
  // budget further capped by context minus reserved output minus margin.
  // Impossible budgets fail closed (CONFIG_INVALID, no provider call);
  // oversized units skip with a diagnostic, never silent truncation.
  const budget = validateUnitBudgets({
    estimatedInputTokens: built.estimatedInputTokens,
    maxOutputTokens: config.llm.max_output_tokens,
    inputBudget: config.llm.max_review_unit_input_tokens,
  });
  if (!budget.ok) {
    if (budget.code !== "INPUT_BUDGET_EXCEEDED") {
      throw new ReviewerError({ code: "CONFIG_INVALID", message: budget.message });
    }
    deps.logger.warn("review unit skipped", { unitId: unit.id, reason: "input-budget-exceeded" });
    return {
      ok: false,
      findings: [],
      diagnostics: [
        {
          stage: "prompt",
          code: "INPUT_BUDGET_EXCEEDED",
          message: "review unit skipped: prompt exceeds max_review_unit_input_tokens",
          unitId: unit.id,
          retryable: false,
        },
      ],
      usage: emptyReviewUsage(),
    };
  }
  const usage = emptyReviewUsage();
  const firstMax = config.llm.max_output_tokens;
  try {
    // A sibling's fatal between claim and send must not start new work.
    ctx.throwIfFatal();
    const first = await completeUnit(deps, unit, built, config, firstMax, usage, ctx.signal, ctx.headSha);
    ctx.throwIfFatal();
    return { ok: true, findings: first.findings, diagnostics: first.diagnostics, usage };
  } catch (error) {
    if (error instanceof ReviewerError && error.code === "CONFIG_INVALID") throw error;
    // A stop during the attempt replaces the error code; escalation never
    // outlives the stage deadline or caller cancellation.
    const stop = stopCode(ctx.stopped());
    if (stop !== undefined) return failReviewUnit(deps, unit, error, usage, stop);
    // One bounded cap escalation for max_output_tokens only; every other
    // failure (refusal, other incomplete reasons, malformed output after its
    // single repair) stays partial with no further attempt.
    if (!isIncompleteCapError(error)) return failReviewUnit(deps, unit, error, usage);
    // Escalation stays inside both the output ceiling and the context window
    // (output counts against context); otherwise the unit is partial.
    const capByContext = MODEL_CONTEXT_TOKENS - built.estimatedInputTokens - CONTEXT_SAFETY_MARGIN_TOKENS;
    const escalated = Math.min(MODEL_MAX_OUTPUT_TOKENS, firstMax * 2, capByContext);
    if (escalated <= firstMax) return failReviewUnit(deps, unit, error, usage, "REVIEW_OUTPUT_INCOMPLETE");
    usage.incompleteRetries += 1;
    // Escalation is a second provider call; never starts after a fatal.
    ctx.throwIfFatal();
    try {
      const second = await completeUnit(deps, unit, built, config, escalated, usage, ctx.signal, ctx.headSha);
      return { ok: true, findings: second.findings, diagnostics: second.diagnostics, usage };
    } catch (escalatedError) {
      if (escalatedError instanceof ReviewerError && escalatedError.code === "CONFIG_INVALID") {
        throw escalatedError;
      }
      const escalatedStop = stopCode(ctx.stopped());
      if (escalatedStop !== undefined) {
        return failReviewUnit(deps, unit, escalatedError, usage, escalatedStop);
      }
      return failReviewUnit(deps, unit, escalatedError, usage, "REVIEW_OUTPUT_INCOMPLETE");
    }
  }
}

export function failReviewUnit(
  deps: UnitRunnerDeps,
  unit: ReviewUnit,
  error: unknown,
  usage: ReviewUsage,
  code?: string,
): UnitOutcome {
  const reviewer = error instanceof ReviewerError ? error : null;
  const failureCode = code ?? reviewer?.code ?? "INTERNAL";
  // Malformed model output is a parse-stage outcome, not a transport failure.
  const stage = reviewer === null ? "unit" : failureCode === "PROVIDER_BAD_OUTPUT" ? "parse" : "provider";
  const rawMessage = reviewer?.message ?? (error instanceof Error ? error.message : String(error));
  deps.logger.warn("review unit failed", {
    unitId: unit.id,
    code: failureCode,
    ...(failureCode === "REVIEW_OUTPUT_INCOMPLETE" ? { reason: "output-incomplete" } : {}),
  });
  const diagnostic: ReviewDiagnostic = {
    stage,
    code: failureCode,
    message: cleanDiagnosticMessage(deps, rawMessage),
    unitId: unit.id,
    retryable: reviewer?.retryable ?? false,
  };
  return { ok: false, findings: [], diagnostics: [diagnostic], usage };
}

// Diagnostic text is static or redacted; model output and secrets never land here.
function cleanDiagnosticMessage(deps: UnitRunnerDeps, text: string): string {
  const secrets = [...deps.secrets, ...collectLlmSecrets(deps.env)];
  return redact(text, secrets).slice(0, 500);
}

async function completeUnit(
  deps: UnitRunnerDeps,
  unit: ReviewUnit,
  built: BuiltReviewPrompt,
  config: ResolvedConfig,
  maxTokens: number,
  usage: ReviewUsage,
  signal: AbortSignal,
  headSha: string,
): Promise<{ findings: Finding[]; diagnostics: ReviewDiagnostic[] }> {
  const stats = newJsonCallStats();
  try {
    const output = await completeJsonWithStats(
      deps.provider,
      {
        system: built.system,
        user: built.user,
        maxTokens,
        timeoutMs: config.llm.request_timeout_ms,
      },
      RawReviewOutputSchema,
      stats,
      signal,
    );
    const findings: Finding[] = [];
    const diagnostics: ReviewDiagnostic[] = [];
    for (const raw of output.findings) {
      const finding = normalizeFinding(raw, {
        unit,
        headSha,
        pass: CODE_REVIEW_PROMPT_VERSION,
      });
      // Rejected findings carry no diagnostics with model text (P4-07 keeps
      // only the unit id); the warn stays content-free like the unit failure
      // path above.
      if (finding === null) {
        deps.logger.warn("review finding rejected", { unitId: unit.id });
        diagnostics.push({
          stage: "normalize",
          code: "FINDING_REJECTED",
          message: "model finding rejected during normalization",
          unitId: unit.id,
          retryable: false,
        });
        continue;
      }
      findings.push(finding);
    }
    return { findings, diagnostics };
  } finally {
    // Failed attempts still spent requests/tokens; account them always.
    mergeReviewUsage(usage, {
      requests: stats.requests,
      retries: stats.retries,
      repairRequests: stats.repairs,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      reasoningTokens: stats.reasoningTokens,
      costUsd: stats.costUsd,
      costKnown: stats.costKnown,
    });
  }
}
