# ADR 0021 — Live dry-run completes past the validation stub (unvalidated)

## Status

Accepted (P4 hardening).

## Context

Phase 4 froze with validation `NOT_IMPLEMENTED` (ADR 0020). Any live review —
including `--dry-run` — persisted review output then threw at
`src/core/pipeline.ts` validation, so a model-connected dry-run could never
complete. `--no-llm` is the only network-free preview and exits 0 with
review/validation skipped.

## Decision

- `--dry-run` may run the real LLM (training gate still enforced pre-network),
  never publishes, and now completes when validation throws only
  `NOT_IMPLEMENTED`: the failed validation stage is replaced with
  `skipped`/`validation_unimplemented`, findings stay unvalidated in
  `run.json`, publish stays skipped `dry-run`, exit 0.
- Never report validation success from the stub: no `accepted` findings, no
  `completed` validation stage. Non-`NOT_IMPLEMENTED` validation errors still
  throw under `--dry-run`, and non-dry-run live runs still fail at the stub.
- `--no-llm` is unchanged: no provider is constructed, so zero requests, no
  key/opt-in, offline-suitable. CLI output states
  `--dry-run != offline/--no-llm` explicitly.

## Consequences

- No Phase 5 work: no `introducedByPr`/semantic validation, no confidence or
  evidence checks. Phase 5 replaces the stub; the `validation_unimplemented`
  skip reason disappears with it.
- Contract delta vs ADR 0020: dry-run stage sequence is now
  `review completed → validation skipped → publish skipped`.
