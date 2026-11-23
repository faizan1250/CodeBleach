# Validation (Phase 5, deterministic-only v1)

Model findings are verified against the PR diff and exact Git snapshots before
they can be accepted. The engine (`src/validate/`) makes no `LlmProvider`
calls; `ValidatedFinding.llmVerdict` stays absent. Decisions: ADR 0028
(decision matrix), ADR 0029 (result contract, artifact v2), ADR 0030 (P5-10
hardening), ADRs 0040–0042 (Phase 6 advisory/merge/handoff/API integration
contracts; as-built record in `implementation-phase6.md` §22, hardening in
ADR 0044). Plan: `implementation-phase5.md` + `implementation-phase6.md`
§§4–13 (normative; not duplicated here).

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
nothing published or counted) on a status-`accepted` item missing any part. The guard is
shape-only (ADR 0035, no semantic validation): it does not re-prove the
target/basis against the diff — cross-consistency is established by the
validator when the accepted item is built from the same in-memory diff.
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
  on both sides — CRLF/CR→LF plus all-whitespace-runs-to-single-space
  collapse (newlines included), case-sensitive. No fuzzy matching. Exact cited-range match first, then a
  bounded ±3-line neighborhood fallback (`EVIDENCE_SEARCH_RADIUS`) that
  redacts the window as one source string and searches the normalized quote
  as a literal substring (partial first/last lines and multiline spans
  included): cross-line secrets collapse exactly as on the exact path, so a
  raw fragment of a consumed secret is absent and mismatches. A
  per-snapshot PEM interval index (`buildPemIntervals` + `isSecretSpan`
  over cached lines, ADR 0038; supersedes the ADR 0037 probe design, which
  was never implemented — no `isSecretFragment`, no scan radius) then
  rejects any exact or fallback match whose span is a fragment of a PEM
  block: the index covers the whole snapshot (single combined delimiter
  scan in source order, no per-line sort), so PEM protection does not
  depend on the ±3 window; every BEGIN/END occurrence is scanned in source
  order (multiple per line included), sequential completes verify only on
  full coverage,
  and trailing-BEGIN, orphan-END, and unterminated-to-EOF shapes stay
  fail-closed. Other `TOKEN_PATTERNS` rely on the full-window redaction gate
  alone (ADR 0036 limitation, unchanged) — no universal-detection claim.
  Full-block quotes still verify; suspect matches fail
  closed as `evidence_quote_not_found`. No occurrence
  is a mismatch, one distinct range verifies at its actual lines, and
  several distinct ranges are ambiguous (`evidence_side_ambiguous`, never
  accepted; zero minima is defensive-ambiguous, unreachable since the whole
  window always explains a gated match). Each item records a verified location (side, canonical path,
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

## Cancellation

An optional caller `AbortSignal` threads `PipelineInput.signal` through
validation reads to the underlying Git subprocess (ADR 0034); aborted reads
resolve to `inconclusive` (never accepted). No CLI flag wires a signal, so
cancellation is programmatic-only in v1.

## Modes

Live `--dry-run`: review → deterministic validation → publish skipped.
Live without `--dry-run`: validation runs, then the Phase 7 publisher stub
still fails `NOT_IMPLEMENTED` (no GitHub calls). `--no-llm`: review,
validation, and publish are skipped with explicit reasons (offline preview).
Demo uses its own canned engine and never touches git or the network.

## Inferred conventions (Phase 6, implemented behind `--convention-advisory`, default off; eval gate not passed)

Inferred conventions are advisory review input only — never validation
evidence. Validation checks, codes, and statuses are unchanged by Phase 6
(see ADR 0039 and `implementation-phase6.md` §§4–13): advisory findings
arrive via a SEPARATE validation run under the isolated §10.2 policy
(internal advisory entry sharing the per-finding core, batch deferred —
plan §§10–12, ADRs 0042–0043 with the ADR 0043 entry shape:
`ConventionAdvisoryUnit[]` in, `PendingAdvisoryCandidate[]` out,
finalization only after all advisory filters; severity threshold pinned
to `low`, no inherited path thresholds,
confidence bar preserved, convention gate kept, no `ruleId`), merge in
their own domain with the named advisory cap at orchestration (plan §12
order 1–9, never a combined cap), and lose explicit conflicts under the
§11 verified-head-interval contract (same canonical path plus overlapping
verified head-side intervals only; no symbol, title, fingerprint, rename,
or base-to-head mapping; unmappable excluded; no
manufactured conflict; conflict metadata carries aggregate counts +
stable codes only, no per-finding records). Verified locations ride the run-scoped §4.2 handoff envelope
(`findingId`/`headLocations` with `[]` valid as no-overlap, discarded
after run; `ValidatedFinding` and `run.json` v2 unchanged — ADR 0041).
Conflict/advisory diagnostics are transient-only (orchestration return +
bounded logger aggregates; no `run.json` per-finding conflict records).
Advisory count-cap overflow is an orchestration merge diagnostic,
never a check code. Advisory publish withholding is likewise pipeline-level
and post-validation: without the separate explicit publish opt-in (default
off), accepted advisories are withheld from the publisher with a count-only
logger diagnostic; validation statuses, `run.json` v2 persistence, and the
transient-only diagnostics rule above are unchanged.
