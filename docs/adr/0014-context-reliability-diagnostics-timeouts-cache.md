# ADR 0014 — Context reliability: test retrieval, timeout diagnostics, parse cache (P3-F01..F04)

## Status

Accepted (P3 hardening F01–F04). Docs sync in `systemdesign.md` §4.2/§5; no Phase 4 surface.

## Context

ADR 0013 fixed ranking, budget, and a `complete | partial` contract before test
retrieval, timeout accounting, and caching existed. F01–F04 changed the
contract additively (`src/types/context.ts`): a `"failed"` status, typed engine
diagnostics, and parse-cache counters — each a decision worth recording, not
just prose.

## Decision

- Test retrieval (`src/context/tests.ts`): head snapshot only, relative imports
  only, no test execution. Evidence order: direct relative file import >
  barrel-re-export symbol import > AST-verified call > base-name match >
  comment/string-only mention (always weakest). Same-name local definition
  without import evidence excludes the file. Caps `MAX_TESTS_PER_SYMBOL=16`,
  `MAX_TEST_GREP_MATCHES=200`, `MAX_TEST_SCAN_FILES=200`, snippet
  `TEST_SNIPPET_CONTEXT_LINES=10`. Ranking reuses existing weights
  (`test 55`, same-dir-test `0.55`); weak evidence never outranks AST-confirmed.
- Diagnostics: `ContextDiagnostic{stage, path, symbol?, code, reason}` with
  stages `snapshot | parse | import | caller | callee | test`; max 100 entries,
  key-deduped, paths/symbols truncated to 200 chars, static codes only (never
  messages, source text, or file content). Expected misses (no-match vs
  failure) keep `complete` and stay silent.
- Status: `complete` (no issues) | `partial` (issues with units, or
  deadline/budget with zero units) | `failed` (zero units + retrieval-failure
  diagnostic). Cap-only, budget-only, or parse-cancelled-only diagnostics stay
  `partial`, never `failed`. Pipeline/artifact `contextStatus` widened to
  match; partial/failed runs still persist `run.json`.
- `queryTimeouts` = number of engine-observed timed-out Git subprocess calls
  (`isGitTimeout`: `GIT_FAILED` with cause reason `"timeout"`). Single-attempt
  Git, no retry inflation; resolvers rethrow timeout-cause errors instead of
  misreporting them as content misses; counted exactly once per call. Parse
  cancellations and non-timeout Git failures never qualify.
- Parse cache (`src/context/parse-cache.ts`): per-run, keyed
  `(commit, path, language)` with head/base separate via distinct SHAs; plain
  extraction bundles only (never Tree/WASM handles; `clear()` at run end).
  Hits skip the run budget; misses parse under it; cancelled parses uncached.
  Caps 256 entries / 8 MiB (source-bytes proxy). Additive
  `parseCacheHits/Misses/Entries`; `filesParsed` counts actual parses only.
  Cached output is byte-identical to uncached.

## Consequences

- `ContextBuildResult.status` readers must handle `"failed"`; additive fields
  only otherwise — no `src/diff` touch, no pipeline rewiring, no Phase 4.
- If evidence tiers, timeout counting, cache keys/caps, or status rules change,
  update this ADR, `systemdesign.md` §4.2/§5, and the context tests together.
