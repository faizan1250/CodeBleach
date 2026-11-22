import type { loadConfig } from "../config/load.ts";
import type { Logger } from "./logger.ts";
import type {
  AcceptedValidatedFinding,
  AttributionBasis,
  DiffResult,
  Finding,
  PrMeta,
  PublishResult,
  ReviewUnit,
  ValidatedFinding,
  ValidationTarget,
} from "../types/index.ts";
import type { ContextBuildResult } from "../types/context.ts";
import type { ReviewBuildResult } from "../types/review.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { Result } from "./result.ts";
import type { ConfigLoadResult } from "../config/load.ts";
import type { ReviewerError } from "./errors.ts";

export interface DiffEngine {
  run(input: { repoDir: string; baseSha: string; headSha: string; config: ResolvedConfig }): Promise<DiffResult>;
}

export interface ContextEngine {
  build(diff: DiffResult, config: ResolvedConfig, repoDir: string): Promise<ContextBuildResult>;
}

export interface ReviewEngine {
  review(
    units: ReviewUnit[],
    config: ResolvedConfig,
    // Mirrors ReviewCallOptions in src/review/engine.ts: per-call headSha for
    // code-owned attribution (P4-09) plus caller cancellation (P4-08).
    options?: { signal?: AbortSignal | undefined; headSha?: string | undefined } | undefined,
  ): Promise<ReviewBuildResult>;
  /**
   * False for offline/canned engines (demo, --no-llm skips) that never call
   * the provider. Absent means the engine needs the model: the pipeline runs
   * the LLM preflight (consent/key/budgets) before diff and context.
   */
  readonly requiresLlm?: boolean | undefined;
}

export interface ValidationEngine {
  validate(
    findings: Finding[],
    diff: DiffResult,
    units: ReviewUnit[],
    config: ResolvedConfig,
    options?: ValidationOptions | undefined,
  ): Promise<ValidatedFinding[]>;
}

/** Optional per-run caller cancellation; forwarded to every snapshot Git read. */
export interface ValidationOptions {
  signal?: AbortSignal | undefined;
}

export interface Publisher {
  publish(findings: AcceptedValidatedFinding[], diff: DiffResult, meta: PrMeta): Promise<PublishResult>;
}

/** Narrowing guard for the accepted-only publisher contract. Status alone
 * never suffices: an accepted finding must carry the complete publish
 * invariant — a valid head-side target plus a code-derived
 * `introducedByPr: true` attribution with a defined valid basis. Anything
 * less fails the guard, and the pipeline treats a status-accepted item that
 * fails it as an internal contract violation (fail closed, never published
 * or counted). */
export function isAcceptedFinding(finding: ValidatedFinding): finding is AcceptedValidatedFinding {
  if (finding.status !== "accepted") return false;
  if (!isValidValidationTarget(finding.derivedTarget)) return false;
  const attribution = finding.derivedAttribution;
  if (attribution === null || attribution === undefined || typeof attribution !== "object") return false;
  if (attribution.introducedByPr !== true) return false;
  return isValidAttributionBasis(attribution.basis);
}

function isValidValidationTarget(target: unknown): target is ValidationTarget {
  if (target === null || target === undefined || typeof target !== "object") return false;
  const candidate = target as Partial<ValidationTarget>;
  if (typeof candidate.file !== "string" || candidate.file.length === 0) return false;
  if (typeof candidate.line !== "number" || !Number.isSafeInteger(candidate.line) || candidate.line < 1) return false;
  if (candidate.side !== "RIGHT") return false;
  if (
    candidate.kind !== "added" &&
    candidate.kind !== "context" &&
    candidate.kind !== "relocated" &&
    candidate.kind !== "deletion-anchor"
  ) {
    return false;
  }
  if (
    candidate.sourceLine !== undefined &&
    (typeof candidate.sourceLine !== "number" ||
      !Number.isSafeInteger(candidate.sourceLine) ||
      candidate.sourceLine < 1)
  ) {
    return false;
  }
  return true;
}

function isValidAttributionBasis(basis: unknown): basis is AttributionBasis {
  if (basis === null || basis === undefined || typeof basis !== "object") return false;
  const candidate = basis as Partial<AttributionBasis>;
  if (candidate.kind !== "added-lines" && candidate.kind !== "deleted-lines") return false;
  if (
    typeof candidate.evidenceIndex !== "number" ||
    !Number.isSafeInteger(candidate.evidenceIndex) ||
    candidate.evidenceIndex < 0
  ) {
    return false;
  }
  if (typeof candidate.file !== "string" || candidate.file.length === 0) return false;
  if (!Array.isArray(candidate.lines) || candidate.lines.length === 0) return false;
  for (const line of candidate.lines) {
    if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) return false;
  }
  return true;
}

export type StageName = "config" | "diff" | "context" | "review" | "validation" | "publish";

export type StageStatus = "completed" | "failed" | "skipped";

export interface StageResult {
  name: StageName;
  status: StageStatus;
  ms: number;
  count?: number | undefined;
  reason?: string | undefined;
}

export type ConfigSource = "file" | "defaults" | "unavailable";

export interface RunSummary {
  runId: string;
  status: "completed" | "failed";
  baseSha: string;
  headSha: string;
  configSource: ConfigSource;
  stages: StageResult[];
}

export interface PipelineInput {
  repoDir: string;
  baseSha: string;
  headSha: string;
  pr?: PrMeta | undefined;
  dryRun: boolean;
  outDir: string;
  /** Single execution id, minted once by the CLI and shared by logger + artifact. */
  runId: string;
  secrets?: string[] | undefined;
  /**
   * Optional per-run caller cancellation. The pipeline forwards it to
   * validation snapshot reads; the CLI does not yet wire a caller signal,
   * so cancellation today comes only from programmatic pipeline use.
   */
  signal?: AbortSignal | undefined;
  /**
   * Per-run environment for the LLM preflight (consent/key checks). Defaults
   * to process.env; tests pass explicit maps. Ignored when the review engine
   * declares requiresLlm === false.
   */
  env?: Record<string, string | undefined> | undefined;
}

export type LoadConfigFn = typeof loadConfig;

export interface PipelineDeps {
  diff: DiffEngine;
  context: ContextEngine;
  review: ReviewEngine;
  validation: ValidationEngine;
  publisher: Publisher;
  logger: Logger;
  loadConfig?: LoadConfigFn | undefined;
}

export type { ConfigLoadResult, ResolvedConfig, Result, ReviewerError };
