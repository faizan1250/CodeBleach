# ADR 0008 — Pinned Git flags for deterministic diff output

## Status

Accepted (Phase 2 preflight); enforced by the engine in P2-07.

## Context

Both diff invocations (NUL metadata and unified patch) shell out to the
user's Git, whose `diff.algorithm`, `diff.interHunkContext`, and
`diff.renames` settings change hunk splits, add/delete sequences, and
rename detection. Unpinned flags make identical commits produce different
`DiffResult`s on different machines, breaking positions, `commentableLines`,
and replayability.

## Decision

- Pass `--diff-algorithm=myers --inter-hunk-context=0 --find-renames=50%`
  explicitly on both `git diff` commands (identical rename options so file
  order agrees). Never enable copy detection (`--find-copies` stays off).
- Treat user/global/repo Git config as adversarial input: integration tests
  set `diff.interHunkContext=10`, `diff.algorithm=patience`, and
  `diff.renames=copies` and require byte-identical hunks/positions and no
  `C` statuses.
- `systemdesign.md` §4.1 records the pinned invocation as the source of
  truth.

## Consequences

- Deterministic output for identical objects, SHAs, and config with no
  reliance on machine-local Git configuration.
- A future algorithm change is a deliberate ADR-level decision with
  re-baselined fixtures, not a silent drift.
