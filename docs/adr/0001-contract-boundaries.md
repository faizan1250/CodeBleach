# ADR 0001 — Contract boundaries: `src/types` vs `src/core/contracts.ts`

## Status

Accepted (Phase 1).

## Context

`systemdesign.md` §5 places both shared data contracts and engine stage
interfaces under `src/types`.

## Decision

- `src/types` holds pure shared data contracts only (diff, context, findings,
  validation, rules, provider data, GitHub/Publish data). It imports nothing
  from other `src/` directories.
- Orchestration and stage interfaces (`DiffEngine`, `ContextEngine`,
  `ReviewEngine`, `ValidationEngine`, `Publisher`, `runPipeline`) live in
  `src/core/contracts.ts` / `src/core/pipeline.ts`. They depend on shared data
  types and `ResolvedConfig` but expose no engine internals.
- Only `src/core/pipeline.ts` and `src/cli/` wire engines together.

## Consequences

- Later phases implement engines behind stable interfaces without touching
  shared data shapes.
- Any change to a public contract updates types, tests, `systemdesign.md`,
  and a new ADR in the same change.
