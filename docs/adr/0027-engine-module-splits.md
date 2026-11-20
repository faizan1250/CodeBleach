# ADR 0027: Split review engine and diff git modules by responsibility

Date: 2026-11-21

## Context

`src/review/engine.ts` (~414 lines) mixed orchestration, stage-deadline
control, bounded worker-pool fan-out, per-unit budget/cap-escalation,
normalization, and usage/diagnostics. `src/diff/git.ts` (~697 lines) mixed
command execution, revision resolution, batch-check parsing, blob reads,
patch retrieval, and run orchestration. Both were the two largest engine
files and the hardest to unit-test in isolation (coupling first, size second).

## Decision

Split by responsibility, not line count; keep every public import path stable:

- `src/review/engine.ts` — orchestration only (preflight, stage setup, pool
  drive, result assembly, DI).
- `src/review/stage.ts` — deadline controller, stop codes, skip outcomes.
- `src/review/pool.ts` — bounded first-fatal-wins fan-out (`drainUnitPool`).
- `src/review/unit-runner.ts` — per-unit budget check, provider call, cap
  escalation, finding normalization, usage/diagnostics.
- `src/diff/git.ts` — `GitDiffEngine` orchestration; re-exports the previous
  public surface (resolvers, flags, engine) so CLI, scripts, and tests keep
  their import paths.
- `src/diff/revisions.ts` — SHA/repo/commit/merge-base resolution.
- `src/diff/git-exec.ts` — command execution (`gitDiffBytes`) and diff pins.
- `src/diff/blobs.ts` — head-blob reads, batch-check sizes, module symbols.
- `src/diff/patches.ts` — skip classification, pathspec build, patch fetch.

No behavior change: moves are mechanical, seams preserve exact control flow
(fail-fast identity, stop precedence, positional patch matching). New unit
tests cover each extracted seam (`review-stage/pool/unit-runner`,
`diff-revisions/blobs/patches`).

## Consequences

- `systemdesign.md` §10 file listings updated to the new layout.
- Compat re-exports in `src/diff/git.ts` are intentional (stable imports for
  CLI/tests), not barrel bloat: they re-export only the previously-public
  surface, nothing new.
- Follow-ups keep the same rule: split on coupling boundaries, keep import
  paths stable, add seam tests in the same commit.
