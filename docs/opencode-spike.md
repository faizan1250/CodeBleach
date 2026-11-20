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

## Structured output / limits / usage (P4-00 snapshot — superseded, see ledger)

> P4-00 perspective, 2026-11-20. The list below is the historical record of
> what the two generic live smokes left unverified. Current status per item is
> in the [verification ledger](#verification-ledger-p4-hardening); nothing
> below is current on its own.

Native JSON-schema support, response text extraction on a *completed* response,
authenticated `limit.*` values, `output_tokens_details.reasoning_tokens`,
`usage.cost`, `usage.opencode.allowance` / `billing_source`, timeout/abort/
429/`Retry-After` behavior, and the 400/401/403/404/5xx mapping all awaited a
completed live response in P4-02+. Starting config defaults
(`request_timeout_ms 90000`, `max_output_tokens 32768`, `max_retries 2`,
`max_concurrent_requests 3`, `max_review_unit_input_tokens 64000`) were then
hypotheses against limits no live call had yet authenticated.

Correction (P4 hardening, ADR 0022): no runtime clamp to authenticated
`limit.*` was ever implemented, and none exists — `limit.*` was never
observed, so ceilings are enforced pre-request against conservative local
hard limits (`src/llm/limits.ts`) and impossible requests fail closed, never
silently truncated. The 32K output default gives headroom over the old 4K
ceiling while staying below the third-party-reported 131072 maximum; that
maximum is a safety bound, not an account guarantee.

## Tools / execution boundary

The fixed integration is direct inference only: no `tools`/`tool_choice`, no agent
SDK/session host, no shell/filesystem/web/MCP access, no repository code execution.
The harness sends only the generic prompt above. Verified by construction in
`scripts/opencode-spike.ts` (no tool fields exist in the payload builder) and by
the live accepted responses.

## Redaction gap (patterns landed in P4-01, call site landed in P4-02)

`src/utils/redact.ts` now covers GitHub/AWS/Bearer/`sk-`/PEM plus Google `AIza`,
Slack `xox*`, Stripe `sk_/rk_/whsec_`, JWT, Basic, URL query secrets, quoted
`.env`/YAML/JSON forms, and generic sensitive `key=value` (idempotent, telemetry
keys preserved). The P4-02 provider calls pre-send redaction on the serialized
payload (`src/providers/opencode.ts`, instructions/input redacted with key
bytes) and the prompt builder redacts pre-serialize
(`src/review/prompt.ts` `sanitizePayload`), with the training gate enforced
pre-network — no source-bearing call exists without both. Pattern coverage is
pinned by `tests/unit/redact.test.ts`, not by the list above.

## Bun compatibility

Spike harness is Bun-native `fetch` + `AbortSignal.timeout`; pure helpers covered by
`tests/unit/opencode-spike.test.ts` (10 tests, offline, no secrets). Live smoke
result: **succeeds** (endpoint accepted; output incomplete-due-to-cap as above).

## P4-10 close-out (2026-11-20, no live calls)

Phase 4 is frozen (ADR 0020). The endpoint above is pinned in
`src/llm/constants.ts`; structured-output-off text path, response-text
extraction, input/output/reasoning-token and provider-reported-cost capture,
timeout/abort/`Retry-After`, and the 400/401/403/404/429/5xx mapping are
covered by mock-transport provider tests
(`tests/unit/opencode-provider.test.ts`, `tests/unit/review-result.test.ts`).
`allowance`/`billing_source` are parsed into diagnostic `raw` only, asserted
by no test, and not surfaced beyond `raw` (still open). No further live
probing was done.
The recorded quality signal is the deterministic mock seeded-bug smoke
(`tests/integration/review-seeded-smoke.test.ts`): seeded defect found at its
line with verbatim evidence, clean control silent, fingerprint stable. It
proves the prompt→parse→normalize pipeline, not model bug-detection
capability — no live model finding is claimed.
No live seeded-bug smoke was run; no secrets or raw prompts/responses were committed.
The P4-00 record above is unchanged.

## Verification ledger (P4 hardening)

Each item carries exactly one evidence class. Mock transport is never cited
as live proof, and the mock seeded-bug smoke is never cited as model
bug-detection proof.

1. Live authenticated, verified (P4-00, two generic smokes 2026-11-20):
   catalog `api.responses.base_url` for `opencode-go` /
   `muse-spark-1.3-contributor`; pinned Responses endpoint (path appended
   exactly once); bearer auth accepted (HTTP 200 on catalog + inference);
   `User-Agent: codebleach/<version>` and one stable opaque
   `x-opencode-session` accepted on the wire; direct-inference-only
   boundary (no `tools`/`tool_choice`, no agent host, no repo execution);
   `incomplete: max_output_tokens` at a 64-token cap — reasoning consumption
   of the output cap observed live, and the incomplete-vs-parse-failure
   split grounded in that observation.

2. Mock transport, verified (`tests/unit/opencode-provider.test.ts`,
   `tests/unit/review-result.test.ts`, `tests/unit/review-deadlines.test.ts`):
   structured-output-off text path (`output_text` + output-item walk);
   input/output/reasoning-token and provider-reported-`cost` capture;
   refusal / `incomplete` / `failed` / malformed classification without
   retry; 400/401/403/404 non-retryable and 408/429/`>=500` retryable
   mapping; `Retry-After` seconds + HTTP-date parsing clamped to 30 s;
   capped exponential backoff; per-request timeout; abort before send,
   mid-backoff against the real timer, and mid-flight; pre-send payload
   redaction with key bytes; training-gate and missing-key refusal
   pre-network.

3. Offline, verified (no network, no key, no opt-in):
   `tests/unit/opencode-spike.test.ts` (endpoint derivation, header
   builder, catalog `base_url` reader, opt-in predicate);
   `tests/integration/review-seeded-smoke.test.ts` (FakeProvider scripted
   defect at its line with verbatim evidence, clean control silent,
   fingerprint stable); `--no-llm` preview and `--demo --dry-run`
   network-free paths.

4. Not verified anywhere: any authenticated `limit.*` value; any
   completed-response text, usage, cost, allowance, or billing-source value
   observed live; native JSON-schema structured output against this
   endpoint; `allowance`/`billing_source` beyond diagnostic `raw` (parsed
   but unasserted, unsurfaced); any live model-identified defect — no live
   seeded-bug review was ever run.

5. Deferred (explicitly not attempted in Phase 4): completed live smoke
   with a larger cap; live usage/cost/allowance capture on completion;
   structured-output support; live seeded-bug smoke (Not-ZDR training
   terms, ADR 0020); runtime catalog tightening of local limits (local
   hard limits govern unless a verified source is plumbed in, ADR 0022).

## Remaining blockers (current status, P4 hardening)

Phase 4 shipped against the pinned endpoint with mock-transport coverage.
Still open, live-only or deferred: a *completed* (non-incomplete) live
smoke with a larger cap — no completed-response text, usage, cost,
allowance, or billing-source value has ever been observed live;
authenticated `limit.*` values (local hard limits govern per ADR 0022;
validated catalog metadata could only tighten them); structured-output
support (decided off, never probed against this endpoint); live seeded-bug
smoke (deferred under Not-ZDR terms per ADR 0020, not merely pending).
Covered by mock transport, not live: retry/timeout/abort/`Retry-After`
mapping, status-code mapping, and the incomplete-vs-parse-failure split
with one bounded cap escalation. No model/provider fallback is proposed
for any of these.
