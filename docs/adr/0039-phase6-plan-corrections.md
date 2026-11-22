# ADR 0039: Phase 6 plan corrections (authority, denominators, evidence, cache)

Date: 2026-11-22

Status: Accepted (planning-only; no `src/` changes in this ticket).
Preserves ADRs 0028–0038; rewrites none. ADR 0037 stays superseded-by-0038,
not revived.

## Context

1. Phase 5 validation is the ADR 0038 occurrence-ordered PEM interval index
   (`buildPemIntervals` + `isSecretSpan`, per-snapshot, fail-closed). No
   `isSecretFragment` / `SECRET_DELIMITER_SCAN_RADIUS` was ever implemented.
2. The Phase 6 plan (`implementation-phase6.md`) enforced its never-rules by
   prompt text alone: with no `ruleId` cited, policy computes
   `effectiveSeverity = finding.severity` (`src/validate/policy.ts:141`), so
   an inferred-context-only `high`/`critical` passes `severity_ok` whenever it
   clears the threshold. Prompt contract + eval is guidance, not a backstop.
3. The plan's `supportRatio = matching / sampled` used one global denominator
   for detectors with different eligible sets (error-handling only judges
   files with error surfaces; test-layout judges pairings), mis-ranking narrow
   detectors and hiding the audit trail. Zero-eligible behavior was
   unspecified per detector.
4. `evidenceFiles: string[]` proved no pattern: no lines, no snapshot
   identity, and an invitation to leak excerpts into prompts.
5. The cache key missed the sampling policy: identical OIDs/detector/schema
   with changed selection/eligibility rules produced a stale hit. Failure
   language conflated safe-empty with diagnostic-tagged empty.

## Decision

1. **Two passes, app-enforced authority.** Primary review pass: existing
   context + explicit rules only, ordinary categories, zero inferred input.
   Convention-advisory pass: bounded context + inferred conventions, labeled
   advisory. Separate prompts/calls; `origin.pass` stamped by trusted
   orchestration, never model-supplied. Deterministic merge appends advisory
   findings and never alters, drops, or re-ranks primary ones; explicit wins
   on conflict. Advisory output MUST be `convention`-category and severity ≤
   `low` — violations are rejected at the orchestration merge boundary before
   validation. Inferred `inf-*` ids are never valid `ruleId`
   (existing `rule_id_unknown` path; closed check-code set untouched).
   Prompt authority text is guidance (tested verbatim); the caps, provenance
   stamping, and merge order are invariants (tested against a disobedient
   model). Ten acceptance cases (§5 of the plan) pin: primary inference-free,
   advisory bounded, category/severity caps, boundary rejection, code-stamped
   provenance, inferred-id rejection, explicit priority, primary unaltered,
   Phase 5 validation/publisher unchanged.
2. **Denominators.** Per convention: `sampledFiles` (global total, audit
   only), `eligibleFiles` (detector-eligible in the sampled set —
   THE denominator), `matchingFiles` (exhibiting, full count even when
   truncated). `supportRatio = matching / eligible`. Zero eligible ⇒ no
   convention (empty + diagnostic, never divide by zero). Each detector
   declares a pure eligibility predicate (export / error-surface / layout /
   wrapper policies locked in P6-00). Threshold tests cover below/at/above
   `MIN_SUPPORT_RATIO` × evidence-count floor × cap-order-stability ×
   zero-eligible, per detector family.
3. **Evidence.** `ConventionEvidence{file, startLine, endLine}` (1-based head
   snapshot, deterministic file-then-line order, capped at
   `MAX_EVIDENCE_PER_CONVENTION`); `evidenceFiles` is a derived path view;
   `matchingFiles` always records the full count. No raw excerpts in the
   type, the cache, or the prompt — pattern text + `file:start-end` only.
   Tests cover type/bounds/ordering/serialization.
4. **Cache.** Key keeps blob OIDs/paths + detector name/version + schema and
   ADDS `sampling:${SAMPLING_POLICY_VERSION}` (selection order, eligibility
   rules, language scoping, `MAX_SAMPLED_FILES`, population rules); any drift
   invalidates. `.reviewer-cache/inferred.json` stays a cache (content-keyed,
   invalidated on drift, never a learning store). Failures never fail the
   review: corrupt/missing/key-mismatch ⇒ rebuild; unreadable-not-own-fault
   ⇒ empty + diagnostic; write-error ⇒ diagnostic, run continues;
   over-budget ⇒ empty conventions + diagnostic.
5. **Scope pins.** Phase 6 is planning-only (no `src/conventions/` runtime).
   Phase 7 publishing/integration and Phase 8 evaluation are out and
   unchanged. Historical ADRs preserved.

## Consequences

- Implementation tickets P6-00…P6-05 carry the corrected contracts; the §5
  ten-case list is the authority gate for review.
- Acceptance only shrinks for validation (unchanged Phase 5 semantics); the
  advisory pass can only add capped `convention`/`low` findings or nothing.
- Cache invalidation surface grows by one versioned input (sampling policy);
  stale-hit class closed by key-stability/drift tests.
