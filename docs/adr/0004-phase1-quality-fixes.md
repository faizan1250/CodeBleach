# ADR 0004 — Phase 1 quality fixes: runId ownership, redaction, errors, migration, ignore

## Status

Accepted (Phase 1).

## Context

Six discrete defects in Phase 1 wiring, all contract- or behavior-level.
Each fix below is minimal and preserves exit codes, Zod strictness, and the
no-secrets-in-logs invariant.

## Decision

### 1. runId ownership: the CLI mints one id per execution

`runPipeline` no longer mints its own UUID. `PipelineInput` gains a required
`runId: string`; the CLI generates it once (`randomUUID`), passes it to both
`createLogger` and `runPipeline`, and the pipeline threads it into the
artifact, stage logs, and `RunSummary`. The logger keeps reserved-key
precedence: a caller-supplied `runId` field never overrides the bound id.
Every log line and `run.json` from one execution share one id; independent
runs differ.

### 2. Redaction: precise normalized matching replaces substring matching

`isSensitiveKey` lowercases, strips separators, then matches against an exact
normalized set (`token`, `password`, `secret`, `authorization`, `privatekey`,
`clientsecret`, `apikey`, `apitoken`, `authtoken`, `accesstoken`,
`refreshtoken`, `opencodeapikey`) plus `apikey`/`apisecret`/`apitoken`
suffixes for prefixed variants such as `OPENCODE_API_KEY`. Telemetry keys
(`inputTokens`, `outputTokens`, `maxTokens`, `max_tokens`, `tokenCount`,
`totalTokens`) are no longer redacted. Exact-secret and token-pattern
redaction are unchanged; logger and artifact share the one sanitizer.

### 3. YAML errors carry `path:line:col`

`Bun.YAML.parse` throws a `SyntaxError` with non-enumerable numeric
`line`/`column` (falling back to `originalLine`/`originalColumn`). `loadConfig`
formats `path:line:col: invalid YAML: <msg>` when present and the previous
`path: invalid YAML: <msg>` otherwise. The shape is unpinned, so the helper
narrows `unknown` defensively and never throws. Exit code stays `2`.

### 4. Migrations are a version registry, still v1-only

`migrate(raw, registry = MIGRATIONS)` walks a `Record<number, Migration>`
chain: missing version means v1, newer-than-supported is
`CONFIG_UNSUPPORTED_VERSION`, unknown/lower versions and missing registry
entries are `CONFIG_INVALID`. A throwing step propagates (no partial silent
return); the validated output still flows through current Zod downstream.
Only the v1 identity entry exists — no v2 invented.

### 5. Duplicate-rule error renders a single `rules:` prefix

The array-level `.check` no longer pushes a redundant `["rules"]` issue path,
so Zod no longer doubles it to `rules.rules`. Rejection behavior is unchanged.

### 6. `ignore.paths` is additive over defaults

`mergeIgnorePaths` (in `defaults.ts`, the single source of defaults) returns
built-in defaults first, then user extras in file order with duplicates
dropped; an absent or empty user list yields the full defaults. The merge
happens in exactly one layer (schema transform). The example config documents
extends-not-replaces.

## Consequences

- `PipelineInput.runId` is required; `ResolvedConfig.ignore.paths` always
  contains the defaults.
- `systemdesign.md` §6/§9 and `implementation.md` P1-03/P1-04/P1-06 wording
  updated to match.
- No new dependencies; no Phase 2 work.
