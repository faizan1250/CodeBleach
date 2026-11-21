# ADR 0031: Typed snapshot blob-failure classification, no message matching

Date: 2026-11-22

Status: Accepted (post-Phase-5 hardening P1; Phases 6, 7, 8 not started).

## Context

`src/validate/snapshot.ts` classified blob-read failures by regexing
`ReviewerError` messages (`/cap/` → `size_limit`, `/is missing/` →
`not_found`). Message text is not a contract: any wording change silently
re-maps statuses, and unrelated failures whose text happens to match (a
transport error mentioning a cap, a protocol error echoing an OID) become
success-shaped statuses instead of fail-closed stage failures. Structured
ground truth already exists one layer down: `runProcess` attaches
`ProcessFailureDetails` (`reason: spawn | timeout | exit | output-limit |
abort`) as `ReviewerError.cause`, and the `SnapshotReader` cap/missing sites
knew their exact content condition at throw time but discarded it.

## Decision

1. `src/context/snapshot.ts` throws blob-content failures with a typed
   `SnapshotBlobFailureDetails` cause (`kind: missing | per-file-limit |
   cumulative-limit`, plus `oid`/`sizeBytes`/`limitBytes`); messages stay
   human-readable and are never parsed.
2. `src/validate/snapshot.ts` maps ONLY explicit typed conditions to
   statuses: `missing` → `not_found`, `per-file-limit`/`cumulative-limit` →
   `size_limit`, runProcess `timeout` → `timeout` (via `isGitTimeout`),
   `abort` → `aborted` (via new `isGitAbort`, mirroring `isGitTimeout`).
3. Everything else propagates as a stage failure (fail-closed): raw
   transport `output-limit` is NOT a content cap and never maps to
   `size_limit`; `exit`/`spawn`, protocol corruption (`PARSE_FAILED`,
   unexpected batch headers), and untyped `GIT_FAILED` throw.
4. `isGitTimeout`/`isGitOutputLimit` semantics are unchanged; new
   `isSnapshotBlobFailure` predicate lives beside them. `isCapError`/
   `isMissingError` are deleted; they have no other call sites.

## Consequences

- Status mapping is pinned by typed-cause tests (typed missing/per-file/
  cumulative, real-subprocess timeout mapped to `timeout`, real-subprocess
  output-limit propagated, untyped `cap`/`is missing`/timeout wording
  propagated, malformed index/blob output propagated, real-git ghost-blob
  `not_found`, real-git cumulative `size_limit`).
- No contract change: `SnapshotReadStatus`, `ValidationSnapshotReader`,
  `src/types`, and `src/core/contracts.ts` are untouched, so
  `systemdesign.md` needs no edit (it describes cap behavior, never matcher
  internals). Pre-existing statuses and fail-closed behavior are preserved.
- Phase 6/7/8 scope is untouched: no semantic validation, no publisher, no
  cross-run behavior.
