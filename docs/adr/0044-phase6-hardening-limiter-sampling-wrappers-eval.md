# ADR 0044: Phase 6 implementation hardening — shared limiter, ranked sampling, wrapper denominators, eval-gate integrity

Date: 2026-11-23

Status: Accepted (documents hardening commits A–D on `fix/phase6-final-hardening`; no contract widening).

Preserves ADRs 0001–0043; rewrites none. Supersedes no ADR: every delta below
lands inside bounds the plan and ADR 0043 already froze, and is recorded here
because each changes observable behavior the plan described loosely.

## Context

P6-00…P6-05 implemented the normative plan on `fix/phase6-final-hardening`.
Four hardening fixes followed, each tightening a spot where the
implementation was correct in shape but loose in a load-bearing detail:

1. Advisory and primary providers shared no enforcement point: the plan said
   "the same global concurrency limiter", but no limiter instance existed,
   so combined in-flight calls could exceed `max_concurrent_requests`.
2. Merge-base sizing resolved blob sizes before ranking, so enumeration
   order could affect the sample and one unbounded `--batch-check` round
   trip carried the whole tree.
3. The common-wrappers detector counted a detector-level denominator and
   resolved calls without lexical scope, so shadowing bindings and
   ambiguous locals could produce false matches and the support ratio did
   not measure per-helper adoption.
4. The eval harness could report zero usage indistinguishably from lost
   telemetry and counted labels instead of emitted records, so a thin or
   broken sweep could look like a pass.

## Decision

1. **Run-scoped shared limiter.** One `RunConcurrencyLimiter` per live run
   (`src/providers/limiter.ts`) wraps both the primary and the
   advisory-specific (zero-retry) providers at the `complete()` boundary.
   Combined in-flight calls never exceed `max_concurrent_requests`;
   transport retries and JSON-repair follow-ups funnel through the same
   boundary. No global state: every run mints its own limiter, and abort
   skips cancelled waiters without stranding permits.
2. **Rank-first bounded sizing.** Eligible paths rank by the pinned hash
   before any size lookup; sizes resolve in rank order through successive
   bounded `cat-file --batch-check` rounds of at most
   `SAMPLING_SIZE_BATCH_OIDS = 200` OIDs with per-round stdout caps, and
   batching stops early once the file/byte budget is unfillable.
   Enumeration order, OS, and timing cannot affect the sample. Frozen caps
   (200 files / 128 KiB per blob / 8 MiB total, policy v2) are unchanged.
3. **Per-helper wrapper denominators with lexical semantics.** Each
   resolved (helper path, exported symbol) group carries its own
   denominator: sampled non-test files importing that group, counting even
   when they never call. Test files and unresolvable imports belong to no
   group; one local name bound to several helpers resolves to none. A call
   matches only when a bare-identifier callee names an unambiguous local
   binding, the first argument is an inline arrow/function expression, and
   no shadowing binding (parameters, locals, destructured names, catch
   params, hoisted declarations) or dynamic `with` scope covers it.
   Identifier text alone never matches. The emitted template is `Modules
   importing the repository helper <identifier> repeatedly wrap callbacks
   with it.` with the existing identifier-token allowlist. Detector
   version stays meaningful: `common-wrappers` is v2.
4. **Eval-gate integrity and acceptance.** The gate counts emitted
   real-PR records, never labels (`MIN_EVAL_CANDIDATES = 30`,
   `MIN_USEFUL_PRECISION = 0.8`); seeded fixtures never enter either side.
   Advisory telemetry is machine-readable info-level events on every exit
   path (`advisory pass completed/skipped`, `advisory merge
   completed/skipped`) parsed by exact `msg` match — missing or malformed
   telemetry fails the gate instead of reporting zero usage, and genuine
   zeros are distinguishable from lost logs. Labels carrying
   category/severity/ruleId are rejected; authority requires emitted
   `convention` / exactly `low` / absent `ruleId`. **Status: the harness
   is built and the pinned 30-PR / 6-repo corpus exists; the gate has not
   passed, so `--convention-advisory` stays a development/experiment flag
   (default off) and a failing gate never weakens thresholds.**

## Consequences

- `ValidatedFinding`, check codes, config schema, artifact v2, public
  `ValidationEngine.validate()`, and every frozen bound are unchanged.
- Flag-off runs remain byte-identical primary-only with no scan or extra
  provider work; ordinary advisory failures stay fail-open.
- No persistent convention cache is introduced by any delta (§8 stands).
- Deterministic claims are unchanged (hash-ranked sampling, integer
  cross-product support, input-ordered advisory outputs); semantic claims
  stay out of scope — usefulness is decided only by the §16.5 gate.
- Roadmap: Phase 6 is implemented but not cleared until the gate passes;
  Phase 7/8 remain out of scope and must not assume Phase 6.
