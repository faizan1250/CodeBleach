# ADR 0010 — Diff edge RED contract: `unsupported-mode` + CLI resolution policy

## Status

Accepted as RED contract (failing tests only, no engine behavior change).

## Context

Phase 2 leaves four edge gaps that GREEN must close without changing
existing behavior for ordinary files:

- Git `T` (typechange, e.g. `100644` → `120000`) yields 1 name-status
  record but 2 patch sections, so the parser fails with `PARSE_FAILED`
  count mismatch instead of a skippable file.
- Gitlinks (`160000`, e.g. `vendor/sub`) resolve as a commit object, so
  `cat-file -s` succeeds but `show` overflows the per-stream blob cap and
  fails as `GIT_FAILED` blob read instead of a skippable file.
- Large lockfiles / oversize blobs exceed a small patch cap before any
  size filter runs, failing as `GIT_FAILED` overflow instead of
  `lockfile` / `too-large`.
- CLI `diff` passes raw `--base` / `--head` strings straight to
  `GitDiffEngine`, which requires full SHAs (`GIT_FAILED`). No
  `rev-parse --verify --end-of-options <rev>^{commit}` resolution,
  dash-prefixed rejection, abbrev handling, or commit-object check
  exists yet.

`implementation-phase2.md:471` says not to invent a skip reason for
unsupported language, and `systemdesign.md:71` lists unsupported
language as listed-but-unsymbolled with no skip reason. That wording
covers language (`language: null`, `symbols: []`), not mode
(typechange / gitlink). A new mode-level reason needs an explicit
precedence slot.

## Decision

- Add seventh `DiffSkipReason` member `"unsupported-mode"` in
  `src/types/diff.ts` (barrel re-export only, no duplicate definition).
  It denotes a Git mode the engine does not review (typechange `T`,
  gitlink `160000`), distinct from unsupported language.
- Fixed precedence for GREEN:
  `deleted > unsupported-mode > binary > lockfile > ignored > too-large > generated`.
  `unsupported-mode` sits immediately after `deleted` because mode
  determines readability before any content check.
- Skipped files carry empty `hunks`, `commentableLines`, and `symbols`
  (observable skip, no patch body retained).
- `INVALID_INPUT` (`src/core/errors.ts`) denotes CLI-level rev
  validation failures. `exitCodeForError` maps it to `2` (usage error);
  runtime `GIT_FAILED` / `PARSE_FAILED` stay `1`. CLI resolution (GREEN)
  must use `git rev-parse --verify --end-of-options <rev>^{commit}`:
  reject dash-prefixed input before Git, resolve full SHAs
  (lowercased), verify the object is a commit, accept a uniquely
  resolving abbrev, error on ambiguous input (no nondeterministic test),
  never reach the engine on unresolved input, hint at fetching history
  for shallow/missing objects. `GitDiffEngine` stays full-SHA-only.
- `GitDiffEngine` gains an injectable `patchMaxStdoutBytes` seam
  (patch invocation only, default `DEFAULT_MAX_STDOUT_BYTES`,
  per-stream via `runProcess`, no global mutable). It lets RED tests
  prove missing early lockfile/size filtering as `GIT_FAILED` overflow.

## Consequences

- `tests/unit/diff-skip-reason.test.ts` six-member assertion goes red by
  design; GREEN restores it with seven members.
- `tests/integration/diff-edge-cases.test.ts` E01–E09 lock the RED
  failures (`PARSE_FAILED` count mismatch, `GIT_FAILED` blob read /
  overflow, missing `INVALID_INPUT` resolution) with deterministic tmp
  repos, plumbing-only staging, and fixed author/committer/timestamps.
- `systemdesign.md` §5 references the seven-member union and the
  precedence above; no other §5 change in RED.
- No parser, filter, or CLI resolution behavior changes in RED.
