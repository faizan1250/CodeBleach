import { ReviewerError } from "../core/errors.ts";
import type { ReviewEngine } from "../core/contracts.ts";
import type { Logger } from "../core/logger.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { FIXED_MODEL_ID } from "../llm/constants.ts";
import { requireTrainingOptIn } from "../llm/training-gate.ts";
import type { LlmProvider } from "../providers/types.ts";
import type { ReviewUnit } from "../types/context.ts";
import type { ReviewBuildResult } from "../types/review.ts";
import { CODE_REVIEW_PROMPT_VERSION, codeReviewTemplateHash } from "./prompt.ts";
import { assembleReviewResult, emptyReviewUsage, type UnitOutcome } from "./result.ts";
import { createStageController, skipOutcome, stopCode } from "./stage.ts";
import { drainUnitPool } from "./pool.ts";
import { failReviewUnit, runReviewUnit, type UnitRunnerDeps } from "./unit-runner.ts";

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

/** One focused pass, one provider request per ReviewUnit. No batching. */
export class ReviewEngineImpl implements ReviewEngine {
  // Live engine: every unit-bearing review calls the provider, so the
  // pipeline preflights consent/key/budgets before diff and context.
  readonly requiresLlm = true;
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
    const headSha = options?.headSha ?? this.headSha;
    const stage = createStageController(options?.signal, config.llm.review_timeout_ms);
    const deps: UnitRunnerDeps = {
      provider: this.provider,
      logger: this.logger,
      env: this.env,
      secrets: this.secrets,
    };
    try {
      // Drain every worker before leaving: aborted siblings must land so no
      // provider call outlives the rejection and the timer clears exactly once.
      const { slots, fatal } = await drainUnitPool<UnitOutcome>({
        count: units.length,
        limit: config.llm.max_concurrent_requests,
        stopped: stage.stopped,
        hooks: {
          runUnit: (index, gate) => {
            const unit = units[index];
            if (unit === undefined) {
              return Promise.resolve({
                ok: true,
                findings: [],
                diagnostics: [],
                usage: emptyReviewUsage(),
              });
            }
            return runReviewUnit(deps, unit, config, {
              signal: stage.signal,
              stopped: stage.stopped,
              headSha,
              throwIfFatal: gate.throwIfFatal,
            });
          },
          failUnit: (index, error, stop) => {
            const unit = units[index];
            if (unit === undefined) {
              return { ok: true, findings: [], diagnostics: [], usage: emptyReviewUsage() };
            }
            return failReviewUnit(deps, unit, error, emptyReviewUsage(), stopCode(stop));
          },
          isPolicyFatal: (error) => error instanceof ReviewerError && error.code === "CONFIG_INVALID",
          abortStage: (error) => stage.abort(error),
        },
      });
      if (fatal !== undefined) throw fatal;
      // Units never claimed after a stop keep stable order with a skip diagnostic.
      const out: UnitOutcome[] = new Array(units.length);
      for (let index = 0; index < units.length; index += 1) {
        const slot = slots[index];
        if (slot !== undefined) {
          out[index] = slot;
          continue;
        }
        const unit = units[index];
        if (unit !== undefined) out[index] = skipOutcome(unit, stage.stopped() ?? "deadline");
      }
      return assembleReviewResult({
        unitsSubmitted: units.length,
        outcomes: out,
        promptVersion: identity.version,
        promptHash: identity.hash,
        model: FIXED_MODEL_ID,
      });
    } finally {
      stage.dispose();
    }
  }
}
