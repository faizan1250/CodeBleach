# ADR 0028: Phase 5 deterministic validation — decision matrix

Date: 2026-11-21

Status: Accepted (P5-00; blocks P5-01 through P5-10).

## Context

Verified baseline is `e435201` (PR #51, contains prereq Commits A+B).
No `src/validate/` exists; `stubValidationEngine` (`src/core/stubs.ts:24-26`)
throws `NOT_IMPLEMENTED`, tolerated only for live `--dry-run`
(`src/core/pipeline.ts:186-206`, ADR 0021). Contracts inspected:
`src/core/contracts.ts:35-42`, `src/core/pipeline.ts:179-226`,
`src/types/validation.ts`, `src/types/finding.ts`, `src/types/diff.ts`,
`src/types/context.ts`, `src/config/schema.ts:65-126,271`,
`src/review/normalize.ts:34-65,112-117`, `src/utils/redact.ts:325-326`,
`src/cli/commands/review.ts:91-155`, `src/core/run-artifact.ts:49`.

## Decision (fixed for Phase 5 v1; do not reopen)

1. Deterministic only: no `LlmProvider` calls, no second model, no
   embeddings/fuzzy matching. `ValidatedFinding.llmVerdict` stays absent.
2. Exact snapshots are authoritative: head-side reads pinned to
   `diff.headSha`, deleted-line reads to `diff.mergeBase`. Working tree is
   never an evidence source. Reads go through an injected repo-bound
   `SnapshotReader` (constructor/factory injection preferred; smallest
   explicit contract change only if wiring demands it — P5-01 decides;
   never an implicit path or global), and only for provenance-approved paths.
3. Commentability is not introduction: `commentableLines` never proves a line
   was added; model `introducedByPr` never decides acceptance. P5-05 computes
   a code-owned result from added/deleted-line intersection only.
4. Evidence quotes compare via `redactSource(snapshotSlice, path)`
   (`src/utils/redact.ts:325-326`) — no second redaction policy in the
   validator. Comparison is case-sensitive; the only normalization is
   CRLF/CR→LF plus horizontal-whitespace collapse
   (`normalizeQuoteForFingerprint`, `src/review/normalize.ts:34-36`).
5. Ownership: P5-04 owns validity (empty anchor `""` never passes;
   unverifiable evidence → reject/inconclusive). P5-07 owns fingerprint use
   (reuse the Phase 4 value via `fingerprintForFinding`, never re-mint;
   same-run dedupe only). Fingerprint is identity, never validity proof;
   pre-Commit-B title-based `run.json` fingerprints are not comparable.
6. P5-01 scope: typed snapshot outcomes (missing/blob/mode/binary/
   size-limit/batch-failure/SHA-mismatch/abort/timeout) plus binary-content
   policy; cancellation/deadline propagation keeps abort-vs-missing-vs-reject
   distinct.
7. Policy is decided here and implemented in P5-06 on existing config fields
   only — no new names. Artifact/`CheckResult` evolution stays in P5-08.
8. P5-09 removes the `NOT_IMPLEMENTED` dry-run tolerance; `--no-llm` keeps
   skipping validation with zero provider reads. Demo findings are routed
   only after P5-09 inspects the demo contract.

## Policy matrix (authoritative input per question)

| Question | Authoritative input |
|---|---|
| File in this PR? | `DiffResult.files` |
| Head-side line exists? | Exact `headSha` snapshot + diff line metadata |
| Line commentable? | Full `ChangedFile.commentableLines` / right-side hunk lines |
| Line added? | `DiffLine.kind === "add"` + `newLine`; `ChangedSymbol.changedLines` |
| Code removed? | `DiffLine.kind === "del"` + `oldLine`; `ChangedSymbol.deletedLines` |
| Deleted text real? | Exact `mergeBase` snapshot + old path/line mapping |
| Evidence genuine? | Exact snapshot text via allowed path/SHA/side/range |
| Introduced by PR? | Code-derived evidence/target/symbol link to added/deleted lines |
| Duplicate? | Phase 4 fingerprint, then conservative same-run key |
| Already posted to GitHub? | Not Phase 5 (Phase 7) |

Target kinds: `added | context | relocated | deletion-anchor`, always
`side: "RIGHT"`. Relocation only within the same symbol to a `changedLines`
line inside the radius below; deletion anchors use `anchorLine`; fully-deleted
files get no head-side target.

## Category to toggle mapping

Config has four toggles (`bugs`, `security`, `performance`, `concurrency`).
Exhaustive mapping for the ten `Category` values:

- `bugs` toggle: `bug`, `null-handling`, `error-handling`,
  `breaking-change`, `resource-leak`, `api-usage`.
- `security` toggle: `security`. `performance` toggle: `performance`.
  `concurrency` toggle: `concurrency`.
- `convention`: no toggle exists; always passes the category gate (severity,
  confidence, and rule policy still apply).

Precedence: `path_overrides` → `category_overrides` → global thresholds.
Severity order `critical > high > medium > low > info`. Unknown or
out-of-scope `ruleId` fails (fail-closed; Phase 4 already drops unknown
`ruleId` at `src/review/normalize.ts:81-83`).

## Constants (defaults locked here; owning ticket proves boundaries)

- Nearest-relocation radius: 5 lines; tie-break shortest distance, then lower
  line number (P5-03).
- Evidence search radius, per-finding item cap, quote-byte cap, cited-span
  cap, per-file/per-run snapshot-byte caps: named constants defined and
  tested by P5-04.
- Stable check `name`+`code` set: defined by P5-08.

## Consequences

- `systemdesign.md:128,255` synced to the evidence-anchored fingerprint
  formula in this ticket (was stale after Commit B).
- No validator code in P5-00. The locked test matrix is plan
  `implementation-phase5.md` §§P5-01–P5-09 test lists; no implementation
  begins until P5-01.
- Limitation on record: deterministic provenance/evidence validation is not
  proof of semantic correctness.
