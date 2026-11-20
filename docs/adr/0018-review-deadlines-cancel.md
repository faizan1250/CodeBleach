# ADR 0018 — Review stage deadline, abort propagation, and retry accounting

## Status

Accepted (P4-08). Implements the P4-08 slice of `implementation-phase4.md` §12.

## Context

P4-07 left `usage.retries` permanently `0` (ADR 0017 deferred provider
reporting to P4-08), had no overall review wall-clock ceiling, and never
passed an `AbortSignal` into the provider — so a hung unit, a long
`Retry-After` backoff, or caller cancellation could keep the CLI alive
indefinitely. P4-02 already bounded transport retries (max 2, backoff with
jitter, `Retry-After` capped at 30s), per-request timeout, and abort checks;
P4-08 wires that policy into the review path, counts retries distinctly from
JSON repairs, and makes stops preserve partial results. No pipeline/CLI
wiring (P4-09 owns composition).

## Decision

- New optional strict v1 config `llm.review_timeout_ms` (default 600000,
  bounds 1000–3600000): one wall-clock ceiling over every per-unit request,
  transport retry, repair, and cap escalation in a run. Phase 1–3 configs
  load unchanged with the default applied. Per-unit `request_timeout_ms`
  still bounds each request; the stage deadline bounds their sum.
- `ReviewEngine.review()` gains an additive optional third parameter
  `{ signal?: AbortSignal }` (`src/core/contracts.ts`). The engine builds one
  stage `AbortController` linked to the caller signal plus a
  `setTimeout(review_timeout_ms)` (always cleared in `finally`). Workers stop
  claiming units after a stop; in-flight `completeJson` calls receive the
  stage signal and abort; unclaimed units keep stable order with a
  content-free skip outcome. `CONFIG_INVALID` still throws and aborts the run.
- Stop diagnostics: `REVIEW_DEADLINE_EXCEEDED` (deadline, in-flight code
  override or `unit`-stage skip) and `REVIEW_CANCELLED` (caller abort);
  both `retryable: false`. Partial results survive: completed units keep
  their findings, status stays `partial`/`failed` via the existing
  `assembleReviewResult` counts. A `Retry-After` backoff longer than the
  remaining stage budget loses to the deadline (abort lands between attempts).
- Retry accounting: `LlmResponse` gains additive optional `retries`
  (transport retries behind that response). `OpenCodeProvider` reports it
  (attempt index; `0` on first-try success) and attaches `retries` to the
  exhausted retryable `ReviewerError` (new additive optional field); only
  retryable failures (408/429/5xx/network/timeout) carry a count, never
  400/401/403/404/refusal/incomplete/malformed. `FakeProvider` steps accept
  `retries`. `completeJsonWithStats` (now signal-threaded, repair included)
  accumulates response + error retry counts into `JsonCallStats.retries`,
  merged into `usage.retries` — distinct from `requests`, `repairRequests`,
  and `incompleteRetries`.
- No new `ReviewerError` codes: deadline/cancel are engine-level outcomes,
  not provider failures. No raw prompts, responses, or secrets in
  diagnostics; abort-reason text is redacted + truncated like other messages.

## Consequences

- P4-09 composes the real engine at the CLI root, constructs
  `OpenCodeProvider` from `config.llm` (`max_retries`, `request_timeout_ms`),
  and passes the caller signal; no engine or provider changes needed for that.
- The `systemdesign.md` §7 `LlmResponse` sketch and the "still open" line now
  record retry reporting as resolved (ADR 0018); Go allowance/billing-source
  surfacing beyond `raw` stays open and out of scope.
- Tests use injected transports and a signal-aware stub; only in-flight
  abort tests take short real waits (40–200ms), mirroring the P4-02 timeout
  tests — no network, no full-backoff sleeps.
