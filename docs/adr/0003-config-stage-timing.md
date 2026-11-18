# ADR 0003 — Config load is recorded as a timed pipeline stage

## Status

Accepted (Phase 1 fixes).

## Context

`StageName` (`src/core/contracts.ts`) already included `"config"`, but
`runPipeline` loaded config inline instead of via `runStage`, so no `config`
entry ever appeared in `stages` and a config failure produced `stages: []`.
The union advertised a stage the pipeline never emitted.

## Decision

Record config load as the first timed stage via the existing `runStage`
helper: `{ name: "config", status: "completed" }` on success (no item count),
`{ name: "config", status: "failed" }` when the loader rejects. Config errors
still stop execution before any engine stage; the failed artifact now carries
the failed `config` stage instead of an empty stage list.

## Consequences

- `StageName` is truthful; "record each stage's duration" (P1-06) covers
  config load timing.
- `implementation.md` execution order, accept criteria, and the §8 artifact
  example now list the `config` stage first.
- No `src/types` change; `dry-run` skipped-publish behavior is untouched.
