import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedConfig } from "../config/schema.ts";
import { sanitizePayload } from "../utils/redact.ts";
import type {
  ContextBuildDiagnostics,
  DiffResult,
  Finding,
  PublishResult,
  PublishRunFailure,
  ReviewUnit,
  ValidatedFinding,
  ValidationSummary,
} from "../types/index.ts";
import type { ReviewDiagnostic, ReviewStatus, ReviewUsage } from "../types/review.ts";
import type { ConfigSource, StageResult } from "./contracts.ts";

export const RUN_ARTIFACT_SCHEMA_VERSION = 2;

/** Legacy schema-v2 shape: runFailures absent on artifacts written before P7-00 (ADR 0045). */
export type LegacyPublishResult = Omit<PublishResult, "runFailures"> & {
  runFailures?: PublishRunFailure[] | undefined;
};

/**
 * Read/persist-boundary normalization: legacy artifacts without runFailures
 * read as []. Schema stays v2; the JSON change is additive.
 */
export function normalizePublishResult(result: LegacyPublishResult | null | undefined): PublishResult | null {
  if (result === null || result === undefined) return null;
  return { ...result, runFailures: result.runFailures ?? [] };
}

export interface SerializedError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface RunArtifact {
  schemaVersion: 2;
  runId: string;
  startedAt: string;
  completedAt: string;
  baseSha: string;
  headSha: string;
  configSource: ConfigSource;
  status: "running" | "completed" | "failed";
  stages: StageResult[];
  config: ResolvedConfig | null;
  diff: DiffResult | null;
  units: ReviewUnit[];
  contextStatus: "complete" | "partial" | "failed" | null;
  contextDiagnostics: ContextBuildDiagnostics | null;
  findings: Finding[];
  reviewStatus: ReviewStatus | null;
  reviewPromptVersion: string | null;
  reviewPromptHash: string | null;
  reviewModel: string | null;
  reviewUnitsSubmitted: number | null;
  reviewUnitsReviewed: number | null;
  reviewUnitsFailed: number | null;
  reviewUsage: ReviewUsage | null;
  reviewDiagnostics: ReviewDiagnostic[] | null;
  validated: ValidatedFinding[];
  /** Null until the validation stage runs (skipped review, or stage failure). */
  validationSummary: ValidationSummary | null;
  publishResult: PublishResult | null;
  error?: SerializedError | undefined;
}

const DUPLICATE_CODES: ReadonlySet<string> = new Set(["duplicate_fingerprint", "duplicate_secondary_key"]);
const POLICY_CODES: ReadonlySet<string> = new Set([
  "category_disabled",
  "severity_below_threshold",
  "confidence_below_threshold",
  "rule_id_unknown",
  "rule_path_mismatch",
]);

/** Pure aggregate counts over one validation run (P5-08 artifact). */
export function summarizeValidation(results: ValidatedFinding[]): ValidationSummary {
  let accepted = 0;
  let rejected = 0;
  let inconclusive = 0;
  let duplicates = 0;
  let policyFiltered = 0;
  let checksSkipped = 0;
  for (const item of results) {
    if (item.status === "accepted") accepted += 1;
    else if (item.status === "rejected") rejected += 1;
    else inconclusive += 1;
    let isDuplicate = false;
    let isPolicyFiltered = false;
    for (const check of item.checks) {
      if (check.outcome === "skipped") checksSkipped += 1;
      if (check.outcome !== "failed") continue;
      if (DUPLICATE_CODES.has(check.code)) isDuplicate = true;
      if (POLICY_CODES.has(check.code)) isPolicyFiltered = true;
    }
    if (isDuplicate) duplicates += 1;
    if (isPolicyFiltered) policyFiltered += 1;
  }
  return { total: results.length, accepted, rejected, inconclusive, duplicates, policyFiltered, checksSkipped };
}

/** Atomically write pretty-printed, recursively redacted JSON to `<outDir>/run.json`. */
export async function writeArtifact(outDir: string, artifact: RunArtifact, secrets: string[] = []): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const redacted = sanitizePayload(artifact, secrets) as RunArtifact;
  const path = join(outDir, "run.json");
  const temp = join(outDir, `run.json.tmp.${process.pid}`);
  await writeFile(temp, `${JSON.stringify(redacted, null, 2)}\n`, "utf8");
  await rename(temp, path);
}
