# ADR 0002 — Custom secret values reach the artifact sanitizer

## Status

Accepted (Phase 1 fixes).

## Context

`sanitizePayload`/`redact` (`src/utils/redact.ts`) already redacts exact
custom values longest-first, but only when callers pass them via
`extraSecrets`. `writeArtifact` took no secrets argument and `PipelineInput`
had no secrets channel, so non-pattern custom values embedded in stage output
were persisted in cleartext in `run.json`. Only pattern-matched tokens and
sensitive-key values were redacted.

## Decision

- `PipelineInput` gains optional `secrets?: string[]`.
- `writeArtifact(outDir, artifact, secrets = [])` forwards the list to the
  recursive sanitizer.
- `runPipeline` passes `input.secrets ?? []` through on every artifact write.
- No new environment variable or config field is introduced: the CLI does not
  yet supply secrets, so callers that hold custom values pass them explicitly.
  Wiring an env/config source is future work and gets its own ADR when added.

## Consequences

- Exact custom-secret redaction works end to end for any caller that knows the
  values; `src/types` is untouched.
- `AGENTS.md` ownership holds: the change is confined to
  `src/core/contracts.ts`, `src/core/pipeline.ts`, and `src/core/run-artifact.ts`.
