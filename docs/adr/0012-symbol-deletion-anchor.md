# ADR 0012 — AST symbol identity, deletion mapping, and anchor contract (P3-04)

## Status

Accepted (P3-04 symbol half). Import/export resolution (P3-05) and caller
resolution (P3-07) are deferred to their tickets and will extend this ADR's
resolution-half notes, not rewrite the contract below.

## Context

Phase 2 leaves a coarse synthetic module placeholder in
`ChangedFile.symbols` with `changedLines: []` for deletion-only hunks (E05),
and `ChangedSymbol` has no way to distinguish head-side additions from
old-side deletions. Phase 3 maps diff lines to AST-derived symbols from
exact commit snapshots (`headSha` for current source, `mergeBase` for
old-side deletions) without mutating `DiffResult` or touching `src/diff`.

## Decision

- `SymbolKind` gains `"type"` for interface/type-alias/enum declarations
  (`src/types/diff.ts`). `ContextItem.kind: "type"` already exists, so type
  changes are no longer mislabeled as classes or forced into module units.
- `changedLines` keeps head-side added line numbers only, 1-based inclusive.
- `deletedLines?: number[]` holds merge-base/old-side deleted line numbers
  only, sorted and deduplicated. It is never mixed into `changedLines`.
- `anchorLine?: number` is a 1-based head-side line that must already be in
  `ChangedFile.commentableLines`. It is set only for deletion-only symbols
  (empty `changedLines`, non-empty `deletedLines`) and omitted otherwise —
  mixed add/delete symbols already have head-side targets, and no anchor is
  invented when no surviving commentable line exists.
- Anchor selection: candidates are `ctx` lines (`newLine !== null`) from the
  hunks holding the symbol's deletions. Prefer the nearest candidate inside
  the matched head symbol, else the nearest same-hunk line. Ties prefer the
  following line, then the lower new-side line number.
- `startLine`/`endLine` are head-side inclusive coordinates from the matched
  head definition's full range.
- Deleted lines match head symbols by kind + name + container identity, never
  by raw line numbers. Overloads/repeated names resolve by declaration order
  (stable occurrence discriminator, `#2` suffix style).
- A fully removed declaration with no head counterpart falls back to the
  surviving module-level symbol (`<module>`, head file extent) carrying
  `deletedLines` and an anchor when one exists. No head-side range is
  manufactured for a function that no longer exists.
- Cancelled parses degrade to the module fallback; a changed line inside a
  syntax-error region is assigned to the module, never to a fabricated owner.
  Files with a Phase 2 `skipReason`, and files with no added/deleted lines,
  yield no symbols.

## Consequences

- `src/context/symbols.ts` implements the pure mapper (`mapFileSymbols`,
  `selectAnchorLine`) plus the snapshot-backed `mapChangedSymbolsForFile`
  (head `path@headSha`, old `oldPath@mergeBase`, worktree never read).
- `systemdesign.md` §5 carries the new `ChangedSymbol` shape; `src/diff`
  keeps emitting its Phase 2 placeholder untouched.
- P3-11 assembly consumes these symbols one-per-unit; P3-10 budgets them.
  Neither may reinterpret `deletedLines` as head-side lines.
