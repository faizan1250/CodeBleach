import { createHash, randomUUID } from "node:crypto";
import type { ResolvedConfig } from "../config/schema.ts";
import type { ReviewEngine } from "../core/contracts.ts";
import { ReviewerError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import { requireTrainingOptIn } from "../llm/training-gate.ts";
import { completeJson } from "../providers/json.ts";
import type { LlmProvider } from "../providers/types.ts";
import { RawReviewOutputSchema, type Finding, type RawFinding } from "../types/finding.ts";
import type { ReviewUnit } from "../types/context.ts";
import { buildReviewPrompt, CODE_REVIEW_PROMPT_VERSION, isPromptWithinBudget } from "./prompt.ts";

export interface ReviewEngineOptions {
  provider: LlmProvider;
  logger: Logger;
  env?: Record<string, string | undefined> | undefined;
  /** DiffResult.headSha wiring lands in P4-06/P4-09; empty until then. */
  headSha?: string | undefined;
}

// Provisional P4-04 fingerprint: sha1(file + symbol + category + title).
// P4-06 hardens path/ruleId handling; any algorithm change needs an ADR.
function fingerprintFor(raw: RawFinding, symbol: string): string {
  const file = raw.file.trim().replace(/\\/g, "/");
  const title = raw.title.trim().replace(/\s+/g, " ").toLowerCase();
  return createHash("sha1").update(`${file}\u0000${symbol}\u0000${raw.category}\u0000${title}`).digest("hex");
}

function toFinding(raw: RawFinding, unit: ReviewUnit, headSha: string): Finding {
  return {
    ...raw,
    id: randomUUID(),
    fingerprint: fingerprintFor(raw, unit.symbol.name),
    headSha,
    symbol: unit.symbol.name,
    origin: { pass: CODE_REVIEW_PROMPT_VERSION, unitId: unit.id },
  };
}

/** One focused pass, one provider request per ReviewUnit. No batching. */
export class ReviewEngineImpl implements ReviewEngine {
  private readonly provider: LlmProvider;
  private readonly logger: Logger;
  private readonly env: Record<string, string | undefined>;
  private readonly headSha: string;

  constructor(options: ReviewEngineOptions) {
    const logger = (options as ReviewEngineOptions | null | undefined)?.logger;
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
    this.provider = (options as ReviewEngineOptions).provider;
    this.env = (options as ReviewEngineOptions).env ?? process.env;
    this.headSha = (options as ReviewEngineOptions).headSha ?? "";
  }

  async review(units: ReviewUnit[], config: ResolvedConfig): Promise<Finding[]> {
    requireTrainingOptIn(this.env);
    if (units.length === 0) return [];
    const limit = Math.max(1, config.llm.max_concurrent_requests);
    const out: Finding[][] = new Array(units.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, units.length) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= units.length) return;
        const unit = units[index];
        if (unit === undefined) continue;
        try {
          out[index] = await this.reviewUnit(unit, config);
        } catch (error) {
          // Policy errors abort the whole run; per-unit failures stay partial.
          if (error instanceof ReviewerError && error.code === "CONFIG_INVALID") throw error;
          this.logger.warn("review unit failed", {
            unitId: unit.id,
            code: error instanceof ReviewerError ? error.code : "UNKNOWN",
          });
          out[index] = [];
        }
      }
    });
    await Promise.all(workers);
    return out.flat();
  }

  private async reviewUnit(unit: ReviewUnit, config: ResolvedConfig): Promise<Finding[]> {
    const built = buildReviewPrompt(unit, config);
    if (!isPromptWithinBudget(built, config.llm.max_review_unit_input_tokens)) {
      this.logger.warn("review unit skipped", { unitId: unit.id, reason: "input-budget-exceeded" });
      return [];
    }
    const output = await completeJson(
      this.provider,
      {
        system: built.system,
        user: built.user,
        maxTokens: config.llm.max_output_tokens,
        timeoutMs: config.llm.request_timeout_ms,
      },
      RawReviewOutputSchema,
    );
    return output.findings.map((raw) => toFinding(raw, unit, this.headSha));
  }
}
