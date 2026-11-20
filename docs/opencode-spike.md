# OpenCode Go + Muse Spark 1.3 Contributor spike (P4-00)

Date: 2026-11-20. Status: **BLOCKED — no live smoke run** (no `OPENCODE_API_KEY`,
no `CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING=true` in this environment). No endpoint
is pinned. No provider code exists yet.

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

## Authenticated catalog request (NOT RUN)

Intended: `GET https://opencode.ai/console/api/v1/models` with
`Authorization: Bearer <OPENCODE_API_KEY>`, then inspect
`opencode-go.models["muse-spark-1.3-contributor"].api.responses.base_url` plus
`limit.context` / `limit.input` / `limit.output`. Not run: no key present.
Model presence in the workspace catalog is therefore **UNVERIFIED**.

## Final Responses endpoint (UNPINNED)

The general-docs candidate `https://opencode.ai/inference/go/openai/v1/responses`
and any third-party `/zen/go/v1` base are **unverified candidates, not approved**.
The production constant stays unset until `scripts/opencode-spike.ts` derives the URL
from the authenticated `base_url` and a harmless live request succeeds.
`deriveResponsesEndpoint()` (tested) only normalizes that catalog value.

## Region / entitlement / privacy (UNVERIFIED)

Region eligibility, workspace entitlement, and the "allow paid endpoints that train
on request data" toggle were not verified (no authenticated call). If the catalog
or request denies access, Phase 4 stops; no substitution.

## Training / data-use opt-in (NOT OBTAINED)

Muse Spark 1.3 Contributor is Not ZDR: prompts/completions may train future Meta
models. Owner acknowledgement is **not recorded**. The spike harness refuses to run
without `CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING=true`, and every repository-bearing
request (P4-02+) must check the same gate before network access. The workspace
privacy toggle is owner-operated; CodeBleach never enables it.

## Auth behavior

Key is environment-only (`OPENCODE_API_KEY`), never in config/source/logs/artifacts.
The harness attaches `Authorization: Bearer` at send time and logs `[REDACTED]`.
No live auth result to report.

## User-Agent / session header (harness-ready, UNPROVEN on wire)

`buildSpikeHeaders()` sends `User-Agent: codebleach/<version>` and one stable opaque
`x-opencode-session: ses_<id>` per run (reused across retries; no repo paths/SHAs).
Unit-tested; wire behavior unverified pending live smoke.

## Redacted request shape (intended, NOT SENT)

```text
POST <catalog-derived-responses-url>
Authorization: Bearer [REDACTED]
Content-Type: application/json
User-Agent: codebleach/0.1.0
x-opencode-session: ses_[REDACTED]

{"model":"muse-spark-1.3-contributor","input":"Reply with exactly the two words: spike ok","max_output_tokens":64}
```

No response was received (no live call); no example response to record.

## Structured output / extraction / limits / usage (UNVERIFIED)

Native JSON-schema support, response-text extraction, `limit.*` values, reasoning-token
accounting (`output_tokens_details.reasoning_tokens`), `usage.cost`,
`usage.opencode.allowance` / `billing_source`, `incomplete_details.reason` handling,
timeout/abort/429/`Retry-After` behavior, and the 400/401/403/404/5xx mapping all
await the live smoke. Starting config defaults (`request_timeout_ms 90000`,
`max_output_tokens 32768`, `max_retries 2`, `max_concurrent_requests 3`,
`max_review_unit_input_tokens 64000`) remain hypotheses clamped to authenticated
`limit.*` at P4-01. `incomplete` is classified separately from parse failure (no
JSON repair on truncated output); only `max_output_tokens` gets one bounded
cap-escalation retry.

## Tools / execution boundary

The fixed integration is direct inference only: no `tools`/`tool_choice`, no agent
SDK/session host, no shell/filesystem/web/MCP access, no repository code execution.
The harness sends only the generic prompt above. Verified by construction in
`scripts/opencode-spike.ts` (no tool fields exist in the payload builder).

## Redaction gap (awareness, fix deferred to P4-02/P4-03)

Current `src/utils/redact.ts` covers GitHub/AWS/Bearer/`sk-`/PEM + sensitive keys.
Still missing before any source-bearing call: Google `AIza`, Slack `xox*`, Stripe
`sk_/rk_/whsec_`, JWT, URL query secrets, quoted `.env`/YAML/JSON forms, generic
sensitive `key=value`. Pre-send redaction of the serialized payload plus the
training gate are mandatory before P4-02; nothing source-bearing is sent in P4-00.

## Bun compatibility

Spike harness is Bun-native `fetch` + `AbortSignal.timeout`; pure helpers covered by
`tests/unit/opencode-spike.test.ts` (6 tests, offline, no secrets). Live smoke
result: **not run — blocked on key + opt-in**.

## Blocker

Phase 4 cannot proceed to provider code until the owner provides `OPENCODE_API_KEY`,
sets `CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING=true`, and the generic smoke at the
catalog-derived endpoint succeeds. No fallback model/provider is proposed.
