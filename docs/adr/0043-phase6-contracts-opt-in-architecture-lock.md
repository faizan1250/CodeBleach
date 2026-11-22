# ADR 0043: Phase 6 contracts, opt-in, and architecture lock (P6-00)

Date: 2026-11-22

Status: Accepted (contracts-only; no detector, prompt, or merge runtime).

Preserves ADRs 0028–0042; rewrites none. Supersedes two planning details
where the normative plan and an earlier ADR disagree (recorded below with
rationale); the superseded ADRs otherwise stand.

## Context

`implementation-phase6.md` declares itself the single normative Phase 6
sequence. Two of its sections conflict with earlier planning text, and one
open question from the P6-00 audit needs a locked answer before runtime
work starts:

1. Advisory validation entry shape. ADR 0042 D1 locks
   `validateAdvisoryCandidates(findings, diff, units: ReviewUnit[]) ->
   {validated: ValidatedFinding[], handoff}`. The normative plan section 4.2
   locks `validateAdvisoryCandidates(findings, diff, units:
   ConventionAdvisoryUnit[]) -> PendingAdvisoryCandidate[]` plus
   `finalizeAdvisoryCandidates`. Both cannot hold: the ADR shape
   materializes `ValidatedFinding` before orchestration-side conflict
   suppression, advisory dedupe, and advisory cap, which breaks the section
   12 order 1–9 and defeats the compile-time non-assignability invariant
   (plan 4.2/10.1/16.3). It also takes full `ReviewUnit[]`, which carries
   explicit rules and full context into the advisory boundary that section
   9.2 forbids.
2. Cache. ADR 0039 D4 specifies a persistent convention cache keyed on blob
   OIDs, detector, schema, and sampling policy. Normative plan section 8
   explicitly defers the persistent cache: no directory, file, key, parser,
   or write in the first cut.
3. Token counter. Plan 9.3/9.5 requires P6-00 to confirm whether the
   configured provider exposes a tokenizer or to select the documented
   conservative upper-bound counter.

## Decision

1. **Plan section 4.2 wins for the advisory entry.** The internal Phase 6
   engine interface in `src/core/contracts.ts` takes
   `ConventionAdvisoryUnit[]` and returns `PendingAdvisoryCandidate[]`;
   `finalizeAdvisoryCandidates` is the sole constructor of advisory
   `ValidatedFinding` values, callable only after conflict suppression,
   advisory dedupe, and advisory cap. ADR 0042 D1's `ReviewUnit[]` input
   and `{validated, handoff}` output are superseded for this entry only.
   ADR 0042's shared-core ownership, order 1–9, and transient-diagnostics
   decisions stand unchanged.
2. **No persistent cache (plan section 8 wins).** There is no
   `.reviewer-cache/` directory, cache file, cache key, cache parser, or
   cache write. Every enabled run performs the deterministic bounded scan
   in memory and discards sampled blobs, detector intermediates, and
   convention evidence after orchestration. ADR 0039 D4's cache contract is
   superseded; its authority/denominator/evidence decisions stand.
3. **Conservative UTF-8-byte upper-bound counter.** The configured
   provider (`OpenCodeProvider`) exposes no tokenizer or token-count
   facility, so advisory budgets are measured with `estimateTokens`
   (ceil of UTF-8 bytes times 23/80) via `src/conventions/token-budget.ts`.
   Mode is pinned as `ADVISORY_TOKEN_COUNTER_MODE =
   "utf8-byte-upper-bound"` and recorded by the P6-00 golden tests.
4. **Opt-in DI seam.** `PipelineDeps.phase6` is optional and constructed
   only when `--convention-advisory` is set; `PipelineOptions.
   conventionAdvisoryEnabled` (default false) is the only enablement
   control. Enabled without the bundle is a preflight `CONFIG_INVALID`
   composition error, never a silent downgrade. Demo and `--no-llm`
   bypass Phase 6 regardless of the flag. The single shared provider
   concurrency limiter and the `CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING` gate
   apply to every advisory call; the flag is not training consent.
   Full orchestration lands in P6-05; in P6-00 an enabled run with a
   bundle fails closed (`NOT_IMPLEMENTED`).
5. **Bounds locked.** Sampling, support, projection, budget, concurrency,
   and advisory-cap constants in `src/conventions/constants.ts` equal the
   plan sections 5.3/7/9.3 values exactly. Any change is a contract change.

## Consequences

- P6-01…P6-05 build against `ConventionAdvisoryUnit`,
  `PendingAdvisoryCandidate`, and the frozen bounds; no ticket re-litigates
  the entry shape or the cache deferral.
- `ValidatedFinding`, check codes, config schema, artifact v2, and the
  public `ValidationEngine.validate()` contract are unchanged.
- Flag-off runs perform no convention scan, storage access, or provider
  work and produce byte-identical primary output (proven by P6-00 tests).

## Acceptance gate

- P6-00 pins flag help text, DI types, handoff semantics (empty
  `headLocations` valid), provider retry/training gates, all bounds, the
  token-counter mode with goldens, and the `@ts-expect-error`
  non-assignability test. No runtime detector, prompt, or merge behavior.
