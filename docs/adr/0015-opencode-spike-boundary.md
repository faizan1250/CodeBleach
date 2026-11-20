# ADR 0015 — OpenCode Go + Muse Spark 1.3 Contributor spike boundary (P4-00)

## Status

Accepted (P4-00). Endpoint unpinned; live smoke blocked on key + opt-in.

## Context

Phase 4 fixes a single model integration: OpenCode Go API, direct model ID
`muse-spark-1.3-contributor`, OpenAI Responses family. P4-00 had to prove the
authenticated endpoint, entitlement, and data-use gate before any provider code.
This environment has no `OPENCODE_API_KEY` and no training opt-in, so no live
call was made. `docs/opencode-spike.md` records the full blocked status.

## Decision

- Fixed target only: `opencode-go` / `muse-spark-1.3-contributor` / Responses.
  No model, endpoint, provider, or API-family fallback on any failure.
- Production endpoint constant stays **unset**. The only derivation rule is
  `deriveResponsesEndpoint(authenticated api.responses.base_url)` in
  `scripts/opencode-spike.ts`; general-docs and third-party URLs are candidates.
- Harness-only scope: `scripts/opencode-spike.ts` (manual, gated, harmless generic
  prompt) plus offline unit tests. Nothing in `src/` is added or changed.
- Explicit opt-in gate `CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING=true` (exact match)
  is required even for the generic smoke, and for every repository-bearing call
  from P4-02 on. Missing opt-in fails before network access. CodeBleach never
  toggles the workspace privacy setting.
- Request boundary: `User-Agent: codebleach/<version>`, one stable opaque
  `x-opencode-session` per run, no `tools`, no SDK/agent host, no repo execution.
- Key is environment-only (`OPENCODE_API_KEY`); headers/bodies with secrets are
  never logged or persisted. Pre-send redaction strengthening is deferred to
  P4-02/P4-03 and is mandatory before any source-bearing request.

## Consequences

- P4-01+ may pin the endpoint only after the authenticated catalog + generic
  smoke succeed; until then every limit/default is a hypothesis.
- If the catalog lacks the model or access is denied, Phase 4 stays blocked;
  changing the model requires a new explicit owner decision and ADR.
- If the Responses request shape differs from the harness assumption, update
  this ADR, `docs/opencode-spike.md`, and the P4-02 mapping together.
