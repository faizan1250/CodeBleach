# ADR 0016 — P4-01 fixed-model config and contract audit

## Status

Accepted (P4-01). Endpoint pinned from the 2026-11-20 live smoke; provider,
prompt, and orchestration stay P4-02+.

## Context

P4-00 proved the account/workspace can call OpenCode Go Responses at
`https://opencode.ai/inference/go/openai/v1/responses` with direct model ID
`muse-spark-1.3-contributor` (`docs/opencode-spike.md`). P4-01 audits the
config/provider/result contracts and implements only the fixed-model
configuration and CLI-safe controls, keeping Phase 1–3 configs loadable
unchanged.

## Decision

- Fixed target in code (`src/llm/constants.ts`): `opencode-go` /
  `muse-spark-1.3-contributor` / Responses, endpoint pinned from the
  authenticated catalog `base_url`. No model, endpoint, provider, or API-family
  fallback on any failure. `resolveModelId()` accepts unset or the fixed id
  and fails `CONFIG_INVALID` on anything else (including the TUI
  `opencode-go/` prefix); the `LlmRequest.model` field stays for interface
  compatibility only.
- Non-secret `llm.*` settings are optional v1 additions with strict Zod
  validation (`request_timeout_ms` 90000, `max_output_tokens` 32768,
  `max_retries` 2, `max_concurrent_requests` 3,
  `max_review_unit_input_tokens` 64000). `llm.provider` / `llm.model` /
  `llm.api_family` do not exist and are rejected as unknown keys. Token
  ceilings are starting defaults; P4-02 clamps them to the authenticated model
  `limit.*` at runtime.
- Secret handling: `OPENCODE_API_KEY` is environment-only. The CLI registers
  its exact bytes via `collectLlmSecrets()` with the logger and the pipeline
  `secrets` input, so logs and `run.json` redact it alongside patterns. The
  key never enters config, source, prompts, tests, or diagnostics.
- Training opt-in: `CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING=true` (exact match)
  is required before any model request, including the generic smoke
  (`requireTrainingOptIn()` throws non-retryable `CONFIG_INVALID`
  pre-network). Config validation and local tests need neither key nor opt-in.
- Pre-send redaction (`src/utils/redact.ts`) now covers Google `AIza`, Slack
  `xox*`, Stripe `sk_/rk_/whsec_`, JWT, Bearer/Basic, URL query secrets,
  quoted `.env`/YAML/JSON assignments, and generic sensitive `key=value`.
  Guards preserve telemetry keys (`inputTokens`, `max_tokens_per_unit`) and
  non-secret values; redaction is idempotent. The P4-02 provider must invoke
  it on the serialized payload before every source-bearing call.
- `ReviewBuildResult` decision: deferred to P4-07. The `ReviewEngine`
  contract (`review(units, config): Promise<Finding[]>`) is unchanged in
  P4-01; no shared contract changes ship here.

## Consequences

- P4-02 builds `OpenCodeProvider` against the pinned endpoint and fixed id,
  enforcing the gate and pre-send redaction, with no fallback paths to add.
- If the endpoint, model id, or limits change, update `src/llm/constants.ts`,
  `docs/opencode-spike.md`, and this ADR together.
- If P4-07 introduces `ReviewBuildResult`, that change gets its own ADR.
