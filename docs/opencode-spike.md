# OpenCode Go + Muse Spark 1.3 Contributor spike (P4-00, verified 2026-11-20)

Date: 2026-11-20. Status: **endpoint verified — two live generic smokes succeed**
(same result during P4-00 review round 2 and the P4-01 re-verify). No provider
code exists yet; `OPENCODE_RESPONSES_ENDPOINT` is pinned from the authenticated
`base_url` in P4-01 (ADR 0016).

## Official docs checked (2026-11-20)

- https://opencode.ai/docs/console/go — Go catalog, entitlement, privacy setting
- https://opencode.ai/docs/console/harnesses — base URL, Responses path, session header
- https://opencode.ai/docs/console/api/models — workspace catalog, per-model `base_url`
- https://opencode.ai/docs/console/api/inference — Responses shape, usage/allowance
- https://developers.openai.com/api/docs/guides/reasoning — reasoning-token accounting
- https://developers.openai.com/api/reference/resources/responses/methods/create

Docs were listed, not fetched, in this offline environment. Re-verify at live-smoke time.

## Fixed target (no fallback)

- Provider: OpenCode Go. Display name: Muse Spark 1.3 Contributor.
- Direct API model ID: `muse-spark-1.3-contributor` (never the TUI form
  `opencode-go/muse-spark-1.3-contributor`). API family: OpenAI Responses.
- Any 403/region/entitlement/privacy denial fails clearly. No model/endpoint/API-family fallback.

## Authenticated catalog request (RUN — live 2026-11-20, twice)

`GET https://opencode.ai/console/api/v1/models` with
`Authorization: Bearer <OPENCODE_API_KEY>` succeeded. The workspace catalog
contains `opencode-go.models["muse-spark-1.3-contributor"]` with
`api.responses.base_url = https://opencode.ai/inference/go/openai/v1`.
Model presence and workspace entitlement are therefore **VERIFIED**.

## Final Responses endpoint (PINNED)

`https://opencode.ai/inference/go/openai/v1/responses` — the catalog `base_url`
plus the Responses path appended exactly once. Proven by a harmless live POST
(HTTP 200, valid Responses envelope, `model: "muse-spark-1.3-contributor"`
echoed). The general-docs candidate and any third-party `/zen/go/v1` base are
retired as candidates, not kept as fallbacks. `deriveResponsesEndpoint()` keeps
a full `/openai/v1/responses` suffix as-is, gains only `/responses` on a bare
`/openai/v1` stem, else appends the full suffix — the stem never doubles. The
harness logs the raw catalog `base_url` (not secret) before derivation.

## Region / entitlement / privacy (VERIFIED as far as callable)

The catalog lists the model and the request is accepted, so region and
workspace entitlement hold from this environment. The "allow paid endpoints
that train on request data" toggle must be on for the call to succeed; it is
owner-operated and CodeBleach never toggles it.

## Training / data-use opt-in (OBTAINED for this environment)

Muse Spark 1.3 Contributor is Not ZDR: prompts/completions may train future Meta
models. `CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING=true` is set in this environment;
the spike harness refuses (exit 2, pre-network) without the exact value, and
every repository-bearing request (P4-02+) must check the same gate before
network access. No API key or secret is recorded here.

## Auth behavior

Key is environment-only (`OPENCODE_API_KEY`), never in config/source/logs/artifacts.
The harness attaches `Authorization: Bearer` at send time and logs `[REDACTED]`.
Live: bearer auth accepted (HTTP 200 on both catalog and inference calls).

## User-Agent / session header (PROVEN on wire)

`buildSpikeHeaders()` sends `User-Agent: codebleach/<version>` and one stable opaque
`x-opencode-session: ses_<id>` per run (reused across retries; no repo paths/SHAs).
Live: accepted on both calls; no secret leaked into headers.

## Redacted request shape (SENT — generic, no repo content)

```text
POST https://opencode.ai/inference/go/openai/v1/responses
Authorization: Bearer [REDACTED]
Content-Type: application/json
User-Agent: codebleach/0.1.0
x-opencode-session: ses_[REDACTED]

{"model":"muse-spark-1.3-contributor","input":"Reply with exactly the two words: spike ok","max_output_tokens":64}
```

Redacted response (truncated, 2026-11-20): `status: "incomplete"`,
`incomplete_details.reason: "max_output_tokens"` — the 64-token cap is consumed
by reasoning tokens, so no completed text. This confirms the reasoning-token
hypothesis: Responses `max_output_tokens` covers hidden reasoning plus visible
JSON, and a small cap yields `incomplete`, not a parse failure. `incomplete` is
classified separately from parse failure (no JSON repair on truncated output);
only `max_output_tokens` gets one bounded cap-escalation retry (P4-05).

## Structured output / limits / usage (STILL UNVERIFIED)

Native JSON-schema support, response text extraction on a *completed* response,
authenticated `limit.*` values, `output_tokens_details.reasoning_tokens`,
`usage.cost`, `usage.opencode.allowance` / `billing_source`, timeout/abort/
429/`Retry-After` behavior, and the 400/401/403/404/5xx mapping all await a
completed live response in P4-02+. Starting config defaults
(`request_timeout_ms 90000`, `max_output_tokens 32768`, `max_retries 2`,
`max_concurrent_requests 3`, `max_review_unit_input_tokens 64000`) remain
hypotheses clamped to authenticated `limit.*` at runtime. The 32K output
default gives headroom over the old 4K ceiling while staying below the
third-party-reported 131072 maximum.

## Tools / execution boundary

The fixed integration is direct inference only: no `tools`/`tool_choice`, no agent
SDK/session host, no shell/filesystem/web/MCP access, no repository code execution.
The harness sends only the generic prompt above. Verified by construction in
`scripts/opencode-spike.ts` (no tool fields exist in the payload builder) and by
the live accepted responses.

## Redaction gap (patterns landed in P4-01, call site pending in P4-02)

`src/utils/redact.ts` now covers GitHub/AWS/Bearer/`sk-`/PEM plus Google `AIza`,
Slack `xox*`, Stripe `sk_/rk_/whsec_`, JWT, Basic, URL query secrets, quoted
`.env`/YAML/JSON forms, and generic sensitive `key=value` (idempotent, telemetry
keys preserved). The P4-02 provider must still call pre-send redaction on the
serialized payload plus enforce the training gate — no source-bearing call exists
until then.

## Bun compatibility

Spike harness is Bun-native `fetch` + `AbortSignal.timeout`; pure helpers covered by
`tests/unit/opencode-spike.test.ts` (10 tests, offline, no secrets). Live smoke
result: **succeeds** (endpoint accepted; output incomplete-due-to-cap as above).

## P4-10 close-out (2026-11-20, no live calls)

Phase 4 is frozen (ADR 0020). The endpoint above is pinned in
`src/llm/constants.ts`; structured-output-off text path, response-text
extraction, usage/cost/allowance capture, timeout/abort/`Retry-After`, and the
400/401/403/404/429/5xx mapping are covered by mock-transport provider tests
(`tests/unit/opencode-provider.test.ts`), so no further live probing was done.
The recorded quality signal is the deterministic mock seeded-bug smoke
(`tests/integration/review-seeded-smoke.test.ts`): seeded defect found at its
line with verbatim evidence, clean control silent, fingerprint stable. No live
seeded-bug smoke was run; no secrets or raw prompts/responses were committed.
The P4-00 record above is unchanged.

## Remaining blockers (for P4-02+, not for pinning)

Phase 4 may proceed to provider code against the pinned endpoint. Still open:
a *completed* (non-incomplete) smoke with a larger cap; usage/cost/allowance
capture on completion; structured-output support; retry/timeout mapping. No
model/provider fallback is proposed for any of these.
