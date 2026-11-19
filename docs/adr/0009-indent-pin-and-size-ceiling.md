# ADR 0009 — Indent-heuristic pin and `max_file_size_kb` ceiling

## Status

Accepted; enforced by the engine and config schema.

## Context

Two Phase 2 hardening gaps, no redesign:

1. `PINNED_DIFF_FLAGS` (`src/diff/git.ts`) pins the diff algorithm,
   inter-hunk context, and rename threshold, but not the indent heuristic.
   Repo/user `diff.indentHeuristic` config therefore shifts hunk attribution
   (e.g. deleting one of several identical unindented lines next to an
   indented block attributes the deletion to oldLine 3 with the heuristic on
   versus oldLine 4 with it off), changing hunks, positions, and
   `commentableLines` for identical commits.
2. `review.max_file_size_kb` (and its `path_overrides` twin) accepts any
   positive int. The blob-show path reads
   `min(sizeBytes+1, 26MiB)` per stream (`src/utils/spawn.ts`, per-stream
   caps tracked independently), so an absurdly large configured max admits a
   blob whose `show` overflows the cap and fails as `GIT_FAILED` instead of
   skipping as `too-large`.

## Decision

- Add `--no-indent-heuristic` to `PINNED_DIFF_FLAGS`, covering the metadata
  and patch invocations together via the shared const. Explicit CLI flags
  override repo/global/user config, so no config plumbing is needed.
- Add `MAX_MAX_FILE_SIZE_KB = 26623` (`src/config/defaults.ts`, single
  source) and enforce it as `.max()` on both `max_file_size_kb` fields with a
  field-named error. Derivation: an accepted blob satisfies
  `sizeBytes <= max*1024`; the show needs `sizeBytes+1 <= 26MiB`, so
  `max <= floor((26*1024*1024-1)/1024) = 26623`. Default stays 500 KB.
- Fixed max, not a bounded/chunked blob reader: the 26 MiB spawn cap remains
  regardless, so a reader only adds complexity for no extra guarantee.
  Multi-hundred-MB file support would require raising the spawn cap itself,
  which is out of scope.

## Consequences

- Identical commits produce identical `DiffResult`s under hostile
  `diff.indentHeuristic` true/false config; integration test locks the
  discriminating fixture's normalized hunks, positions, and commentableLines.
- Over-max configs fail at load (`CONFIG_INVALID`, exit 2) instead of
  failing mid-run; any accepted max provably keeps blob-show under the cap.
- A future flag or ceiling change is a deliberate ADR-level decision with
  re-baselined fixtures, not silent drift.
