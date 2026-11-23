import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ConventionAdvisoryReviewEngine } from "../core/contracts.ts";
import { ReviewerError } from "../core/errors.ts";
import { requireTrainingOptIn } from "../llm/training-gate.ts";
import type { LlmProvider } from "../providers/types.ts";
import type { Finding } from "../types/finding.ts";
import { EvidenceSchema } from "../types/finding.ts";
import type {
  ConventionAdvisoryBatchInput,
  ConventionAdvisoryCandidate,
  ConventionAdvisoryReviewResult,
} from "../types/conventions.ts";
import {
  MAX_ADVISORY_INPUT_TOKENS_PER_REQUEST,
  MAX_ADVISORY_OUTPUT_TOKENS_PER_REQUEST,
  MAX_ADVISORY_UNITS_PER_REQUEST,
} from "../conventions/constants.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { estimateTokens } from "../utils/tokens.ts";
import { CONVENTION_ADVISORY_PASS, buildConventionAdvisoryPrompt } from "./convention-prompt.ts";
import { normalizeFinding } from "./normalize.ts";

// Strict output contract, internal to the engine. The schema never shares the
// primary review shape: category and severity are literals, and ruleId is not
// a member, so strict parsing rejects any rule reference or forged provenance.
const AdvisoryRawFindingSchema = z
  .strictObject({
    title: z.string().min(1).max(120),
    severity: z.literal("low"),
    category: z.literal("convention"),
    file: z.string().min(1),
    line: z.number().int().positive(),
    endLine: z.number().int().positive().optional(),
    description: z.string().min(1).max(2000),
    suggestion: z.string().max(2000).optional(),
    confidence: z.number().min(0).max(1),
    evidence: z.array(EvidenceSchema).min(1),
    introducedByPr: z.boolean(),
  })
  .check((ctx) => {
    const endLine = ctx.value.endLine;
    if (endLine !== undefined && endLine < ctx.value.line) {
      ctx.issues.push({
        code: "custom",
        message: "endLine must be >= line",
        input: endLine,
        path: ["endLine"],
      });
    }
  });

const AdvisoryRawBatchSchema = z.strictObject({
  findings: z
    .array(z.strictObject({ unitId: z.string().min(1), finding: AdvisoryRawFindingSchema }))
    .max(5),
});

type AdvisoryRawBatch = z.infer<typeof AdvisoryRawBatchSchema>;

// Packer-selected summaries per request (plan 9.3): never more than eight.
const MAX_SUMMARIES_PER_REQUEST = 8;

function badOutput(message: string, cause?: unknown): ReviewerError {
  return new ReviewerError({
    code: "PROVIDER_BAD_OUTPUT",
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function invalidInput(message: string): ReviewerError {
  return new ReviewerError({ code: "CONFIG_INVALID", message });
}

export interface ConventionAdvisoryEngineOptions {
  provider: LlmProvider;
  env?: Record<string, string | undefined> | undefined;
  headSha?: string | undefined;
  generateId?: (() => string) | undefined;
}

/**
 * Advisory-only model pass (plan 4.3, 9.3-9.6). Exactly one provider
 * invocation per reviewBatch call: no JSON repair retry, no cap escalation,
 * no transport retry here. The injected provider instance must be
 * advisory-specific with maxRetries 0 (wired by the P6-05 composition root);
 * this engine never calls complete() twice for one batch either way.
 */
export class ConventionAdvisoryReviewEngineImpl implements ConventionAdvisoryReviewEngine {
  private readonly provider: LlmProvider;
  private readonly env: Record<string, string | undefined>;
  private readonly headSha: string;
  private readonly generateId: () => string;

  constructor(options: ConventionAdvisoryEngineOptions) {
    const opts = options as ConventionAdvisoryEngineOptions | null | undefined;
    if (opts === null || opts === undefined || typeof opts.provider?.complete !== "function") {
      throw new ReviewerError({
        code: "INTERNAL",
        message: "ConventionAdvisoryReviewEngineImpl requires options with a provider",
      });
    }
    this.provider = opts.provider;
    this.env = opts.env ?? process.env;
    this.headSha = opts.headSha ?? "";
    this.generateId = opts.generateId ?? randomUUID;
  }

  async reviewBatch(
    input: ConventionAdvisoryBatchInput,
    config: ResolvedConfig,
    options?: { signal?: AbortSignal | undefined; headSha?: string | undefined } | undefined,
  ): Promise<ConventionAdvisoryReviewResult> {
    const units = input?.units;
    const conventions = input?.conventions;
    if (!Array.isArray(units) || !Array.isArray(conventions)) {
      throw new ReviewerError({ code: "INTERNAL", message: "advisory reviewBatch requires units and conventions arrays" });
    }
    if (units.length === 0) {
      return { candidates: [], inputTokens: 0, outputTokens: 0, codes: ["advisory_skipped_no_units"] };
    }
    if (conventions.length === 0) {
      return { candidates: [], inputTokens: 0, outputTokens: 0, codes: ["advisory_skipped_no_conventions"] };
    }
    if (units.length > MAX_ADVISORY_UNITS_PER_REQUEST) {
      throw invalidInput(
        `advisory batch holds ${units.length} units, above the ${MAX_ADVISORY_UNITS_PER_REQUEST}-unit ceiling`,
      );
    }
    if (conventions.length > MAX_SUMMARIES_PER_REQUEST) {
      throw invalidInput(
        `advisory batch holds ${conventions.length} convention summaries, above the ${MAX_SUMMARIES_PER_REQUEST}-summary ceiling`,
      );
    }
    const unitIds = new Set<string>();
    for (const unit of units) {
      if (unitIds.has(unit.unitId)) {
        throw invalidInput("advisory batch holds duplicate unit identifiers");
      }
      unitIds.add(unit.unitId);
    }

    const built = buildConventionAdvisoryPrompt({ units, conventions });
    if (built.estimatedInputTokens > MAX_ADVISORY_INPUT_TOKENS_PER_REQUEST) {
      throw invalidInput(
        `advisory request measures ${built.estimatedInputTokens} input tokens, above the ${MAX_ADVISORY_INPUT_TOKENS_PER_REQUEST}-token ceiling`,
      );
    }

    // Training-consent gate before any network access: the feature flag is
    // never consent, and a denied gate skips the call with primary intact.
    requireTrainingOptIn(this.env);

    const headSha = options?.headSha ?? this.headSha;
    // Single attempt: malformed output or association failure drops the batch
    // below, never a second provider call.
    const response = await this.provider.complete(
      {
        system: built.system,
        user: built.user,
        maxTokens: MAX_ADVISORY_OUTPUT_TOKENS_PER_REQUEST,
        timeoutMs: config.llm.request_timeout_ms,
      },
      options?.signal,
    );

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(response.text) as unknown;
    } catch {
      throw badOutput("advisory provider returned invalid JSON");
    }
    const parsed = AdvisoryRawBatchSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw badOutput(`advisory response failed schema validation: ${describeIssues(parsed.error)}`);
    }
    const candidates = this.toCandidates(parsed.data, { units, headSha });
    const usage = response.usage;
    return {
      candidates,
      inputTokens: usage?.inputTokens ?? estimateTokens(`${built.system}\n${built.user}`),
      outputTokens: usage?.outputTokens ?? estimateTokens(response.text),
      codes: [],
    };
  }

  // Strict unit association plus trusted normalization. Unknown or duplicate
  // unit IDs, more than one candidate per unit, or a single malformed finding
  // invalidates the whole batch (never a repair call: the request budget is
  // hard). Model-supplied provenance never survives: id, fingerprint,
  // headSha, symbol, and origin are stamped here.
  private toCandidates(
    batch: AdvisoryRawBatch,
    ctx: { units: ConventionAdvisoryBatchInput["units"]; headSha: string },
  ): ConventionAdvisoryCandidate[] {
    const order = new Map<string, number>();
    ctx.units.forEach((unit, index) => {
      order.set(unit.unitId, index);
    });
    const seen = new Set<string>();
    const candidates: ConventionAdvisoryCandidate[] = [];
    for (const entry of batch.findings) {
      const index = order.get(entry.unitId);
      if (index === undefined) {
        throw badOutput("advisory finding references a unit outside the request batch");
      }
      if (seen.has(entry.unitId)) {
        throw badOutput("advisory batch holds more than one finding for a unit");
      }
      seen.add(entry.unitId);
      const unit = ctx.units[index];
      if (unit === undefined) {
        throw badOutput("advisory finding references a unit outside the request batch");
      }
      const finding: Finding | null = normalizeFinding(
        {
          ...entry.finding,
          ...(entry.finding.endLine === undefined ? {} : { endLine: entry.finding.endLine }),
          ...(entry.finding.suggestion === undefined ? {} : { suggestion: entry.finding.suggestion }),
        },
        {
          unit: { id: unit.unitId, symbol: { name: unit.symbol.name }, rules: [] },
          headSha: ctx.headSha,
          pass: CONVENTION_ADVISORY_PASS,
          generateId: this.generateId,
        },
      );
      if (finding === null) {
        throw badOutput("advisory finding rejected during normalization");
      }
      candidates.push({ unitId: entry.unitId, finding });
    }
    // Input order, never provider order.
    candidates.sort((a, b) => {
      const first = order.get(a.unitId) ?? Number.MAX_SAFE_INTEGER;
      const second = order.get(b.unitId) ?? Number.MAX_SAFE_INTEGER;
      return first - second;
    });
    return candidates;
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`).join("; ");
}
