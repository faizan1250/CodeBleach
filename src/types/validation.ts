import { z } from "zod";
import type { Finding } from "./finding.ts";

export type ValidationCheckOutcome = "passed" | "failed" | "inconclusive" | "skipped";

export interface CheckResult {
  name: string;
  outcome: ValidationCheckOutcome;
  code: ValidationCheckCode;
  detail?: string | undefined;
}

/**
 * Closed machine-readable code set (P5-08). `name` carries the stable check
 * family; `code` carries the precise reason. `not_introduced_by_pr` is
 * reserved for a future proven-absence verdict; attribution stays fail-closed
 * (`introduction_inconclusive`) in v1, so it is defined but not emitted.
 */
export type ValidationCheckCode =
  | "finding_identity_verified"
  | "finding_identity_invalid"
  | "finding_head_sha_match"
  | "finding_head_sha_mismatch"
  | "origin_unit_resolved"
  | "origin_unit_missing"
  | "origin_file_resolved"
  | "origin_file_mismatch"
  | "finding_path_resolved"
  | "finding_path_not_in_diff"
  | "finding_path_invalid"
  | "rename_path_mapping_invalid"
  | "finding_symbol_match"
  | "finding_symbol_mismatch"
  | "evidence_provenance_ok"
  | "evidence_path_not_allowed"
  | "location_line_valid"
  | "finding_line_invalid"
  | "head_comment_target_ok"
  | "finding_line_not_commentable"
  | "no_commentable_target"
  | "target_relocated"
  | "deletion_anchor_missing"
  | "evidence_bounds_ok"
  | "evidence_range_invalid"
  | "evidence_quote_verified"
  | "evidence_quote_not_found"
  | "evidence_side_ambiguous"
  | "evidence_unavailable"
  | "introduced_by_pr_verified"
  | "not_introduced_by_pr"
  | "introduction_inconclusive"
  | "category_enabled"
  | "category_disabled"
  | "rule_ok"
  | "rule_id_unknown"
  | "rule_path_mismatch"
  | "severity_ok"
  | "severity_below_threshold"
  | "confidence_ok"
  | "confidence_below_threshold"
  | "snapshot_unavailable"
  | "snapshot_unsupported_object"
  | "snapshot_binary"
  | "snapshot_size_limit"
  | "dedupe_unique"
  | "duplicate_fingerprint"
  | "duplicate_secondary_key"
  | "max_findings_ok"
  | "max_findings_exceeded"
  | "check_skipped_prerequisite_failed";

/** Closed-set pin for tests: every emitted code must be a member. */
export const VALIDATION_CHECK_CODES: readonly ValidationCheckCode[] = [
  "finding_identity_verified",
  "finding_identity_invalid",
  "finding_head_sha_match",
  "finding_head_sha_mismatch",
  "origin_unit_resolved",
  "origin_unit_missing",
  "origin_file_resolved",
  "origin_file_mismatch",
  "finding_path_resolved",
  "finding_path_not_in_diff",
  "finding_path_invalid",
  "rename_path_mapping_invalid",
  "finding_symbol_match",
  "finding_symbol_mismatch",
  "evidence_provenance_ok",
  "evidence_path_not_allowed",
  "location_line_valid",
  "finding_line_invalid",
  "head_comment_target_ok",
  "finding_line_not_commentable",
  "no_commentable_target",
  "target_relocated",
  "deletion_anchor_missing",
  "evidence_bounds_ok",
  "evidence_range_invalid",
  "evidence_quote_verified",
  "evidence_quote_not_found",
  "evidence_side_ambiguous",
  "evidence_unavailable",
  "introduced_by_pr_verified",
  "not_introduced_by_pr",
  "introduction_inconclusive",
  "category_enabled",
  "category_disabled",
  "rule_ok",
  "rule_id_unknown",
  "rule_path_mismatch",
  "severity_ok",
  "severity_below_threshold",
  "confidence_ok",
  "confidence_below_threshold",
  "snapshot_unavailable",
  "snapshot_unsupported_object",
  "snapshot_binary",
  "snapshot_size_limit",
  "dedupe_unique",
  "duplicate_fingerprint",
  "duplicate_secondary_key",
  "max_findings_ok",
  "max_findings_exceeded",
  "check_skipped_prerequisite_failed",
];

export const LlmVerdictSchema = z.strictObject({
  verdict: z.enum(["confirmed", "refuted", "inconclusive"]),
  reasoning: z.string().min(1),
});

export type LlmVerdict = z.infer<typeof LlmVerdictSchema>;

/** Code-owned head-side publish target (P5-03; exposed for Phase 7). */
export interface ValidationTarget {
  /** Canonical head-side path; the only future publishable identity. */
  file: string;
  /** 1-based head-side commentable line. */
  line: number;
  side: "RIGHT";
  kind: "added" | "context" | "relocated" | "deletion-anchor";
  /** Original finding line when the target differs (relocated, deletion-anchor). */
  sourceLine?: number | undefined;
}

export interface ValidatedFinding {
  finding: Finding;
  status: "accepted" | "rejected" | "inconclusive";
  checks: CheckResult[];
  llmVerdict?: LlmVerdict | undefined;
  /**
   * P5-05 code-derived attribution; absent when attribution never ran. The
   * model `Finding.introducedByPr` never decides acceptance (ADR 0028 D3).
   */
  derivedAttribution?: DerivedAttribution | undefined;
  /**
   * P5-03 head-side anchor when location succeeded (required on accepted,
   * diagnostic otherwise). Never a publish action by itself; only accepted
   * findings are publish-eligible.
   */
  derivedTarget?: ValidationTarget | undefined;
  /**
   * Retained finding id when rejected as a same-run duplicate (P5-07 key
   * reuse; P5-08 boundary wiring). Absent unless a dedupe check failed.
   */
  duplicateOfId?: string | undefined;
}

/** Publish-eligible subset: the publisher contract accepts only these. */
export type AcceptedValidatedFinding = Omit<ValidatedFinding, "status"> & { status: "accepted" };

/** Aggregate counts over one validation run (artifact v2). */
export interface ValidationSummary {
  total: number;
  accepted: number;
  rejected: number;
  inconclusive: number;
  duplicates: number;
  policyFiltered: number;
  checksSkipped: number;
}

export type AttributionBasisKind = "added-lines" | "deleted-lines";

export interface AttributionBasis {
  kind: AttributionBasisKind;
  evidenceIndex: number;
  file: string;
  lines: number[];
}

export interface DerivedAttribution {
  introducedByPr: boolean;
  basis?: AttributionBasis | undefined;
}
