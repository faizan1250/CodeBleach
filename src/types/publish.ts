export interface PublishFailure {
  file: string;
  line: number;
  // Stable machine-readable code; "marker_key_collision" reserved (ADR 0045).
  reason: string;
}

/** Closed run-level failure codes (ADR 0045); no raw API text. */
export type PublishRunFailureCode =
  | "permission_denied"
  | "rate_limited"
  | "github_unavailable"
  | "pr_closed"
  | "pr_identity_mismatch"
  | "stale_base_sha"
  | "stale_head_sha"
  | "comment_inventory_incomplete"
  | "ambiguous_post_outcome"
  | "reconciliation_incomplete"
  | "reconciliation_skipped_incomplete_run";

export interface PublishRunFailure {
  code: PublishRunFailureCode; // closed stable code union; no raw API text
  message?: string | undefined; // short static/sanitized operator-facing text
}

export interface PublishResult {
  published: number;
  skipped: number;
  failures: PublishFailure[];
  runFailures: PublishRunFailure[];
}
