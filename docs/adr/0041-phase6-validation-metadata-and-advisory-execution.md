# ADR 0041: Phase 6 validation metadata and advisory execution (integration contract)

Date: 2026-11-22

Status: Accepted (planning-only; no `src/` changes in this ticket).
Preserves ADRs 0028–0040; rewrites none. Resolves the three integration
blockers in the `cb-p6integration-01` audit (evidence locations dropped,
shared merge machinery, artifact transient-vs-persisted tension) by locking
the handoff envelope, the advisory execution entry point, and transient-only
conflict diagnostics. Normative detail lives in
`implementation-phase6.md` §§5.3–5.5; this ADR records the decisions.

## Context (root causes, verified in tree)

1. **Blocker A — locations used for attribution then discarded.**
   `validateEvidence` returns `{ok, checks, locations: resolved}`
   (`src/validate/evidence.ts:407`; `VerifiedEvidenceLocation{side, path,
   startLine, endLine}` `:81-89`, actual matched lines never cited ranges
   `:87,:547-549`) and `ValidationEngineImpl.validate` passes
   `evidence.locations` once into `validateAttribution`
   (`src/validate/engine.ts:146`), which derives `basis`
   (`src/validate/attribution.ts:62-142`) and returns only
   `{ok, checks, introducedByPr, basis}` (`:13-28`); the engine keeps
   `basis` (`:176`) and drops `locations`. `ValidatedFinding`
   (`src/types/validation.ts:146-167`) has no locations field, and the
   pipeline (`src/core/pipeline.ts:186-204`) stores `ValidatedFinding[]`
   verbatim with no second access path. Any §5.4 conflict step needing
   head-mapped verified actuals is unreachable post-`validate()`.
2. **Blocker B — per-finding → dedupe → cap order; advisory must not share
   domains.** The engine runs per-finding stages into ONE `pending` array
   (`src/validate/engine.ts:102-177`), then `resolveDuplicates` (`:182`)
   and `selectWithinCap` with `config.review.max_findings` (`:201-204`).
   Dedupe keys on the Phase 4 fingerprint verbatim (`:131-161`) plus the
   secondary canonical-path/symbol/category/title/overlap (`:163-180`)
   over `candidateSpans` (target ∪ cited ranges, `:97-116`) — advisory
   must IGNORE category/title (always `convention`; titles are model prose)
   and cited/unverified ranges (§5.4 rule D). Merging advisory items into
   that array before `validate()` shares the pending set, the dedupe, and
   the ranked cap, breaking primary byte-identity (I1).
3. **Blocker C — artifact has no merge field; `reviewDiagnostics` reuse
   mislabels.** `RunArtifact` v2 (`src/core/run-artifact.ts:25-55`,
   `RUN_ARTIFACT_SCHEMA_VERSION = 2`) has no merge/conflict field, and
   `ReviewDiagnostic` (`src/types/review.ts:30-…`) is
   `{stage: provider|prompt|parse|normalize|unit, …}` — reusing it for
   merge/conflict records mislabels stage/code. ADR 0040 item 8 says the
   artifact is "UNCHANGED" yet its Consequences allow bounded conflict
   metadata growth; plan §5.4 refines to "existing v2 shape —
   counts/diagnostics fields, no new fields". This ADR resolves the
   tension as transient-only (no versioned alternative in this ticket).

## Decision

1. **Handoff envelope (plan §5.5).** Run-scoped internal
   `{findingId, canonicalPath, symbol, verifiedLocations}` (verified
   actuals only: side/path/actual start-end; never cited ranges, quotes,
   or secrets) plus the execution result `{findings, conflictMetadata}`.
   Built when evidence returns locations, keyed by stable `Finding.id`
   (never array index); canonical path (P5-02) + fallback symbol
   (`finding.symbol ?? unit name`) resolved pre-validate so the §5.4 A–E
   resolver receives envelope entry + `ValidatedFinding`
   (`derivedTarget`) jointly; discarded after run (function-local, no
   module-global, no file, no cross-run state).
2. **Advisory execution entry point (plan §5.3.1).** Two conforming
   shapes: PREFERRED shared per-finding core (provenance → location →
   evidence → attribution → policy, same code path) + separate batch
   policies per domain; OR dedicated advisory entry reusing the exact
   per-finding checks and deferring batch dedupe/cap. Both reuse the
   five per-finding stages unchanged; primary `validate()` behavior +
   order exact; advisory run independent, bounded, deterministic; no
   Phase 5 comparator change.
3. **Order 1–9 locked (plan §5.3).** Primary validate → dedupe → cap;
   advisory gate → validate → conflict-suppress → dedupe → cap → append
   → aggregate. No combined cap over concatenated sets (FORBIDDEN).
   Advisory dedupe is the §5.1/§5.4 A–E verified head-coordinate
   identity, never the primary secondary.
4. **Diagnostics lifetime: transient-only.** Conflict outcome is an
   orchestration return (`AdvisoryExecutionResult`) plus bounded logger
   aggregates through the actual `src/core/logger.ts` interface (counts +
   stable codes; no quotes/excerpts/secrets/snapshot text). Artifact,
   schema, finding, and summary shapes unchanged; `run.json` v2 unchanged;
   no per-finding conflict records. A versioned alternative (new artifact
   field/version bump) is a separate future decision, never silent.
5. **Unchanged contracts.** Validation engine, policy function, closed
   `VALIDATION_CHECK_CODES` set, config schema, `ValidatedFinding`,
   `run.json` v2, `src/types` purity (no engine imports), snapshot
   pinning (head=`headSha`/base=`mergeBase`), reader lifecycle
   (`finally { reader.clear(); }`), primary stage order, publisher/Phase 7
   (still stub), no new deps. Guards: no `src/conventions/` runtime, no
   detectors/cache/prompts/orchestration runtime, no Phase 5 semantic
   change.

## Consequences

- Phase 6 stays planning-only; implementation tickets P6-00…P6-05 carry
  §§5.3–5.5 with the §6 matrix (10 authority cases + M1–M8 + C1–C12 +
  envelope association/disposal).
- Acceptance only shrinks for validation; advisory can only add capped
  `convention`/`low` findings or nothing.
- No `run.json` growth beyond existing per-domain counts; conflict detail
  never persists per-finding.

## Acceptance gate

- P6-00 locks the §5.5 envelope + §5.2/§5.3 constants; P6-04 implements
  one §5.3.1 shape and pins order 1–9 + M1–M8; P6-05 pins the two-call
  separation (advisory `low` through the primary call still fails
  `severity_below_threshold`), advisory A–E dedupe (C7/C10 divergence
  from the primary secondary), envelope verified-actuals-only +
  `ValidatedFinding`-unchanged + run-scoped disposal, and the
  combined-cap prohibition.
