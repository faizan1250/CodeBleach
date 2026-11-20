# ADR 0017 — ReviewBuildResult status, usage, diagnostics, and artifact

## Status

Accepted (P4-07). Implements the P4-07 slice of `implementation-phase4.md` §11.

## Context

P4-04–P4-06 left `ReviewEngine.review()` returning a bare `Finding[]`, so a
failed `ReviewUnit` was indistinguishable from a clean one and provider
usage/diagnostics had nowhere to live. P4-07 needs successful/partial/failed
outcomes with surviving findings, request/usage accounting, and redacted
`run.json` persistence — without the P4-08 retry/deadline policy or the P4-09
pipeline/CLI wiring. ADR 0016 deferred exactly this contract change here.

## Decision

- `ReviewEngine.review()` returns `Promise<ReviewBuildResult>` (new pure-data
  `src/types/review.ts`, re-exported from `src/types/index.ts`;
  `src/core/contracts.ts` updated). Status semantics: `complete` (every
  submitted unit succeeded, including valid `findings: []`), `partial` (at
  least one unit succeeded), `failed` (none did), `skipped` (explicit
  no-model preview; only the `skippedReviewResult()` factory produces it —
  P4-09 wires `--no-llm`).
- `ReviewUsage{requests,retries,repairRequests,incompleteRetries,
  inputTokens?,outputTokens?,reasoningTokens?,totalTokens?,costUsd?,
  costKnown}`: `requests` counts every `LlmProvider.complete()` call
  (initial + repair + cap-escalation, including failed attempts, via
  `completeJsonWithStats` in `src/providers/json.ts`); `retries` stays `0`
  until the provider reports transport retries (P4-08). Token/cost fields are
  summed only from responses that report them and stay `undefined` (never
  zero-filled) when nothing is reported; `totalTokens` is set only when both
  input and output are known; `costKnown=false` means `costUsd` is absent.
- `LlmResponse` gains additive optional `usage.reasoningTokens` and
  `costUsd` (provider-reported charge only). `OpenCodeProvider` populates
  them from the Responses envelope (`output_tokens_details.reasoning_tokens`,
  `usage.cost`) alongside the existing `raw` diagnostics; `FakeProvider`
  scripted steps accept the same fields. No existing response shape changes.
- Per-unit `ReviewDiagnostic{stage,code,message,unitId?,retryable}` with
  stages `provider|prompt|parse|normalize|unit` and stable codes
  (`INPUT_BUDGET_EXCEEDED`, `PROVIDER_BAD_OUTPUT` at `parse` stage,
  `REVIEW_OUTPUT_INCOMPLETE` for exhausted cap escalation,
  `FINDING_REJECTED`, transport/policy codes verbatim). Messages are static
  or redacted + truncated to 500 chars — never model output, prompts, or
  secrets. Bounded at 100 entries (`MAX_REVIEW_DIAGNOSTICS`); counts stay
  exact. `CONFIG_INVALID` still aborts the run instead of producing a status.
- `run.json` gains `reviewStatus/reviewPromptVersion/reviewPromptHash/
  reviewModel/reviewUnitsSubmitted/reviewUnitsReviewed/reviewUnitsFailed/
  reviewUsage/reviewDiagnostics` (schema version stays 1; additive). Raw
  prompts, raw provider bodies, keys, and source-bearing diagnostics are
  never persisted — a prompt version/hash plus the already-persisted units
  and findings is the audit trail. Review-stage duration stays in the
  pipeline `stages[].ms` entry.
- Context-status visibility rides the artifact's existing
  `contextStatus/contextDiagnostics` fields; review diagnostics do not
  duplicate them. Fingerprint algorithm unchanged, so no P4-06 impact.

## Consequences

- P4-08 builds transport-retry reporting (`retries`), `Retry-After`,
  deadlines, and cancellation on top of these counters; P4-09 composes the
  real engine at the CLI root, passes pipeline secrets for redaction, adds
  `--no-llm` via `skippedReviewResult()`, and reaches the Validation stub.
- Demo/fixture/pipeline callers consume `.findings`; `--dry-run` artifact
  shape now includes the review summary block.
- If a future model reports per-request billing IDs or allowance as a
  charge, update `src/providers/opencode.ts` extraction and this ADR
  together; never estimate cost.
