# ADR 0030: Phase 5 CLI visibility, docs, and final regression hardening

Date: 2026-11-22

Status: Accepted (P5-10; Phase 5 ends here — Phases 6, 7, 8 not started).

## Context

P5-00 through P5-09 are merged (PRs #52–#61, main at `c34d2aa`): the concrete
deterministic `ValidationEngine` is wired into the CLI composition root, the
Phase 4 `NOT_IMPLEMENTED` dry-run tolerance is removed, and `run.json`
schema v2 carries `validated` plus `validationSummary` (ADR 0029). Remaining
P5-10 gaps: the CLI prints no validation counts; README still describes the
pre-Phase-5 stub contract; `systemdesign.md` still contains the optional-LLM
semantic-validation flow and already-posted-on-PR dedupe text superseded by
ADR 0028; the end-to-end matrix was never assembled as one hardening pass.

## Decision

1. CLI prints one bounded counts line per run (`findings: accepted /
   rejected / inconclusive / duplicates / policy-filtered`), a `run.json`
   pointer for per-finding reasons, and a scope disclaimer (validation
   verifies diff/path/location/evidence/provenance/policy only; it does not
   prove semantic correctness). No evidence quotes or source text on stdout.
2. `systemdesign.md` §2, pipeline flow, §4.4, decision table row 6, and the
   Phase 5 roadmap row are synced to deterministic-only v1: the optional
   independent-LLM check is superseded (deferred until Phase 8 evaluation
   evidence plus a separate decision, per ADR 0028 D1), and
   already-posted-on-PR dedupe is recorded as Phase 7, not validation.
3. `docs/validation.md` documents the stable check-code set, evidence
   side/snapshot rules, deletion-anchor behavior, config category/threshold/
   path-override semantics, dedupe/cap ordering, `run.json` v2, and dry-run
   vs `--no-llm` behavior. README points at it and states the real Phase 5
   contract.
4. The final matrix (`tests/integration/validation-phase5-matrix.test.ts`)
   runs the real engine + real snapshot reader over real commits: added-line
   accept, model-lies-both-ways, context-target accept, invalid path/line
   rejects, fabricated quote reject, working-tree-only quote reject (proves
   exact-`headSha` reads), old-side merge-base evidence with deletion-anchor
   accept, deleted-file reject, rename old/new mapping, deterministic
   duplicate winner under input permutation, category/severity/rule rejects,
   `max_findings` cap, inconclusive source read, and a fetch guard proving
   zero provider/GitHub calls during validation.

## Consequences

- Docs, CLI, artifacts, tests, and pipeline agree on deterministic-only
  Phase 5. Historical ADRs are preserved; only the stale system-design text
  is superseded, pointed here and at ADR 0028.
- Phase 6 (inferred conventions), Phase 7 (publisher, cross-run dedupe),
  Phase 8 (eval/optimization) are explicitly not started.
