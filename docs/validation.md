# Validation (Phase 5, deterministic-only v1)

Model findings are verified against the PR diff and exact Git snapshots before
they can be accepted. The engine (`src/validate/`) makes no `LlmProvider`
calls; `ValidatedFinding.llmVerdict` stays absent. Decisions: ADR 0028
(decision matrix), ADR 0029 (result contract, artifact v2), ADR 0030 (P5-10
hardening). Plan: `implementation-phase5.md`.

Limitation on record: deterministic validation proves a finding is
structurally valid, tied to the PR, accurately located, and evidence-grounded.
It does not prove the semantic bug claim is correct.

## Statuses

`accepted` (every required check passed; eligible for the publisher),
`rejected` (a check proves it invalid, out-of-PR, unsupported, policy-filtered,
or a same-run duplicate), `inconclusive` (required evidence/source data is
unavailable, ambiguous, truncated, or exceeds a bound). Rejected and
inconclusive findings persist in `run.json`; only `accepted` findings reach
`Publisher.publish`. Accepted additionally requires the complete publish
invariant: a valid head-side `derivedTarget` plus `derivedAttribution` with
`introducedByPr: true` and a defined valid `AttributionBasis` (ADR 0035) —
status alone never publishes, and the pipeline fails closed (`INTERNAL`,
nothing published or counted) on a status-`accepted` item missing any part.
The CLI prints counts plus a `run.json` pointer — never evidence quotes or
source text. When `run.json` itself is unreadable, the CLI warns on stderr
naming the configured artifact path (never contents or counts).

## Check results

Every check records `{ name, outcome, code, detail? }` with
`outcome: passed | failed | inconclusive | skipped` and a stable
machine-readable `code` from the closed set in `src/types/validation.ts`
(`VALIDATION_CHECK_CODES`). Details are truncated to 300 chars and carry
paths, line numbers, thresholds, and ids only — never source text, quotes,
or secrets.

Check families (`name`) and codes:

- Identity/provenance: `finding_identity_verified`,
  `finding_identity_invalid`, `finding_head_sha_match`,
  `finding_head_sha_mismatch`, `origin_unit_resolved`, `origin_unit_missing`,
  `origin_file_resolved`, `origin_file_mismatch`, `finding_path_resolved`,
  `finding_path_not_in_diff`, `finding_path_invalid`,
  `rename_path_mapping_invalid`, `finding_symbol_match`,
  `finding_symbol_mismatch`, `evidence_provenance_ok`,
  `evidence_path_not_allowed`.
- Location: `location_line_valid`, `finding_line_invalid`,
  `head_comment_target_ok`, `finding_line_not_commentable`,
  `no_commentable_target`, `target_relocated`, `deletion_anchor_missing`.
- Evidence/snapshot: `evidence_bounds_ok`, `evidence_range_invalid`,
  `evidence_quote_verified`, `evidence_quote_not_found`,
  `evidence_side_ambiguous`, `evidence_unavailable`, `snapshot_unavailable`,
  `snapshot_unsupported_object`, `snapshot_binary`, `snapshot_size_limit`.
- Attribution: `introduced_by_pr_verified`, `introduction_inconclusive`
  (`not_introduced_by_pr` is reserved for a future proven-absence verdict and
  is never emitted in v1).
- Policy: `category_enabled`, `category_disabled`, `rule_ok`,
  `rule_id_unknown`, `rule_path_mismatch`, `severity_ok`,
  `severity_below_threshold`, `confidence_ok`, `confidence_below_threshold`.
- Dedupe/cap: `dedupe_unique`, `duplicate_fingerprint`,
  `duplicate_secondary_key`, `max_findings_ok`, `max_findings_exceeded`,
  `check_skipped_prerequisite_failed`.

## Snapshots and evidence sides

- Head-side reads use `diff.headSha` only; deleted-line reads use
  `diff.mergeBase` only (the diff's old side). The working tree is never an
  evidence source. Paths are validated against diff/context provenance before
  any read, so untrusted model paths can never become Git lookups.
- Head/context evidence reads the current path at `headSha`; deleted evidence
  reads the old path at `mergeBase`. Renames change the path mapping, never
  the snapshot side. Fully-deleted files have no head-side target and are
  never accepted for inline publication.
- Quote comparison is `normalizeQuoteForFingerprint(redactSource(text, path))`
  on both sides — CRLF/CR→LF plus horizontal-whitespace collapse,
  case-sensitive. No fuzzy matching. Exact cited-range match first, then a
  bounded ±3-line neighborhood fallback (`EVIDENCE_SEARCH_RADIUS`) that
  redacts the window as one source string and searches the normalized quote
  as a literal substring (partial first/last lines and multiline spans
  included): cross-line secrets collapse exactly as on the exact path, so a
  raw fragment of a consumed secret is absent and mismatches. No occurrence
  is a mismatch, one distinct range verifies at its actual lines, and
  several distinct ranges are ambiguous (`evidence_side_ambiguous`, never
  accepted). Each item records a verified location (side, canonical path,
  actual matched lines) that attribution intersects — never the
  model-cited range.
- Bounds: at most 8 evidence items per finding
  (`EVIDENCE_MAX_ITEMS`), 2000 chars per quote
  (`EVIDENCE_MAX_QUOTE_CHARS`), 50 cited lines per item
  (`EVIDENCE_MAX_LINE_SPAN`). Oversized claims fail instead of being
  silently truncated.
- Size diagnostics keep their typed kind: `per-file-limit` names the
  per-file byte cap, `cumulative-limit` names the total run cap, both
  preserving byte counts/limits; untyped cap wording and transport
  output-limit propagate as failures, never size statuses
  (`snapshot_size_limit`, still `inconclusive`).

## Location targets

Accepted findings carry a code-owned head-side `derivedTarget`
(`side: "RIGHT"`, never a publish action by itself):

- `added`: the line is a diff `add` line. `context`: the line exists on the
  right side and is commentable but unchanged (commentability never proves
  introduction). `relocated`: same-symbol changed line within ±5
  (`LOCATION_RELOCATION_RADIUS`), shortest distance then lower line wins.
  `deletion-anchor`: the finding cites a removed line and anchors to the
  symbol's head-side `anchorLine`.

## Attribution

`introducedByPr` is code-derived; the model's boolean is ignored. Accepted
introduction needs a verified evidence location intersecting real PR lines:
head-side verified location in the primary file spanning an `add` line in
the originating symbol (`changedLines` basis), or old-side verified location
spanning a `del` line owned by the originating symbol (`deletedLines` basis)
plus a valid head-side anchor. Anything else is `introduction_inconclusive` —
never accepted. Replacement hunks keep the head/base distinction; identical
matches on both sides stay `evidence_side_ambiguous`.

## Policy

Existing config only, precedence `path_overrides` → `category_overrides` →
global thresholds (`severity_threshold`, `confidence_threshold`;
`critical > high > medium > low > info`). Ten `Category` values map onto the
four toggles per ADR 0028 (`bug`, `null-handling`, `error-handling`,
`breaking-change`, `resource-leak`, `api-usage` → `bugs`; `security` →
`security`; `performance` → `performance`; `concurrency` → `concurrency`;
`convention` always passes the category gate). A supplied `ruleId` must name
an existing rule whose paths cover the head-side target; unknown or
out-of-scope rule ids fail closed.

## Dedupe, cap, artifact

Same-run dedupe only (cross-run / already-posted lookup is Phase 7). Primary
key is the Phase 4 fingerprint (reused verbatim, never re-minted);
conservative secondary key is canonical path + symbol + category + normalized
title + overlapping target/evidence ranges. Winner order: effective severity,
confidence, path, line, fingerprint, finding id. `max_findings` applies to
accepted candidates only; surplus stays visible as
`max_findings_exceeded`. `run.json` (schema v2) carries `validated` plus the
`validationSummary` counts (`total/accepted/rejected/inconclusive/
duplicates/policyFiltered/checksSkipped`), null until validation runs.

## Modes

Live `--dry-run`: review → deterministic validation → publish skipped.
Live without `--dry-run`: validation runs, then the Phase 7 publisher stub
still fails `NOT_IMPLEMENTED` (no GitHub calls). `--no-llm`: review,
validation, and publish are skipped with explicit reasons (offline preview).
Demo uses its own canned engine and never touches git or the network.
