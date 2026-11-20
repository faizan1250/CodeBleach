# ADR 0026 — Batched commit-snapshot blob reads

## Status

Accepted. Implements the performance slice of the reliability/hygiene pass
(auditor-report-1 §5).

## Context

`SnapshotReader.readBlobText` cost two `git` spawns per uncached blob (a
`cat-file -s` size probe plus a `cat-file blob` read). On the 22-file
benchmark fixture that was 100 blob spawns out of 186 total context-stage
git calls. The parse cache already deduplicated parsing (50 misses), so
process spawning — not tree-sitter — dominated the remaining wall time
(~11.1s). A persistent `cat-file --batch` coprocess would remove the spawns
entirely but adds lifecycle risk (framing desync, stuck stdin, orphaned
background process, per-request timeout plumbing).

## Decision

- One-shot `git cat-file --batch` per fetch unit instead of a persistent
  coprocess: argv-only, piped stdin fed from memory, the process exits at
  stdin EOF and is reaped by `runProcess`, so no background process can
  leak. Timeout, output-limit, and abort semantics come from `runProcess`
  unchanged. Single-OID lazy reads cost one spawn (header carries the exact
  size, so the probe is gone); over-cap blobs exceed the stdout bound and
  resolve to the exact legacy cap/total errors via a `--batch-check` probe.
- `parseBatchCheckLine` / `parseBatchContent` (`src/context/snapshot.ts`)
  parse the batch protocols as pure functions: byte-offset framing from
  header sizes (binary-safe for NUL/LF bytes in content), in-order OID echo
  checks, strict trailing-byte rejection. Any violation is `GIT_FAILED`.
- `prefetchBlobs` fetches all changed-file head/base blobs up front in
  16-OID chunks (one spawn each, bounded stdout). Best-effort by contract:
  never throws; any failure leaves the id uncached and the later lazy read
  reproduces the exact original error with its diagnostics. Guarded by
  `remainingRunMs() > 0` so expired runs spawn nothing, and loads are
  sequential so no git child can outlive the build (a rejected `Promise.all`
  would abandon its sibling as background work and break Windows cleanup).
- Error messages are unchanged (`above the N-byte per-blob snapshot cap`,
  `would exceed the N-byte run cap`, `is missing`, not-in-tree,
  non-regular-file); per-blob and cumulative byte caps are still enforced
  before caching, from header sizes.
- Additive diagnostics: `ContextBuildDiagnostics` gains `gitCalls`,
  `blobsFetched`, `blobCacheHits`, `batchFetches` next to `queryTimeouts`
  and the parse-cache counters. `scripts/bench-context.ts` (manual-only,
  excluded from `bun test`) builds a deterministic 22-changed-file fixture
  and prints wall time, git/blob/parse counts, heap delta, and a canonical
  units hash for before/after comparison.

## Consequences

- Benchmark fixture: 11.1s → ~6.2s wall, 186 → 97 git calls, 100 blob
  spawns → 11 batch spawns, identical units hash across runs. No invented
  gains: gains are spawn-count reduction plus identical output, both
  measured, not projected.
- `tests/unit/context-snapshot.test.ts` pins the batch protocol (binary
  content, missing, truncation, OID mismatch, trailing bytes);
  `tests/integration/context-snapshot.test.ts` pins single-spawn reads,
  best-effort prefetch, and exact legacy cap messages through the new path;
  `tests/unit/context-parse-cache.test.ts` pins language separation,
  budget-independent identity, and per-instance isolation;
  `tests/integration/context-pipeline.test.ts` pins byte-identical units
  across repeated builds (deterministic ranking end-to-end).
