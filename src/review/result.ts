import { FIXED_MODEL_ID } from "../llm/constants.ts";
import type { Finding } from "../types/finding.ts";
import type {
  ReviewBuildResult,
  ReviewDiagnostic,
  ReviewStatus,
  ReviewUsage,
} from "../types/review.ts";
import { getCodeReviewPromptIdentity } from "./prompt.ts";

// Mirrors the Context Engine's 100-diagnostic bound; counts stay exact.
export const MAX_REVIEW_DIAGNOSTICS = 100;

export interface UnitOutcome {
  /** True when the unit produced a usable (possibly empty) finding list. */
  ok: boolean;
  findings: Finding[];
  diagnostics: ReviewDiagnostic[];
  usage: ReviewUsage;
}

export function emptyReviewUsage(): ReviewUsage {
  return {
    requests: 0,
    retries: 0,
    repairRequests: 0,
    incompleteRetries: 0,
    costKnown: false,
  };
}

/** Sum a per-unit slice into the run total; unknown stays undefined, never zero. */
export function mergeReviewUsage(total: ReviewUsage, part: ReviewUsage): void {
  total.requests += part.requests;
  total.retries += part.retries;
  total.repairRequests += part.repairRequests;
  total.incompleteRetries += part.incompleteRetries;
  if (part.inputTokens !== undefined) total.inputTokens = (total.inputTokens ?? 0) + part.inputTokens;
  if (part.outputTokens !== undefined) {
    total.outputTokens = (total.outputTokens ?? 0) + part.outputTokens;
  }
  if (part.reasoningTokens !== undefined) {
    total.reasoningTokens = (total.reasoningTokens ?? 0) + part.reasoningTokens;
  }
  if (part.costKnown) {
    total.costKnown = true;
    total.costUsd = (total.costUsd ?? 0) + (part.costUsd ?? 0);
  }
  total.totalTokens =
    total.inputTokens !== undefined && total.outputTokens !== undefined
      ? total.inputTokens + total.outputTokens
      : undefined;
}

export function deriveReviewStatus(submitted: number, reviewed: number): ReviewStatus {
  if (submitted === 0 || reviewed === submitted) return "complete";
  return reviewed > 0 ? "partial" : "failed";
}

/** Deterministic assembly: stable finding order, bounded diagnostics, summed usage. */
export function assembleReviewResult(input: {
  unitsSubmitted: number;
  outcomes: UnitOutcome[];
  promptVersion: string;
  promptHash: string;
  model: string;
}): ReviewBuildResult {
  const findings: ReviewBuildResult["findings"] = [];
  const diagnostics: ReviewDiagnostic[] = [];
  const usage = emptyReviewUsage();
  let reviewed = 0;
  for (const outcome of input.outcomes) {
    if (outcome.ok) reviewed += 1;
    findings.push(...outcome.findings);
    mergeReviewUsage(usage, outcome.usage);
    for (const diagnostic of outcome.diagnostics) {
      if (diagnostics.length >= MAX_REVIEW_DIAGNOSTICS) break;
      diagnostics.push(diagnostic);
    }
  }
  return {
    status: deriveReviewStatus(input.unitsSubmitted, reviewed),
    findings,
    diagnostics,
    usage,
    unitsSubmitted: input.unitsSubmitted,
    unitsReviewed: reviewed,
    unitsFailed: input.unitsSubmitted - reviewed,
    promptVersion: input.promptVersion,
    promptHash: input.promptHash,
    model: input.model,
  };
}

/** Explicit offline preview shape for the P4-09 --no-llm path; never calls a provider. */
export function skippedReviewResult(): ReviewBuildResult {
  const identity = getCodeReviewPromptIdentity();
  return {
    status: "skipped",
    findings: [],
    diagnostics: [],
    usage: emptyReviewUsage(),
    unitsSubmitted: 0,
    unitsReviewed: 0,
    unitsFailed: 0,
    promptVersion: identity.version,
    promptHash: identity.hash,
    model: FIXED_MODEL_ID,
  };
}
