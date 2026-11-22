// Phase 6 inferred-convention data contracts (P6-00, ADR 0043).
//
// Pure data only: no runtime imports. Normative bounds live in
// src/conventions/constants.ts; stage interfaces live in
// src/core/contracts.ts. See implementation-phase6.md section 4.
import type { Finding } from "./finding.ts";
import type { ValidatedFinding } from "./validation.ts";

// One deterministic support span for a candidate pattern, merge-base side.
export interface ConventionEvidence {
  kind: "source-span";
  file: string;
  startLine: number;
  endLine: number;
}

// A high-support inferred pattern. Evidence paths and line references are
// audit metadata only: they never enter the advisory prompt (plan 9.2).
export interface InferredConvention {
  id: string;
  detector: string;
  detectorVersion: number;
  pattern: string;
  evidence: ConventionEvidence[];
  matchingFiles: number;
  eligibleFiles: number;
  sampledFiles: number;
  supportRatio: number;
}

// One verified head-side evidence interval. Base-side locations are omitted,
// never recoded: an accepted finding with only base-side evidence carries an
// entry with an empty list, which means no possible head-side overlap.
export interface ValidationHandoffLocation {
  path: string;
  startLine: number;
  endLine: number;
}

export interface ValidationHandoffEntry {
  findingId: string;
  headLocations: ValidationHandoffLocation[];
}

// Internal primary result: final winners plus transient handoff for retained
// accepted findings only. Never persisted (plan 13.1).
export interface PrimaryValidationResult {
  findings: ValidatedFinding[];
  handoff: ValidationHandoffEntry[];
}

// Internal advisory outcome before conflict suppression, advisory dedupe,
// and advisory cap. pendingFields omits status so the type system rejects
// assignment to ValidatedFinding or any artifact array; only
// finalizeAdvisoryCandidates may stamp status after all advisory filters.
export interface PendingAdvisoryCandidate {
  readonly phase: "pending-advisory-resolution";
  readonly findingId: string;
  readonly pendingFields: Omit<ValidatedFinding, "status">;
  readonly handoff: ValidationHandoffEntry;
}

// Sanitized per-request convention view: pattern statements and aggregate
// support counts only. Evidence arrays cannot cross this boundary by type.
export interface AdvisoryConventionSummary {
  detector: string;
  pattern: string;
  matchingFiles: number;
  eligibleFiles: number;
  supportRatio: number;
}

// Lean projection of one changed review unit for the advisory pass. Never
// derived from Omit<ReviewUnit, "rules">: full ReviewUnit context is too
// large and would leak explicit rules into the advisory request.
export interface ConventionAdvisoryUnit {
  unitId: string;
  path: string;
  language: string;
  symbol: {
    name: string;
    kind: string;
    signature: string;
    side: "head" | "base";
    startLine: number;
  };
  diffHunks: Array<{
    baseStartLine: number;
    headStartLine: number;
    lines: string[];
  }>;
  changedSymbolSource: string | null;
}

export interface ConventionAdvisoryProjectionResult {
  units: ConventionAdvisoryUnit[];
  skippedUnits: number;
}

export interface ConventionAdvisoryBatchInput {
  units: ConventionAdvisoryUnit[];
  conventions: AdvisoryConventionSummary[];
}

// Trusted post-association advisory finding: unitId is validated against the
// exact request batch by the engine, never trusted from model output.
export interface ConventionAdvisoryCandidate {
  unitId: string;
  finding: Finding;
}

export interface ConventionAdvisoryReviewResult {
  candidates: ConventionAdvisoryCandidate[];
  inputTokens: number;
  outputTokens: number;
  codes: string[];
}

export interface ConventionBuildDiagnostics {
  sampledFiles: number;
  skippedFiles: number;
  conventions: number;
  codes: string[];
}

export interface ConventionBuildResult {
  conventions: InferredConvention[];
  diagnostics: ConventionBuildDiagnostics;
}

// Transient-only merge outcome. conflictMetadata carries bounded counts and
// stable codes; per-finding records never persist (plan 13.1).
export interface AdvisoryConflictMetadata {
  suppressed: number;
  advisoryDuplicates: number;
  unmappableExcluded: number;
  codes: string[];
}

export interface AdvisoryExecutionResult {
  findings: ValidatedFinding[];
  conflictMetadata: AdvisoryConflictMetadata;
}
