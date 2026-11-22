# ADR 0042: Phase 6 advisory validation API contract (shared core + internal entry)

Date: 2026-11-23

Status: Accepted (planning-only; no `src/` changes in this ticket).
Preserves ADRs 0028–0041; rewrites none. Clarifies ADR 0041 — does not
invalidate its handoff envelope, execution order, or transient-only
diagnostics.

## Context

ADR 0041 Decision 2 allows two conforming advisory execution shapes
(preferred shared per-finding core + separate batch policies, or a
dedicated advisory entry reusing the exact per-finding checks). Both reuse
the five per-finding stages unchanged, so an implementer cannot pin the
§5.3 order 1–9, the M1–M8 matrix, or the C7/C10 divergence tests without a
locked shape: the entry point determines where the handoff envelope is
built, where batch policies run, and what orchestration owns. This ADR
locks exactly one shape. Normative detail lives in
`implementation-phase6.md` §§5.2–5.5 (shared-core §5.3.1, order §5.3,
conflict §§5.1/5.4, handoff §5.5); this ADR records the decision.

ADR 0041 Consequences says "no `run.json` growth beyond existing
per-domain counts" — defective wording: v2 has no per-domain counts
(single `validationSummary` aggregate, `src/core/run-artifact.ts:52,67-90`).
This ADR clarifies the phrase to mean the aggregate-only
`ValidationSummary` is unchanged; per-domain visibility is transient-only.
ADR 0041 itself is not rewritten.

## Decision

1. **Shared core + internal advisory entry (dedicated-entry alternative
   rejected).** The per-finding stages (provenance → location → evidence →
   attribution → policy, `src/validate/engine.ts:103-177`) stay one shared
   code path. Public `validate()` is that shared core plus the primary
   batch policies, unchanged in params/return/order/dedupe/cap/codes/
   semantics/output. The internal entry runs the same core and defers all
   batch work to orchestration:
   ```ts
   interface ValidatedFindingCandidate {
     finding: Finding;
     handoff?: ValidationHandoffEntry | undefined;
   }
   validateAdvisoryCandidates(
     findings: Finding[],
     diff: DiffResult,
     units: ReviewUnit[],
     config: ResolvedConfig,
     options?: ValidationOptions | undefined,
   ): Promise<{ validated: ValidatedFinding[]; handoff: ValidationHandoffEntry[] }>;
   ```
   Exact repo types only (`Finding`/`DiffResult`/`ReviewUnit` from
   `src/types`, `ResolvedConfig` from `src/config/schema.ts`,
   `ValidationOptions` from `src/core/contracts.ts:56-58`);
   `ValidationHandoffEntry` per §5.5 (verified actuals only, keyed by
   `findingId`). Internal only — no public contract widening.
2. **Orchestration owns the advisory domain.** Boundary gates, advisory
   policy projection (severity `low`, no path overrides, confidence kept,
   convention gate kept, effective severity always `finding.severity`),
   conflict suppression, advisory-internal A–E dedupe, the
   `MAX_ADVISORY_FINDINGS_PER_RUN` cap via domain-only `selectWithinCap`
   reuse (`src/validate/dedupe.ts:220-233`), and `AdvisoryExecutionResult`
   assembly. Ownership/DI boundary per `src/core/contracts.ts`
   (`PipelineDeps.validation`, only `core/pipeline` + `cli` wire engines)
   and `src/core/pipeline.ts:186-204` (single validate call today).
3. **Order 1–9, no combined cap, transient-only diagnostics** per ADR 0041
   and §§5.3–5.5: primary validate → dedupe → cap; advisory gate →
   validate → conflict-suppress → dedupe → cap → append; aggregate
   `validationSummary` unchanged; conflict/advisory diagnostics are
   transient counts + stable codes (orchestration return + bounded logger
   aggregates via `src/core/logger.ts`), never per-finding `run.json`
   records.

## Consequences

- P6-00 locks the entry name/types/ownership/lifecycle; P6-04 implements
  it; P6-05 pins the two-run separation, A–E vs primary-secondary
  divergence (C7/C10), envelope verified-actuals-only, and the combined-cap
  prohibition with the §6 matrix.
- Phase 6 stays planning-only; `ValidatedFinding`, `run.json` v2
  (schema version 2, single aggregate summary), check codes, config
  schema, and the public `validate()` contract are unchanged.
- Per-domain counts remain transient (envelope + execution result +
  logger); nothing persists per-domain or per-finding to `run.json`.

## Supersession

Clarifies ADR 0041 Decision 2 (locks the API choice) and its
Consequences wording (aggregate-only, not per-domain). Does NOT
invalidate ADR 0041: the handoff envelope, order 1–9, and
transient-only diagnostics decisions stand.

## Acceptance gate

- Entry name + exact types + internal ownership + transient lifecycle
  locked in P6-00; implemented in P6-04; pinned with order/M1–M8/C7/C10/
  envelope/combined-cap-prohibition tests in P6-04/P6-05/§6.
