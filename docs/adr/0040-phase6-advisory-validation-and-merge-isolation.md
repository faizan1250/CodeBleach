# ADR 0040: Phase 6 advisory validation and merge isolation (planning contract)

Date: 2026-11-22

Status: Accepted (planning-only; no `src/` changes in this ticket).
Preserves ADRs 0028–0039; rewrites none. Refines the planning detail of
ADR 0039 §Decision item 1 (two-pass merge) where noted below; ADR 0039
itself is untouched.

## Context

1. ADR 0039 fixed two passes (primary explicit-rules pass +
   convention-advisory pass) with orchestration-stamped `origin.pass`,
   a `convention`-category / severity-≤-`low` boundary gate, `ruleId`
   rejection, and a deterministic merge that never alters primary
   findings. It left three load-bearing gaps, each verified in tree and
   since pinned in the Phase 6 plan (`implementation-phase6.md` §§5.2–5.4;
   substance already synced to `systemdesign.md` + `docs/validation.md`):
2. **Default-threshold incompatibility.** `DEFAULT_SEVERITY_THRESHOLD =
   "medium"` (`src/config/defaults.ts:12`, schema default
   `src/config/schema.ts:80`) with rank `low = 1 < medium = 2`
   (`src/validate/policy.ts:42-48`). The `convention` category gate
   passes unconditionally (`:126-129`), but the severity gate has no
   category exemption: with no `groupOverride` for `convention`, the
   threshold resolves to the global `medium` (`:177-179`) and a
   `convention`/`low` finding is rejected (`severity_below_threshold`,
   `:180-186`). With no `ruleId` cited, `effectiveSeverity =
   finding.severity` (`:141`), so the advisory contract (NO `ruleId` on
   advisory output) leaves no rule-severity rescue. Routing advisories
   through unmodified `validatePolicy` under default config rejects
   every advisory `low`.
3. **Shared merge machinery.** `ValidationEngineImpl.validate` runs
   per-finding stages into ONE `pending` array
   (`src/validate/engine.ts:102-177`), then `resolveDuplicates` (`:182`)
   and `selectWithinCap` with `config.review.max_findings` (`:201-204`).
   Dedupe is scoped to validated candidates
   (`src/validate/dedupe.ts:118-124`), cap to post-dedupe winners with
   Phase 5 winner order (`:214-221`). The engine takes ONE `findings[]`
   set (`src/validate/engine.ts:85-91`): advisory items merged into that
   array before `validate()` share the pending set, the dedupe, and the
   ranked cap — advisory `low`s lose the cap race by severity order AND
   the cap is computed over the mixed set.
4. **Cross-side conflict coordinates.** Per-finding identity pieces exist
   (`canonicalPath`, fallback symbol, head-side `location.target`
   `:169-175`; P5-07 keys on path + symbol + overlap, `rangesOverlap`
   `src/validate/dedupe.ts:108-116` over `candidateSpans` `:97-103`).
   But base-side verified evidence spans use BASE line numbers while
   `derivedTarget` uses HEAD numbers — direct intersection across sides
   is meaningless — and fallback verification records ACTUAL matched
   lines that can diverge from model-cited ranges.

## Decision (planning contract; P6-00…P6-05 carry it)

1. **Isolated advisory policy (plan §5.2).** Advisory findings NEVER
   enter the primary `validate()` array. Orchestration makes TWO
   `validate()` calls on disjoint inputs with the same engine code:
   primary findings with full user config; boundary-surviving advisories
   under an isolated advisory policy pinned in orchestration/test code
   (NOT user config, NOT a validator flag, NOT a schema change):
   severity threshold fixed to `low` (named constant locked in P6-00);
   NO inherited path/category severity overrides (advisory scope is
   global, never path-tuned); confidence threshold PRESERVED
   (path → global, same as primary); convention category gate KEPT;
   effective severity ALWAYS `finding.severity` (no `ruleId` exists to
   override it). Forbidden: fake explicit rules, mutating the global
   default/schema, a `convention` slot in `category_overrides`, lowering
   user thresholds. `info` is below the advisory threshold and
   ineligible — dropped at the boundary, never validated, never merged.
   Refines ADR 0039 item 1: the "merge" is two separate `validate()`
   calls, not one call over a merged array.
2. **Separate validation/dedupe/cap domains (plan §5.3).** No shared set,
   no shared dedupe, no shared cap. Primary domain: primary findings →
   `validate()` (user config) → primary-only `resolveDuplicates` →
   `selectWithinCap(config.review.max_findings)`. Advisory domain:
   boundary survivors → separate `validate()` (§5.2 policy) →
   conflict suppression vs RETAINED primaries (item 4) →
   advisory-internal `resolveDuplicates` → advisory-internal
   `selectWithinCap` with the item-3 cap. Normative order 1–9; a
   combined `selectWithinCap` over concatenated primaries+advisories is
   FORBIDDEN.
3. **Advisory cap (plan §5.3).** `MAX_ADVISORY_FINDINGS_PER_RUN`
   (suggestion 5 — P6-00 justifies and freezes) caps OUTPUT findings
   merged per run (comment-noise guard). It is independent of
   `MAX_CONVENTIONS_PER_RUN` (P6-00, e.g. 20), which caps INPUT patterns
   admitted to the advisory prompt (prompt-bloat guard): one convention
   can yield several findings, so the pattern cap alone cannot bound
   merged output. Named tested constant; NO user config knob (YAGNI —
   added only if Phase 8 evaluation proves a need). Count-cap overflow
   is a bounded orchestration merge diagnostic (counts only), NEVER a
   new `VALIDATION_CHECK_CODE`.
4. **Canonical head-coordinate conflict identity (plan §§5.1/5.4).**
   Conflict iff equal head-canonical path AND equal fallback-resolved
   symbol AND shared-head-line overlap. Category and title IGNORED
   (advisory is always `convention`; titles are model prose).
   Suppression is total (advisory dropped wholly, primary untouched: no
   annotation, no re-rank, no text merge).
5. **Base-to-head mapping, unchanged-context only (plan §5.4 rule D).**
   Overlap set per finding is `{derivedTarget line} ∪ {head-mapped
   VERIFIED evidence spans}`: head-side actuals as-is; base-side lines
   ONLY via exact one-to-one diff correspondence (identical content in
   unchanged hunk context). No offset inference, no deleted→head
   mapping, no renamed-path arithmetic beyond path canonicalization.
   Replacement-overlap items follow their verified side; both-sides-
   identical items never reach conflict (already
   `evidence_side_ambiguous`). Cited-only/unverified ranges contribute
   NOTHING.
6. **Unmappable fail-safe (plan §5.4 rule D/E).** Base-side evidence with
   no exact head correspondent (deleted lines, non-corresponding base
   lines) and symbol-less findings with no resolvable unit symbol are
   UNMAPPABLE: excluded from comparison, recorded as excluded-by-rule
   (count). Exclusion never manufactures a conflict — the advisory
   survives the conflict step on that ground (still subject to every
   other gate). False separation is the safe direction throughout.
7. **Byte-identical primary invariant.** The primary validated/deduped/
   capped set with advisories present is byte-identical to the set with
   advisories absent (extends ADR 0039 §5 cases 1–2 from prompt bytes to
   validated output). Advisory count never evicts a primary; reversed
   merge input order yields identical output (fixed
   primaries-then-advisories append).
8. **Phase 5 compatibility boundary.** Validation engine, policy
   function, check codes (closed set), config schema, `ValidatedFinding`,
   and `run.json` artifact shape are UNCHANGED. Verified locations
   (side/path/actual lines) ride the orchestration-internal conflict
   candidate, never the artifact. Conflict diagnostics persist ids,
   canonical paths, symbol names, head line intervals, and counts ONLY —
   no quotes, excerpts, secrets, or snapshot text.
9. **Acceptance gate.** Before P6 tickets complete: ADR 0039 §5 ten-case
   list (authority gate) + plan §5.3 matrix M1–M8 (merge domains) + plan
   §5.4 matrix C1–C12 (conflict contract), each a test in P6-04/P6-05
   per §6. P6-00 locks the §5.2 constant name/value and the advisory
   cap; P6-05 pins the two-call separation (advisory `low` fed through
   the primary call MUST still fail `severity_below_threshold` under
   default config) and the combined-cap prohibition.

## Consequences

- Phase 6 stays planning-only (no `src/conventions/` runtime); Phase 7
  publishing/integration and Phase 8 evaluation are out and unchanged.
- Acceptance only shrinks for validation (unchanged Phase 5 semantics);
  the advisory pass can only add capped `convention`/`low` findings or
  nothing (items 1–3, 7).
- Conflict metadata in `run.json` grows by bounded diagnostics
  (ids/paths/symbol/lines/counts); no new fields carrying source text
  (item 8).
