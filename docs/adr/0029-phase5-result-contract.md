# ADR 0029: Phase 5 result contract — CheckResult evolution, derived target, duplicate link, artifact v2

Date: 2026-11-22

Status: Accepted (P5-08; fulfills the ADR 0028 "stable check `name`+`code` set: defined by P5-08" item).

## Context

`src/types/validation.ts` still carried the pre-Phase-5 `{ name, passed, detail? }` shape, which cannot
distinguish hard failure, undecided snapshots, and checks skipped after a recorded prerequisite failure
(plan `implementation-phase5.md` §3.2). P5-07 wired dedupe with interim check names and a write-only
`duplicateOfId`; P5-08 owns the stable code set and the engine-to-artifact boundary.

## Decision

1. `CheckResult` is now `{ name, outcome, code, detail? }` with
   `outcome: "passed" | "failed" | "inconclusive" | "skipped"`. The old `passed` boolean is removed
   (no contradictory `passed: true` + `outcome: failed` combination can exist). `name` is the stable
   check family (19 families: 7 provenance, 2 location, 2 evidence, 1 attribution, 4 policy, 3
   dedupe/cap); `code` is the machine-readable reason from the closed 51-code set in
   `src/types/validation.ts` (`VALIDATION_CHECK_CODES`, pinned by test).
2. Codes are the plan's suggested set verbatim plus minimal pass codes per family
   (`finding_head_sha_match`, `evidence_quote_verified`, `dedupe_unique`, `max_findings_ok`, …).
   `not_introduced_by_pr` is reserved for a future proven-absence verdict and is defined but not
   emitted: attribution stays fail-closed (`introduction_inconclusive`), never accepted without proof.
3. Within-module prerequisites that cannot run after a recorded failure emit `outcome: skipped` with
   `code: check_skipped_prerequisite_failed` (previously `passed: false` with the same detail text).
   Cross-stage gating is unchanged (absent checks, never fabricated passes): dedupe losers carry only
   their failing dedupe check, cap losers carry the failing cap check, and the 19/17 check-count
   arithmetic is asserted in tests.
4. `ValidatedFinding` gains `derivedTarget?: ValidationTarget` (P5-03 head-side anchor; required on
   accepted, diagnostic otherwise) and `duplicateOfId?: string` (retained finding id for duplicate
   rejections; the detail string keeps the human-readable link). `Finding` stays immutable,
   `llmVerdict` stays absent in v1 (ADR 0028 D1/D4).
5. `run.json` schema bumps 1 → 2 with an additive `validationSummary: ValidationSummary | null`
   (`total/accepted/rejected/inconclusive/duplicates/policyFiltered/checksSkipped`, computed in
   `src/core/run-artifact.ts`). Null until the validation stage runs.
6. Every check detail passes through `makeCheck` (`src/validate/checks.ts`), which truncates to
   `MAX_CHECK_DETAIL_CHARS = 300`. Details carry paths, line numbers, thresholds, and ids only —
   never source text, evidence quotes, secrets, or large error payloads.
7. Dedupe hardening inside the P5-08 boundary: secondary key fields join with `\0` (no
   cross-boundary collisions) and evidence paths canonicalize before overlap comparison (safe
   direction only: false separation, never false merging).

## Consequences

- `systemdesign.md` §4.4 + §5 validation sketch synced to the new shape; artifact v2 documented here.
- All validator unit suites, demo, fixture stubs, and the `schemaVersion` assertions moved to the new
   shape in the same change (no silent old-shape writes under the old version).
- No semantic change: stage order, fingerprint reuse (never re-minted), fail-closed attribution,
   `max_findings`-on-accepted-only, deterministic input-aligned ordering, and the deterministic-only /
   exact-SHA / no-LLM / no-GitHub boundaries are untouched. Phase 6/7/8 not started.
