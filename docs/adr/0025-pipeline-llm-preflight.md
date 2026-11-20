# ADR 0025 — Pipeline LLM preflight before diff and context

## Status

Accepted. Implements the preflight slice of the reliability/hygiene pass
(auditor-report-1 §4).

## Context

Provider prerequisites (training opt-in, API key) were enforced inside
`ReviewEngineImpl.review` and `OpenCodeProvider.complete` — i.e. after the
~7s context stage (git grep + tree-sitter over changed files) had already
run. A live run without consent or credentials paid for diff retrieval and
full context parsing before failing `CONFIG_INVALID` at the review stage.

## Decision

- New `src/llm/preflight.ts` `requireLlmPreflight({ config, env })` checks,
  in order: exact `CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING=true` (unchanged
  semantics/messages from `training-gate.ts`), non-empty `OPENCODE_API_KEY`,
  fixed-model wiring via `resolveModelId(FIXED_MODEL_ID)`, and config LLM
  budgets fitting the local context ceiling (mirrors the schema invariant
  for hand-built configs; Zod load already enforces it for files).
- `runPipeline` runs the preflight right after config load, before diff.
  `ReviewEngine` gains additive `requiresLlm` (`src/core/contracts.ts`):
  absent means the engine needs the model (fail-closed default);
  `false` marks offline/canned engines (demo, `--no-llm` skip) that bypass
  it. `PipelineInput` gains additive `env` (defaults to `process.env`).
- No new stage is recorded: a preflight failure leaves artifact stages at
  `[config completed]` with `CONFIG_INVALID` and never invokes diff,
  context, review, validation, or publish engines.
- Engine (`review/engine.ts`) and provider (`providers/opencode.ts`) gates
  stay untouched as defense-in-depth; consent behavior is unchanged.
- `--dry-run` still calls the model, so it preflights identically;
  `--no-llm` and demo skip it with zero credentials and no provider init.

## Consequences

- Live runs fail in milliseconds on missing consent/key instead of after
  the context stage; `run.json` proves it (config-only stages, null diff,
  empty units). `tests/integration/cli-diff.test.ts` and
  `tests/integration/review-no-llm.test.ts` now pin the fail-before-diff
  artifact shape.
- `tests/integration/pipeline-preflight.test.ts` pins the matrix:
  missing/empty key, non-exact opt-in, unusable budgets, and dry-run all
  fail with `CONFIG_INVALID` before any engine runs; offline engines run
  cred-free; the omitted flag defaults to preflight.
- Test fakes declare `requiresLlm: false` (they never touch the network);
  real-engine pipeline tests pass explicit creds via `PipelineInput.env`.
