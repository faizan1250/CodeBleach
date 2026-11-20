import {
  CONTEXT_SAFETY_MARGIN_TOKENS,
  MODEL_CONTEXT_TOKENS,
  MODEL_MAX_OUTPUT_TOKENS,
  validateUnitBudgets,
} from "../llm/limits.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { ReviewerError } from "../core/errors.ts";
import type { ReviewEngine } from "../core/contracts.ts";
import type { Logger } from "../core/logger.ts";
import { FIXED_MODEL_ID } from "../llm/constants.ts";
import { collectLlmSecrets, requireTrainingOptIn } from "../llm/training-gate.ts";
import { completeJsonWithStats, newJsonCallStats } from "../providers/json.ts";
import type { LlmProvider } from "../providers/types.ts";
import { RawReviewOutputSchema, type Finding } from "../types/finding.ts";
import type { ReviewUnit } from "../types/context.ts";
import type { ReviewBuildResult, ReviewDiagnostic, ReviewUsage } from "../types/review.ts";
import { redact } from "../utils/redact.ts";
import { buildReviewPrompt, CODE_REVIEW_PROMPT_VERSION, codeReviewTemplateHash } from "./prompt.ts";
import type { BuiltReviewPrompt } from "./prompt.ts";
import { normalizeFinding } from "./normalize.ts";
import { assembleReviewResult, emptyReviewUsage, mergeReviewUsage, type UnitOutcome } from "./result.ts";

export interface ReviewEngineOptions {
  provider: LlmProvider;
  logger: Logger;
  env?: Record<string, string | undefined> | undefined;
  /** Extra secret bytes redacted from diagnostics; the API key comes from env. */
  secrets?: string[] | undefined;
  /** DiffResult.headSha wiring lands in P4-09; empty until then. */
  headSha?: string | undefined;
}

export interface ReviewCallOptions {
  /** Caller cancellation; aborts in-flight requests and skips queued units. */
  signal?: AbortSignal | undefined;
  /** DiffResult.headSha for code-owned attribution; falls back to constructor headSha. */
  headSha?: string | undefined;
}

// P4-08 stop reasons: caller cancellation wins over the stage deadline.
type StopReason = "cancelled" | "deadline" | null;

function stopCode(reason: StopReason): "REVIEW_CANCELLED" | "REVIEW_DEADLINE_EXCEEDED" | undefined {
  if (reason === "cancelled") return "REVIEW_CANCELLED";
  if (reason === "deadline") return "REVIEW_DEADLINE_EXCEEDED";
  return undefined;
}

// Units never started after a stop keep stable order with a content-free skip.
function skipOutcome(unit: ReviewUnit, reason: "cancelled" | "deadline"): UnitOutcome {
  const code = reason === "cancelled" ? "REVIEW_CANCELLED" : "REVIEW_DEADLINE_EXCEEDED";
  return {
    ok: false,
    findings: [],
    diagnostics: [
      {
        stage: "unit",
        code,
        message:
          reason === "cancelled"
            ? "review unit skipped: run was cancelled before review started"
            : "review unit skipped: stage deadline expired before review started",
        unitId: unit.id,
        retryable: false,
      },
    ],
    usage: emptyReviewUsage(),
  };
}
// P4-05: Responses `incomplete` is not a parse failure and is never
// JSON-repaired. Only `max_output_tokens` gets one bounded cap escalation per
// unit, matched on the typed `incompleteReason` the provider sets from
// `incomplete_details.reason`. Message text never affects classification.
function isIncompleteCapError(error: unknown): boolean {
  return (
    error instanceof ReviewerError &&
    error.code === "PROVIDER_FAILED" &&
    error.incompleteReason === "max_output_tokens"
  );
}

/** One focused pass, one provider request per ReviewUnit. No batching. */
export class ReviewEngineImpl implements ReviewEngine {
  private readonly provider: LlmProvider;
  private readonly logger: Logger;
  private readonly env: Record<string, string | undefined>;
  private readonly secrets: string[];
  private readonly headSha: string;

  constructor(options: ReviewEngineOptions) {
    const opts = options as ReviewEngineOptions | null | undefined;
    if (opts === null || opts === undefined) {
      throw new ReviewerError({
        code: "INTERNAL",
        message: "ReviewEngineImpl requires options with provider and logger",
      });
    }
    const logger = opts.logger;
    if (
      logger === null ||
      logger === undefined ||
      typeof logger.debug !== "function" ||
      typeof logger.info !== "function" ||
      typeof logger.warn !== "function" ||
      typeof logger.error !== "function"
    ) {
      throw new ReviewerError({
        code: "INTERNAL",
        message: "ReviewEngineImpl requires a logger with debug/info/warn/error methods",
      });
    }
    this.logger = logger;
    this.provider = opts.provider;
    this.env = opts.env ?? process.env;
    this.secrets = opts.secrets ?? [];
    this.headSha = opts.headSha ?? "";
  }

  async review(
    units: ReviewUnit[],
    config: ResolvedConfig,
    options?: ReviewCallOptions | undefined,
  ): Promise<ReviewBuildResult> {
    const identity = { version: CODE_REVIEW_PROMPT_VERSION, hash: codeReviewTemplateHash() };
    if (units.length === 0) {
      return assembleReviewResult({
        unitsSubmitted: 0,
        outcomes: [],
        promptVersion: identity.version,
        promptHash: identity.hash,
        model: FIXED_MODEL_ID,
      });
    }
    requireTrainingOptIn(this.env);
    const callerSignal = options?.signal;
    const headSha = options?.headSha ?? this.headSha;
    // Stage deadline (P4-08): one wall-clock ceiling over every per-unit
    // request, transport retry, repair, and cap escalation. Zero means the
    // deadline is already expired: no unit starts. Expired callers abort via
    // the stage controller below; clearTimeout in the finally always wins.
    const stageBudgetMs = config.llm.review_timeout_ms;
    const stage = new AbortController();
    let deadlineFired = false;
    const onCallerAbort = (): void => {
      if (!stage.signal.aborted) stage.abort(callerSignal?.reason);
    };
    if (callerSignal?.aborted === true) {
      stage.abort(callerSignal.reason);
    } else {
      callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (stageBudgetMs <= 0 || stage.signal.aborted) {
      deadlineFired = stageBudgetMs <= 0;
    } else {
      timer = setTimeout(() => {
        deadlineFired = true;
        stage.abort(new Error("review stage deadline exceeded"));
      }, stageBudgetMs);
    }
    try {
      const limit = Math.max(1, config.llm.max_concurrent_requests);
      const out: UnitOutcome[] = new Array(units.length);
      let next = 0;
      // First fatal wins: recorded once, then the internal stage aborts so
      // in-flight provider calls cancel and queued units never start. The
      // caller's signal is never touched. Siblings drain via allSettled
      // below; the stored error is rethrown only after every worker lands.
      let fatalError: unknown;
      const hasFatal = (): boolean => fatalError !== undefined;
      const throwIfFatal = (): void => {
        if (fatalError !== undefined) throw fatalError;
      };
      const failFast = (error: unknown): void => {
        if (fatalError !== undefined) return;
        fatalError = error;
        if (!stage.signal.aborted) stage.abort(error);
      };
      const stopped = (): "cancelled" | "deadline" | null => {
        if (callerSignal?.aborted === true) return "cancelled";
        if (deadlineFired || stage.signal.aborted) return "deadline";
        return null;
      };
      const workers = Array.from({ length: Math.min(limit, units.length) }, async () => {
        for (;;) {
          if (hasFatal() || stopped() !== null) return;
          const index = next;
          next += 1;
          if (index >= units.length) return;
          // A fatal landing between claim and start leaves the slot empty;
          // the post-drain rethrow discards all partial worker state.
          if (hasFatal()) return;
          const unit = units[index];
          if (unit === undefined) {
            out[index] = { ok: true, findings: [], diagnostics: [], usage: emptyReviewUsage() };
            continue;
          }
          try {
            const outcome = await this.reviewUnit(
              unit,
              config,
              stage.signal,
              stopped,
              headSha,
              throwIfFatal,
            );
            // A sibling's fatal discards even a successful late outcome.
            if (hasFatal()) return;
            out[index] = outcome;
          } catch (error) {
            // Policy errors abort the whole run; per-unit failures stay partial.
            if (error instanceof ReviewerError && error.code === "CONFIG_INVALID") {
              // A run already stopped by caller/deadline keeps its stop
              // outcome; only the first live fatal aborts the stage.
              if (!hasFatal() && stopped() === null) failFast(error);
              else if (!hasFatal()) {
                out[index] = this.unitFailure(unit, error, emptyReviewUsage(), stopCode(stopped()));
              }
              return;
            }
            if (hasFatal()) return;
            out[index] = this.unitFailure(unit, error, emptyReviewUsage(), stopCode(stopped()));
          }
        }
      });
      // Drain every worker before leaving: aborted siblings must land so no
      // provider call outlives the rejection and the timer clears exactly once.
      await Promise.allSettled(workers);
      if (fatalError !== undefined) throw fatalError;
      // Units never claimed after a stop keep stable order with a skip diagnostic.
      for (let index = 0; index < units.length; index += 1) {
        if (out[index] === undefined) {
          const unit = units[index];
          if (unit !== undefined) out[index] = skipOutcome(unit, stopped() ?? "deadline");
        }
      }
      return assembleReviewResult({
        unitsSubmitted: units.length,
        outcomes: out,
        promptVersion: identity.version,
        promptHash: identity.hash,
        model: FIXED_MODEL_ID,
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  private async reviewUnit(
    unit: ReviewUnit,
    config: ResolvedConfig,
    signal: AbortSignal,
    stopped: () => StopReason,
    headSha: string,
    throwIfFatal: () => void,
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
      this.logger.warn("review unit skipped", { unitId: unit.id, reason: "input-budget-exceeded" });
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
      throwIfFatal();
      const first = await this.completeUnit(unit, built, config, firstMax, usage, signal, headSha);
      throwIfFatal();
      return { ok: true, findings: first.findings, diagnostics: first.diagnostics, usage };
    } catch (error) {
      if (error instanceof ReviewerError && error.code === "CONFIG_INVALID") throw error;
      // A stop during the attempt replaces the error code; escalation never
      // outlives the stage deadline or caller cancellation.
      const stop = stopCode(stopped());
      if (stop !== undefined) return this.unitFailure(unit, error, usage, stop);
      // One bounded cap escalation for max_output_tokens only; every other
      // failure (refusal, other incomplete reasons, malformed output after
      // its single repair) stays partial with no further attempt.
      if (!isIncompleteCapError(error)) return this.unitFailure(unit, error, usage);
      // Escalation stays inside both the output ceiling and the context
      // window (output counts against context); otherwise the unit is partial.
      const capByContext =
        MODEL_CONTEXT_TOKENS - built.estimatedInputTokens - CONTEXT_SAFETY_MARGIN_TOKENS;
      const escalated = Math.min(MODEL_MAX_OUTPUT_TOKENS, firstMax * 2, capByContext);
      if (escalated <= firstMax) return this.unitFailure(unit, error, usage, "REVIEW_OUTPUT_INCOMPLETE");
      usage.incompleteRetries += 1;
      // Escalation is a second provider call; never starts after a fatal.
      throwIfFatal();
      try {
        const second = await this.completeUnit(unit, built, config, escalated, usage, signal, headSha);
        return { ok: true, findings: second.findings, diagnostics: second.diagnostics, usage };
      } catch (escalatedError) {
        if (escalatedError instanceof ReviewerError && escalatedError.code === "CONFIG_INVALID") {
          throw escalatedError;
        }
        const escalatedStop = stopCode(stopped());
        if (escalatedStop !== undefined) {
          return this.unitFailure(unit, escalatedError, usage, escalatedStop);
        }
        return this.unitFailure(unit, escalatedError, usage, "REVIEW_OUTPUT_INCOMPLETE");
      }
    }
  }

  private unitFailure(
    unit: ReviewUnit,
    error: unknown,
    usage: ReviewUsage,
    code?: string,
  ): UnitOutcome {
    const reviewer = error instanceof ReviewerError ? error : null;
    const failureCode = code ?? reviewer?.code ?? "INTERNAL";
    // Malformed model output is a parse-stage outcome, not a transport failure.
    const stage = reviewer === null ? "unit" : failureCode === "PROVIDER_BAD_OUTPUT" ? "parse" : "provider";
    const rawMessage =
      reviewer?.message ?? (error instanceof Error ? error.message : String(error));
    this.logger.warn("review unit failed", {
      unitId: unit.id,
      code: failureCode,
      ...(failureCode === "REVIEW_OUTPUT_INCOMPLETE" ? { reason: "output-incomplete" } : {}),
    });
    const diagnostic: ReviewDiagnostic = {
      stage,
      code: failureCode,
      message: this.cleanDiagnosticMessage(rawMessage),
      unitId: unit.id,
      retryable: reviewer?.retryable ?? false,
    };
    return { ok: false, findings: [], diagnostics: [diagnostic], usage };
  }

  // Diagnostic text is static or redacted; model output and secrets never land here.
  private cleanDiagnosticMessage(text: string): string {
    const secrets = [...this.secrets, ...collectLlmSecrets(this.env)];
    return redact(text, secrets).slice(0, 500);
  }

  private async completeUnit(
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
        this.provider,
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
          this.logger.warn("review finding rejected", { unitId: unit.id });
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
}
