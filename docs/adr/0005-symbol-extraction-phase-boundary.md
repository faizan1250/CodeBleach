# ADR 0005 — Symbol extraction phase boundary: synthetic module symbol in Phase 2, Tree-sitter in Phase 3

## Status

Accepted (Phase 2 preflight).

## Context

`systemdesign.md` §4.1 describes tree-sitter changed-symbol mapping as Diff
Engine work, while the Phase 1 plan assigns Tree-sitter and AST parsing to
Phase 3 and Git diff parsing plus changed-line extraction to Phase 2. Both
statements cannot be build instructions at the same time. Phase 2 also has a
standing constraint of no new grammar/native dependencies.

## Decision

- Phase 2 produces exactly one coarse synthetic module-level `ChangedSymbol`
  per eligible supported source file with content hunks:
  `{ name: "<module>", kind: "module", startLine: 1, endLine: headLineCount,
  changedLines: addedHeadLineNumbers }`. Unsupported, deleted, binary,
  filtered, and rename-only files get `symbols: []`.
- No Tree-sitter, grammar package, or regex-based function detection in
  Phase 2. The placeholder never claims a function was identified.
- Phase 3 refines or replaces the synthetic symbol with AST-derived symbols
  in the context/review-unit path without re-parsing diffs or recomputing
  line positions. `ChangedSymbol` keeps its shape.
- `systemdesign.md` §4.1 and §13 are updated to match; the old tree-sitter
  wording no longer stands as a Phase 2 requirement.

## Consequences

- `DiffResult` stays the stable Phase 2→3 handoff: deterministic diff plus
  trustworthy line mappings, with a deliberately coarse symbol.
- `web-tree-sitter` and per-language grammars arrive in Phase 3 only.
