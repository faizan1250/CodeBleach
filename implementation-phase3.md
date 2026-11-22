# CodeBleach — Phase 3: Context Engine Implementation Plan

**Status:** Revised for implementation after Phase 2 GREEN merge; review the updated budget, time-limit, adapter, ADR, and packaging decisions before starting  
**Baseline:** Phase 2 GREEN merged to `main` at `20b4ea8` (verify the actual current `main` HEAD before starting)  
**Audience:** Claude Code / implementing agent  
**Scope:** Tree-sitter parsing, AST-based changed-symbol mapping, repository context retrieval, related callers/callees/tests, explicit repository rules, bounded context assembly, and `ReviewUnit` construction.

> Phase 3 makes CodeBleach understand the code surrounding a change. It does not call an LLM, generate review findings, validate findings, publish GitHub comments, or infer repository conventions.

---

## 0. Mandatory preflight

Before editing files:

1. Confirm the current branch is clean and based on the latest `main`.
2. Verify that Phase 2 commit `20b4ea8` is an ancestor of the current `main`; if `main` has advanced, use its actual current HEAD.
3. Read every file in `docs/adr/` and identify the next free ADR number. Do not assume `0011` is free and never overwrite or renumber an ADR.
4. Read the current versions of:
   - `systemdesign.md`
   - `implementation-phase2.md`
   - `src/types/diff.ts`
   - `src/types/context.ts` (if present)
   - `src/core/contracts.ts`
   - `src/core/pipeline.ts`
   - `src/core/run-artifact.ts`
   - `src/config/schema.ts`, `defaults.ts`, and `.reviewer.yml.example`
   - `src/diff/*` and `src/utils/spawn.ts`
   - `tests/helpers/git-repo.ts`
   - current Diff Engine and pipeline tests
5. Treat the actual current source contracts as authoritative. Some previously shared design drafts predate Phase 1/2 corrections. Do not copy stale definitions or move stage interfaces back into `src/types`.
6. Confirm the current `DiffEngine`, `ContextEngine`, `ReviewEngine`, and pipeline dependency contracts from `src/core/contracts.ts` and the current composition root.
7. Confirm the exact Phase 2 `DiffSkipReason` union includes the merged `unsupported-mode` value and that Phase 2 handles raw Git modes and early filtering.
8. Run the existing full check before making changes and record the baseline test count.

If the actual source differs from this document, prefer the latest merged contract and update this plan/`systemdesign.md` consistently. Do not silently change shared contracts.

---

## 1. Phase 3 goal and boundaries

### Goal

Implement the real `ContextEngine` so that a `DiffResult` becomes one or more context-rich, deterministic `ReviewUnit`s. Each unit represents a changed function, method, class, type declaration, or module-level change and includes the surrounding repository evidence needed by the future Review Engine.

The Context Engine must answer:

- Which semantic symbol contains the change?
- What is the complete relevant definition in the head commit?
- Which local types and imports does it depend on?
- Which functions does it call?
- Which tracked code paths call it?
- Which tests are most relevant?
- Which explicit repository rules apply to this file?
- Which context items fit the per-unit context budget?

### In scope

- `web-tree-sitter` runtime initialization and pinned WASM grammar assets.
- TypeScript, TSX, and JavaScript language adapters.
- Reading exact source snapshots from Git commits, not the working tree.
- AST extraction of functions, methods, classes, and TypeScript type declarations.
- Mapping additions and deletions to semantic symbols.
- Deletion-only anchoring to a valid surviving head-side line.
- Best-effort relative import and type resolution.
- Best-effort callee and caller discovery.
- Related test-file discovery and ranking.
- Explicit `.reviewer.yml` rules in each applicable `ReviewUnit`.
- Deterministic context ranking and per-unit token budgeting.
- Pipeline wiring and replayable run artifacts.
- Unit, integration, and cross-platform tests.

### Explicitly out of scope

Do not implement:

- OpenCode API calls or any real LLM provider requests.
- Review prompts or AI finding generation (Phase 4).
- Finding validation (Phase 5; deterministic-only v1, no semantic LLM — see ADR 0028).
- Inferred repository conventions (Phase 6).
- GitHub comment publishing or PR Actions workflow (Phase 7).
- Evaluation harness, prompt-quality evaluation, or incremental re-review (Phase 8).
- Vector databases, embeddings, persistent repository indexes, or background services.
- TypeScript compiler/type-checker-grade symbol resolution.
- Package-manager dependency graph resolution, package exports, or cross-repository context.
- Python, Go, or other non-TS/TSX/JS language support.
- Automatic code execution, tests, builds, or package scripts from the reviewed repository.

Keep this a personal, single-user, CLI-first tool. No SaaS, server, database, microservices, or multi-agent architecture.

---

## 2. Phase 2 contracts that Phase 3 must preserve

Phase 2 is complete and merged. Do not redesign its Diff Engine.

### 2.1 Input contract

The Context Engine consumes the current shared `DiffResult` returned by `GitDiffEngine`. It must use the actual existing `src/core/contracts.ts` stage signature rather than inventing a second interface.

The important data already supplied by Phase 2 includes:

- Full `baseSha`, `headSha`, and `mergeBase`.
- Repository-relative POSIX paths.
- `ChangedFile.status`, `path`, and `oldPath`.
- File language (or `null` when unsupported).
- File skip reason, including `unsupported-mode`.
- Ordered `DiffHunk[]` and `DiffLine[]` with old/new line numbers and diff positions.
- Sorted unique `commentableLines`.
- A coarse synthetic module-level symbol for supported files with content changes.

### 2.2 Do not move AST work into the Diff Engine

Phase 2 intentionally leaves a coarse synthetic module symbol in `ChangedFile.symbols`.

Phase 3 performs AST extraction in `src/context` and creates AST-derived `ReviewUnit.symbol` values. Do not add Tree-sitter imports to `src/diff`. Do not mutate the `DiffResult` object or make `GitDiffEngine` responsible for language parsing.

`ChangedFile.symbols` remains the Phase 2 compatibility/diagnostic representation unless a separately reviewed ADR establishes a different design. The AST-derived symbols live in the Context Engine output.

### 2.3 Exact commit snapshots

**Never read source code from the developer's working tree.** The working tree may contain uncommitted or staged changes that are not part of the PR.

Use Git objects from the exact commits represented by `DiffResult`:

- Current/head source and repository search: `DiffResult.headSha`.
- Old-side source used to understand deletions: `DiffResult.mergeBase`, because Phase 2 compares the merge base to the head.
- A rename uses `oldPath` in the merge-base tree and `path` in the head tree.

This keeps AST line ranges aligned with the diff's old/new coordinate systems.

### 2.4 Skipped and unsupported files

Do not create `ReviewUnit`s for files with a `skipReason`, including:

- `binary`
- `deleted`
- `ignored`
- `lockfile`
- `generated`
- `too-large`
- `unsupported-mode`

Confirm the exact union from the current code instead of copying this list blindly.

Files with `language: null` but no skip reason may still receive a conservative module-level fallback unit using diff hunks and nearby head-side source text. They must not be parsed with the wrong grammar.

Empty new files and rename-only files with no content hunks should not produce fabricated review units.

---

## 3. Target architecture

```mermaid
flowchart TD
  D[DiffResult from Phase 2] --> F[Eligible changed files]
  F --> S[Git snapshot reader]
  S --> H[Head snapshot at headSha]
  S --> B[Old snapshot at mergeBase]
  H --> P[Tree-sitter parser runtime]
  B --> P
  P --> A[Language adapters: TS / TSX / JS]
  A --> X[AST definitions and changed-symbol mapping]
  X --> I[Imports and type resolution]
  X --> C[Callee discovery]
  X --> R[Caller discovery]
  X --> T[Related test discovery]
  I --> K[Context collection]
  C --> K
  R --> K
  T --> K
  K --> Q[Explicit repository rules]
  Q --> Z[Deterministic ranking and budget]
  Z --> U[ReviewUnit[]]
  U --> O[Pipeline artifact]
```

### Proposed module responsibilities

Keep the actual names aligned with the current tree; extend existing files instead of duplicating functionality.

```text
src/context/
  runtime.ts                 # web-tree-sitter init, grammar loading and parser lifecycle
  parser.ts                  # parse one source snapshot; syntax diagnostics
  language.ts                # LanguageAdapter interface and registry
  adapters/
    typescript.ts            # TypeScript grammar queries and normalization
    tsx.ts                   # TSX grammar queries and normalization
    javascript.ts            # JavaScript grammar queries and normalization
  snapshot.ts                # head/merge-base Git object reader and tracked-file index
  symbols.ts                 # definitions, symbol identity and changed-line mapping
  imports.ts                 # relative import and exported type resolution
  calls.ts                   # local/imported callee discovery
  callers.ts                 # candidate search + AST call-site verification
  tests.ts                   # related test discovery
  rules.ts                   # explicit config rule selection
  rank.ts                    # context relevance score and stable ordering
  budget.ts                  # approximate token estimate and truncation/selection
  retrieve.ts                # assemble ContextItems for one symbol
  engine.ts                  # ContextEngine implementation
```

This is a suggested responsibility map, not a mandate to create every file. If the repository already has equivalent modules, extend them. Avoid one-file monoliths and avoid duplicate abstractions.

---

## 4. P3-00 — Contract audit, dependency spike, packaging, and ADRs

### Objective

Prove that the selected Tree-sitter runtime, grammar WASM assets, and asset-loading strategy work with the repository's pinned Bun version on Ubuntu, macOS, and Windows before building the Context Engine around them.

### Tasks

1. Inspect `package.json`, `bun.lock`, `.bun-version`, TypeScript configuration, existing build scripts, and current CLI entry points.
2. Verify the currently supported `web-tree-sitter` package and its installed type declarations. Pin the exact version.
3. Select compatible precompiled WASM grammars for TypeScript, TSX, and JavaScript. Include JSX only if Phase 2 language detection supports it.
4. Verify parser ABI compatibility between the runtime and every grammar. Do not assume an older prebuilt grammar can load in the selected runtime.
5. Pin exact grammar versions or exact grammar artifact checksums. Record provenance and license notices.
6. Decide whether grammar WASM files are provided by pinned npm packages or stored in a controlled project asset directory. They must be available offline after dependency installation; never download them at runtime.
7. Add a minimal Bun spike that initializes the runtime, loads each grammar, parses an in-memory sample, and verifies a known AST node.
8. Run the spike in the normal `bun run` environment on all three operating systems.
9. **Packaging spike:** determine whether CodeBleach intends to support `bun build --compile` as a distribution mode. Regardless of whether it is supported immediately, prove how the grammar WASM assets behave in a compiled smoke executable:
   - Build a minimal CLI with the selected runtime and all grammar assets included using Bun's supported asset mechanism (for example, `--asset` / `compile.assets`).
   - Run the executable from a working directory outside the repository and outside the build directory.
   - Verify it loads all three grammars and parses the same samples without reading assets from the original source checkout, relying on the current working directory, or downloading anything.
   - Verify the runtime can read embedded assets through the path/API selected by the spike. If direct path loading is incompatible with embedded assets, load the asset bytes using the supported Bun file API and pass the bytes to the Tree-sitter language loader.
   - If the compiled executable is not a supported product target, record that decision and the supported adjacent-asset/distribution layout explicitly; do not leave packaging behavior ambiguous.
10. Confirm the grammar assets are included in the repository's normal package/build process and are not accidentally excluded by `.gitignore`, package files, or CI packaging.
11. Record the runtime version, grammar versions/ABIs, asset provenance, normal-runtime loading strategy, compiled-executable result, and license notices.
12. Run the smoke test on Ubuntu, macOS, and Windows.

### Runtime and packaging constraints

- Initialize the WASM runtime once per process.
- Load each grammar once and cache the `Language` object for the process lifetime.
- Do not share one mutable parser concurrently across asynchronous operations.
- Parser instances may be pooled only if bounded and justified by tests/measurements; start with safe sequential parser use.
- Dispose parser/tree/query resources using the APIs exposed by the exact pinned `web-tree-sitter` version.
- Do not compile grammars during normal review execution.
- Do not perform runtime network requests.
- Resolve grammar assets relative to the module/executable asset location, never relative to `process.cwd()`.
- Keep the `bun run` and compiled-executable asset-loading paths covered by tests if both are supported.

### Version-sensitive parsing API

The pinned `web-tree-sitter` API exposes a parse `progressCallback` that can cancel parsing by returning `true`; a cancelled parse returns `null`. Query execution also supports a time limit/progress option in current declarations. Verify the exact signatures in the pinned package declarations during this spike and use those APIs rather than relying on deprecated parser timeout properties. A cancelled parser must be reset before it is reused for another document.

References to verify against the exact pinned package:
- [web-tree-sitter binding README and WASM compatibility](https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/README.md)
- [web-tree-sitter type declarations](https://app.unpkg.com/web-tree-sitter@0.25.3/files/web-tree-sitter.d.ts) (version is illustrative; use the pinned release)
- [Bun standalone executable asset embedding](https://bun.sh/docs/compiler/executables)

### ADRs expected

Inspect the actual ADR directory first. Do not assume a number is free. Expect separate decisions for:

1. Tree-sitter runtime, grammar ABI/version pinning, and WASM asset packaging (one ADR).
2. AST-derived symbol identity and old-side deletion/anchor contract (one ADR in P3-04).
3. Context budget, truncation, and runtime/parse deadlines (one ADR in P3-10).

These are three distinct decisions; do not force them into one oversized ADR. If an existing ADR already covers one of them, update or reference it rather than duplicating it.

### Acceptance criteria

- Bun initializes the selected runtime on Ubuntu, macOS, and Windows.
- All selected grammar assets load and parse known in-memory samples.
- Grammar/runtime ABI compatibility is verified and recorded.
- No runtime download or native compilation is required.
- Exact runtime and grammar versions are locked.
- The compiled smoke executable loads assets from its bundled/declared package location when compiled distribution is supported.
- The smoke executable works when invoked from an unrelated current working directory.
- Asset licensing and provenance are documented.
- ADR decision(s) are written without overwriting existing ADRs.

## 5. P3-01 — Tree-sitter runtime and in-memory parse result

### Objective

Build a reliable parser runtime shared by all language adapters. This ticket must be independently testable **without the Git snapshot reader**, which is P3-03.

### Input boundary

P3-01 accepts source text directly in memory:

```ts
parseSource({
  source: "export function greet() { return 'hi'; }",
  language: "typescript",
  filePath: "src/greet.ts",
  budget: parseBudget,
});
```

Do not import or call the P3-03 snapshot reader in P3-01 tests. The production Context Engine will connect snapshot strings to this parser after P3-03 is complete.

### Tasks

1. Add a runtime abstraction that owns one-time WASM initialization.
2. Register TypeScript, TSX, and JavaScript grammar assets.
3. Load grammar assets lazily on first use or eagerly once at Context Engine startup; choose one approach and test it.
4. Cache loaded language objects for the process lifetime.
5. Create and safely manage parser instances.
6. Route a supplied `Language` value to the corresponding adapter; do not independently reinterpret extensions when Phase 2 already supplied the language.
7. Add the strict `.reviewer.yml` context time-limit settings and resolved defaults needed by the parser/runtime: `max_run_time_ms`, `max_parse_time_ms`, and `max_total_parse_time_ms` with the bounds defined in §14. Add tests for defaults, bounds, and cross-field validation now; P3-10 adds the token-budget field later.
8. Parse the supplied in-memory UTF-8 source string.
9. Return a normalized internal parse result with:
   - language
   - internal tree handle (never serialized)
   - source text/line index
   - syntax error count
   - missing-node count
   - error-node ranges
   - parse duration
   - whether parsing was cancelled by a budget
10. Keep Tree-sitter node/tree objects internal to `src/context`. Never put WASM objects, parser objects, or nodes in `ReviewUnit`, shared public types, or JSON artifacts.
11. Distinguish grammar/runtime failures from ordinary source syntax errors and parse-budget cancellation.
12. Add parser time-budget enforcement using the selected binding's supported progress/cancellation API. See §14 for the exact budget policy.

### Byte offsets and Unicode

Tree-sitter positions use zero-based rows and byte-oriented offsets/columns. JavaScript string indexes use UTF-16 code units. Do not slice a JavaScript string with Tree-sitter byte offsets without conversion.

Create and test a source-slicing helper that safely converts byte offsets to JS string offsets, or use a supported node-text accessor from the pinned binding. Add a fixture with non-ASCII characters (for example, an emoji and accented comment text) before a changed function to verify extracted source and line positions remain correct.

Line numbers exposed outside `src/context` must be 1-based and inclusive, matching Phase 2's `DiffLine` contract.

### Syntax errors and partial parsing

Tree-sitter is error-tolerant. Do not reject an entire repository because one changed source file has an `ERROR` or `MISSING` node.

- If the grammar loads and a tree is returned, attempt extraction from valid subtrees.
- Record syntax diagnostics and ranges through the injected logger/context diagnostics.
- If an affected changed range intersects an error region and reliable symbol ownership cannot be established, fall back to a module-level ReviewUnit with the diff and nearby source context, provided the run budget permits.
- If parsing is cancelled by the per-file parse budget, reset the parser before reuse and use the documented module-level fallback; record the timeout.
- If the cumulative parse budget is exhausted, stop starting AST parses and use only the conservative diff-based fallback for remaining files, subject to the overall wall-clock deadline.
- If the overall Context Engine deadline expires, stop processing new work and return a partial result with explicit diagnostics; do not label it complete.
- A missing/corrupt/incompatible grammar WASM asset or runtime initialization failure is a fatal `PARSE_FAILED` error; do not silently return zero symbols.
- A malformed individual source file is a per-file degraded result, not a whole-PR failure.

### Tests

- Runtime initialization occurs once per engine/run as designed.
- Each grammar loads and parses a known in-memory sample.
- Repeated files do not reload the same grammar.
- Parser instances are not used concurrently when mutable.
- Unicode before/inside declarations does not corrupt text extraction or line mapping.
- CRLF, LF, BOM (if supported), and no-final-newline cases behave deterministically.
- `ERROR`/`MISSING` nodes are recorded without crashing.
- A missing grammar asset returns a clear `PARSE_FAILED` error.
- Per-file parse cancellation returns a degraded parse result rather than a false successful empty tree.
- Cumulative parse budget prevents starting additional parses.
- Overall deadline cancels parsing and subprocess work using remaining time.
- Tree-sitter query timeout is enforced using the pinned version's query timeout API.
- A cancelled parser is reset before it is reused.
- Unit tests pass source strings directly and do not depend on P3-03 Git snapshot code.

## 6. P3-02 — LanguageAdapter and normalized AST model

### Objective

Keep grammar-specific node types out of the rest of the Context Engine and choose one adapter mechanism.

### One adapter mechanism: method-based adapters

Use a method-based `LanguageAdapter`. Do **not** expose both a public `queries` object and separate `extract*()` methods. That duplicates responsibility and creates two competing ways to describe extraction.

Each adapter owns its grammar-specific query strings, compiled queries, node traversal, and normalization internally. The rest of the Context Engine calls only the normalized adapter methods.

Illustrative interface:

```ts
export interface LanguageAdapter {
  readonly language: Language;
  readonly extensions: readonly string[];
  readonly grammarId: string;
  extractDefinitions(tree: InternalTree, source: SourceText): Definition[];
  extractImports(tree: InternalTree, source: SourceText): ImportReference[];
  extractCalls(node: InternalNode, source: SourceText): CallReference[];
  extractTypes(tree: InternalTree, source: SourceText): TypeDefinition[];
  extractCallSites(
    tree: InternalTree,
    source: SourceText,
    target: ResolvedTarget,
  ): CallSite[];
  getTestFileScore(path: string): number;
  getSymbolName(node: InternalNode, source: SourceText): string | null;
}
```

`InternalTree`, `InternalNode`, `SourceText`, and `ResolvedTarget` are illustrative internal types, not public shared contracts. Do not export Tree-sitter library types from `src/types`.

### Adapter implementation rule

- Query strings and compiled queries live inside each adapter module.
- A method may use a Tree-sitter query internally or direct AST traversal internally; callers do not need to know which.
- Do not store a second declarative query registry on the adapter interface.
- Reuse normalized extraction helpers where grammar node structures are genuinely compatible, but keep TS/TSX/JS differences explicit and tested.

### Normalized internal structures

Define internal normalized records for:

- `Definition`: name, symbol kind, declaration range, full range, container, signature/header text, full text, export status, export kind (`named` or `default`), identity key.
- `ImportReference`: source specifier, import kind (named/default/namespace/type-only/side-effect), local name, imported name, path/range.
- `ExportReference`: named/default/star re-export, source specifier, exported name, imported/original name, declaration range.
- `CallReference`: callee expression, root identifier/member name, call range, containing definition.
- `TypeDefinition`: exported name, declaration range, text, source file, type kind.
- `CallSite`: caller definition identity, call range, exact identifier/member structure, resolved import binding where known.

Do not let the Review Engine or public types depend on grammar-specific node names.

### Node coverage

At minimum, extract and normalize:

- Function declarations and generator function declarations.
- Default-exported function declarations.
- Class declarations (including supported TypeScript abstract classes).
- Class methods and constructors.
- Arrow functions and function expressions assigned to variable declarations.
- Object/class methods where their containing symbol is stable and identifiable.
- Interfaces, type aliases, and enums as type declarations.
- Import and export declarations, including re-exports.
- Direct function calls and member-expression calls.

Do not try to model every possible JavaScript callback or dynamic invocation. Unsupported or ambiguous constructs must be represented conservatively and must not produce invented relationships.

### Symbol ownership rules

- A changed line inside a method belongs to the most-specific method symbol; the containing class name goes in `container`.
- A changed line inside a nested function belongs to the innermost function.
- A class-level change outside a method (for example, class heritage or a class field) can belong to the class symbol.
- A changed top-level declaration that is not a supported function/class/type belongs to a synthetic module-level symbol.
- Avoid emitting both a method unit and a duplicate class unit for the same method-body change.
- If one symbol contains changes from multiple hunks, merge them into one symbol/unit.
- If one file has changes in several independent functions, emit a separate ReviewUnit for each changed symbol.

### Tests

Use fixtures with top-level functions, named/default exports, async/generator functions, class methods, nested functions, arrow functions, object methods, interfaces, aliases, enums, comments/string false positives, multiple hunks, and changes across multiple symbols. Assert exact names, kinds, containers, export kinds, and 1-based inclusive line ranges.

## 7. P3-03 — Git snapshot reader

### Objective

Read source files from exact Git commits in a safe, deterministic way.

### Required behavior

Implement a small Context Engine repository reader using the existing safe Git subprocess helper. Do not create a second subprocess abstraction.

The reader must support:

- Listing tracked files at a commit.
- Reading a blob from a commit snapshot.
- Reading the old snapshot at `mergeBase`.
- Reading the head snapshot at `headSha`.
- Looking up blob size before reading.
- Searching candidate occurrences in the head commit.

Recommended approach:

1. Use `git ls-tree -r -z --full-tree <commitSha>` to construct a path-to-mode/type/OID index for the commit.
2. Parse paths from NUL-delimited output. Split the metadata/path boundary at the first tab only; repository paths can contain spaces, tabs, and newlines.
3. Only consider regular blob objects for source parsing. Never read symlinks or gitlinks as normal source.
4. Check object size before retrieving blob contents.
5. Read by object ID (`git cat-file blob <oid>` or a carefully implemented `cat-file --batch` reader), not by concatenating untrusted paths into a revision expression.
6. Cache the result by object ID for the duration of one Context Engine run.
7. Bound each read and the total in-memory content retained per run.
8. Normalize repository paths to `/`; do not pass them through host path normalization when doing Git path matching.

Do not maintain a persistent repository index in Phase 3.

### Snapshot invariants

- Head-side definitions, imports, callers, and tests come from `headSha`.
- Old-side definitions used for deleted lines come from `mergeBase`.
- Renamed files use `oldPath` at `mergeBase` and `path` at `headSha`.
- Working-tree modifications must never affect Context Engine output.
- Untracked files must never be included.
- Files skipped by Phase 2 must not be loaded as review candidates.

### Tests

- Modify the worktree after committing; Context Engine still reads the committed head blob.
- Add an untracked file containing a matching function name; it is not returned as a caller/test.
- Rename resolution reads old path from merge base and new path from head.
- Symlink and gitlink entries are not loaded as source.
- Missing object returns a clear `GIT_FAILED` error.
- Blob-size cap is applied before reading.
- Unusual paths are parsed correctly.

---

## 8. P3-04 — AST-based changed-symbol mapping

### Objective

Replace Phase 2's coarse synthetic module placeholder in the `ReviewUnit` path with AST-derived changed symbols, without modifying `GitDiffEngine` or mutating `DiffResult`.

### Mapping additions

For each eligible supported source file:

1. Parse the head snapshot at `headSha`.
2. Extract normalized definitions.
3. For each `DiffLine` with `kind === "add"` and non-null `newLine`, find the smallest/most-specific supported symbol whose head range contains that line.
4. Assign the line to that symbol's `changedLines`.
5. If the line is not inside a supported declaration, assign it to the module-level symbol.
6. Merge lines from all hunks that belong to the same symbol.
7. Deduplicate and sort line arrays.

Do not use deleted lines as head-side `changedLines`.

### Symbol identity

Create a deterministic internal identity using, at minimum:

- normalized symbol kind
- symbol name
- container chain
- normalized file path

Line ranges may be used as a disambiguator, but should not be the only identity when comparing base and head versions because lines move.

For overloaded functions or repeated same-name declarations, add a stable occurrence discriminator based on declaration order/structural context. Do not pretend best-effort name matching is a type checker.

### Mapping deletions — required in Phase 3

The Phase 2 E05 fixture deliberately leaves a deletion-only hunk with `ChangedFile.symbols` containing the synthetic module placeholder and `changedLines: []`. Phase 3 must now map that deletion to a semantic symbol where possible.

The existing `ChangedSymbol` contract needs an explicit distinction between old-side deletions and head-side comment anchors. Do not overload `changedLines` with deleted old-line numbers.

Recommended additive contract:

```ts
export type SymbolKind = "function" | "method" | "class" | "type" | "module";

export interface ChangedSymbol {
  name: string;
  kind: SymbolKind;
  container?: string;
  /** 1-based inclusive range in the head snapshot. */
  startLine: number;
  endLine: number;
  /** Added lines in the head snapshot. */
  changedLines: number[];
  /** Deleted line numbers in the merge-base snapshot. */
  deletedLines?: number[];
  /** 1-based, commentable head-side line used to anchor deletion-only review. */
  anchorLine?: number;
}
```

The exact placement of this type must follow the current ownership in `src/types`; do not duplicate it between `diff.ts` and `context.ts`.

### Why `type` is included

Interface, type-alias, and enum changes need a meaningful symbol rather than being mislabeled as a class or forced into a module unit. `ContextItem.kind: "type"` already exists in the architecture; use the matching semantic symbol kind for changed type declarations.

### Deletion mapping algorithm

For each `DiffLine` with `kind === "del"` and non-null `oldLine`:

1. Parse the old file snapshot at `mergeBase` using the same language adapter.
2. Find the most-specific old-side symbol containing the deleted line.
3. Attempt to match it to a head-side symbol using kind + name + container identity, not raw line numbers alone.
4. If a matching head symbol exists, associate the deleted old line with it.
5. If the old symbol was entirely removed and has no head counterpart, associate the deletion with the module-level symbol for the surviving head file.
6. Keep deleted line numbers in `deletedLines`; never add them to `changedLines`.
7. Select a surviving head-side anchor from hunk context lines (`kind === "ctx"`, `newLine !== null`) that is also in `ChangedFile.commentableLines`.
8. Prefer the nearest context line inside the matched head symbol. If none exists, use the nearest eligible same-file context line from that hunk. Use a deterministic tie-breaker: prefer the following line when distances are equal, then the lower new-side line number.
9. Set `anchorLine` only when a valid head-side comment target exists.
10. If there is no valid anchor (for example, no surviving commentable line), keep the semantic symbol/deletion metadata but leave `anchorLine` absent. Do not invent a line.

For a symbol containing both added and deleted lines:

- `changedLines` contains only added head-side line numbers.
- `deletedLines` contains only old-side line numbers.
- `anchorLine` is generally unnecessary because added lines already provide current-side targets; set it only if the later contract specifically needs it.

For a pure deletion within a surviving function, create a ReviewUnit for that function with `deletedLines` and an `anchorLine` on a surviving context line.

For a fully deleted function, use the module-level fallback if no matching head symbol exists. Do not manufacture a head-side function range for a function that no longer exists.

### Contract and ADR

This additive contract change requires one ADR, using the next free number after inspecting `docs/adr/`. The ADR should document:

- `changedLines` remains head-side additions only.
- `deletedLines` uses merge-base/old-side coordinates.
- `anchorLine` is a head-side commentable line.
- `SymbolKind` includes `type` for interface/type alias/enum declarations.
- `startLine`/`endLine` are head-side inclusive coordinates.
- Entirely removed declarations fall back to a surviving module-level symbol when necessary.

Update `systemdesign.md` §5 and §4.2, the shared types, barrel exports, and all relevant tests together.

### Tests

- Addition inside a function maps to that function.
- Addition inside a class method maps to the method, with class as container.
- Changes across multiple methods create distinct units.
- Multiple hunks in one function merge into one symbol.
- Module-level addition creates a module symbol.
- Interface/type alias/enum changes create `type` symbols.
- Replacement records both added and deleted line arrays.
- E05 deletion-only guard maps to the surviving function and a valid head-side `anchorLine`.
- Fully deleted method falls back to a module symbol with `deletedLines` and a valid anchor if one exists.
- No surviving anchor leaves `anchorLine` undefined.
- Lines inside comments or strings do not become declaration symbols.
- Syntax errors near a changed hunk trigger safe fallback, not fabricated ownership.

---

## 9. P3-05 — Import and type-definition resolution

### Objective

Retrieve the relevant imported definitions and types for each changed symbol.

### Initial supported resolution

Resolve relative imports only:

- `./module`
- `../shared/types`
- relative re-exports
- named imports
- default imports
- namespace imports where the requested type/declaration can be identified
- `import type` and inline type imports

Use the head commit snapshot only.

### Resolution algorithm

1. Extract import declarations from the changed file AST.
2. Resolve the specifier relative to the importing file's repository-relative directory.
3. Check deterministic candidates using the current Phase 2 language policy, for example:
   - exact file path
   - `.ts`
   - `.tsx`
   - `.js`
   - supported `index` files
4. Confirm each candidate exists in the head tree index and is a regular source blob.
5. Parse the target through its language adapter.
6. Find the imported declaration/export and extract only the relevant type/interface/class/function definition.
7. Add a `ContextItem` with `kind: "type"` (or `definition` where it is executable code), accurate file/line range, score, token estimate, and a reason such as `relative named import`.
8. Cap the number of imported definitions per ReviewUnit.

### Explicit limitations

Do not attempt to resolve in Phase 3:

- `tsconfig.json` path aliases.
- `baseUrl` mappings.
- Package exports or `node_modules` dependencies.
- Dynamic imports whose target cannot be resolved statically.
- Runtime dependency injection.
- Full TypeScript type checking.

Unresolved imports are normal best-effort misses. Log a debug/warn diagnostic without failing the whole Context Engine run.

### Tests

- Named, default, namespace, and type-only relative imports.
- Extension omitted and index-file resolution.
- Relative re-export resolution.
- Unresolved import gracefully omitted.
- Package import is not mistaken for relative import.
- Path traversal outside the repository is rejected.
- Imported target is read from `headSha`, not worktree.
- A type alias/interface used by the changed symbol is included.
- A module with many exports is not copied wholesale; only relevant declarations are included.

---

## 10. P3-06 — Callee discovery

### Objective

Find functions and methods called by each changed symbol, then retrieve their definitions as context.

### Algorithm

1. Use the adapter's call-expression query inside the changed symbol's AST node.
2. Normalize each callee expression:
   - direct identifier (`parseUser`)
   - member expression (`client.fetch`)
   - namespace import member (`utils.normalize`)
   - constructor call (`new Client`) where resolvable
3. Resolve local declarations in the same file first.
4. Resolve imported declarations only when the import mapping is unambiguous.
5. Retrieve target definition/signature from the head snapshot.
6. Deduplicate by target symbol identity.
7. Rank and cap callees.

### Requirements

- Do not treat identifiers inside strings/comments as calls.
- Do not resolve arbitrary same-name functions across unrelated files.
- Do not claim certainty when a member expression is ambiguous.
- Do not execute code to discover dynamic dispatch.
- Recursive calls should not cause infinite traversal.
- Avoid including the entire imported module when only one definition is needed.

### Tests

- Local direct function call.
- Imported named function call.
- Imported namespace call.
- Class method call where the receiver can be mapped.
- Constructor call.
- Calls inside nested callbacks.
- Identical name in unrelated module is not selected without import evidence.
- String/comment mentions are ignored.
- Duplicate calls create one context item.
- Unresolved/dynamic call is safely omitted.

---

## 11. P3-07 — Caller discovery

### Objective

Find code paths that call a changed function, method, or exported symbol, including statically resolvable default imports and barrel re-exports.

### Candidate search

Use the exact head commit, not the working tree. Use `git grep` or an equivalent safe search over tracked head-side files to find candidate occurrences.

Use argument arrays and safe pattern handling. For identifier searches, prefer fixed-string word matching rather than interpreting symbol names as regular expressions. Put code-derived patterns in a `-e` argument and use `--` before pathspecs.

Only search supported source paths and impose a maximum candidate count. A candidate hit is not automatically a caller.

### Import/export binding resolution

Do not rely only on grep for the original exported symbol name. That misses valid callers that import a default export under a local name or call a symbol through a barrel re-export.

Implement bounded, static resolution for:

- Named imports: `import { original as local } from "./module"`.
- Default imports: `import local from "./module"` when the target has an identifiable default export.
- Namespace imports: `import * as ns from "./module"` when the call member resolves to a known exported name.
- Explicit named barrel re-exports: `export { original as publicName } from "./module"`.
- Default barrel re-exports: `export { default as publicName } from "./module"` and supported default forwarding forms.
- Static `export * from "./module"` only when the target symbol can be resolved unambiguously.

Build a small per-run module/export map from the head snapshot. For candidate text search, search not only the original declaration name but also every statically resolved local binding name at the importing call site (for example, `local` in `import local from "./module"` and `publicName` in `import { publicName } from "./barrel"`). Map each candidate alias back to the same resolved target before AST verification. Do not assume a grep for the original export name can find aliased call sites. Resolve chains with:

- A visited-module/export set to prevent cycles.
- A maximum re-export depth (default 8).
- Existing candidate/file-count caps.
- A maximum number of alias paths retained per target; deduplicate identical target/binding pairs.
- A deterministic tie-breaker.

If `export *` or multiple barrel paths produce ambiguous targets, do not guess. Record an unresolved/ambiguous diagnostic and omit that relationship.

Do not resolve package imports, `node_modules`, `tsconfig` aliases, dynamic imports, or conditional/runtime exports in this phase.

### AST verification

For each candidate file:

1. Load its head-side blob.
2. Parse using its adapter.
3. Inspect call-expression nodes only.
4. Verify the identifier/member expression resolves to the target through the resolved import/export binding map.
5. Exclude declaration sites, comments, strings, object keys, and unrelated same-name identifiers.
6. Identify the enclosing caller function/method.
7. Extract a focused caller definition or caller snippet.
8. Deduplicate and cap results.

### Resolution quality

Caller resolution is best-effort and static. It is not a TypeScript type checker. Preserve evidence for why a caller was accepted (`same-file direct call`, `named import alias`, `default import`, `barrel re-export`, etc.). Never report a speculative caller as confirmed.

Known limitations to document:

- Dynamic imports and runtime dependency injection are not resolved.
- Package exports and `node_modules` are not resolved.
- `tsconfig` path aliases are not resolved.
- Ambiguous `export *` chains are omitted rather than guessed.
- Re-export chains deeper than the configured internal depth cap are omitted with a diagnostic.

### Tests

- Same-file direct caller.
- Cross-file named import caller.
- Aliased named import caller.
- Default import caller (`import local from ...`) resolving to a default export.
- Default export called through an explicit barrel re-export.
- Named symbol called through multiple explicit barrel re-export hops.
- Namespace import caller where statically resolvable.
- `export *` caller only when the target is unambiguous.
- Ambiguous `export *` is not guessed.
- Re-export cycle terminates safely.
- Comments/strings do not count.
- Declaration does not count as a call.
- Same-name unrelated function is not selected.
- Caller and re-export depth caps are respected and reported.
- Deleted or untracked worktree-only callers are not returned.

## 12. P3-08 — Related test retrieval

### Objective

Retrieve a small set of tests relevant to each changed symbol/file.

### Test-file heuristics

Support conventional patterns such as:

- `*.test.ts`, `*.test.tsx`, `*.test.js`
- `*.spec.ts`, `*.spec.tsx`, `*.spec.js`
- files under `__tests__/`, `tests/`, or `test/`
- colocated test files with matching base names

Use the language adapter's test-file heuristic. Do not assume every file in a `test` directory is related.

### Ranking order

Rank candidates by evidence:

1. Test imports the changed module through a resolvable relative import.
2. Test imports/calls the exact changed symbol or a resolved alias.
3. Test references the exact symbol as an AST identifier in executable test code.
4. Test file is colocated and shares a clear base-name relationship.

A plain substring mention in a comment or string alone is weak evidence and must not rank above an AST-confirmed import/call.

### Context item

Extract the relevant test block or enclosing test function, not the entire test file. Include enough surrounding setup to understand the test. Preserve the source path and 1-based line range.

### Limits

- Cap related tests per ReviewUnit.
- Cap candidate files scanned.
- Do not load snapshots, generated test output, lockfiles, or ignored files.
- Do not execute tests.
- Do not infer test coverage completeness.

### Tests

- Test imports changed module.
- Test imports changed function directly.
- Test imports through a default export.
- Test imports through an explicit barrel re-export.
- Test mentions function but does not import it.
- Same-name symbol in unrelated test is ranked lower or omitted.
- Comments/string-only mentions do not count as strong evidence.
- Multiple tests are deterministically ranked and capped.
- Head snapshot is used, not worktree state.

---

## 13. P3-09 — Explicit repository rules

### Objective

Attach applicable explicit `.reviewer.yml` rules to every ReviewUnit.

This is not inferred convention discovery.

### Requirements

1. Read rules from the already validated `ResolvedConfig`.
2. Match optional rule `paths` against the repository-relative `ChangedFile.path` using the existing glob semantics.
3. Rules without path constraints apply repository-wide.
4. Preserve rule IDs and text exactly after config validation.
5. Preserve explicit kind/severity metadata.
6. Keep rule ordering deterministic (configuration order, unless current contract specifies another order).
7. Add a `ContextItem` with `kind: "rule"` only if the current model needs the text repeated in context; avoid duplicating the same rule both in `ReviewUnit.rules` and `context` unless the existing contract clearly requires it.
8. `ReviewUnit.rules` must contain only explicit rules in Phase 3.
9. Do not infer naming, error-handling, architecture, or testing conventions.

### Tests

- Repository-wide rule applies to every relevant file.
- Path-scoped rule applies only to matching paths.
- Non-matching rule is omitted.
- Multiple rules preserve deterministic ordering.
- Rule IDs remain unchanged.
- Empty rules produce an empty array.
- Inferred rules are not generated.

---

## 14. P3-10 — Context ranking, token budgeting, and run limits

### Objective

Build compact, relevant ReviewUnits with deterministic ordering and enforce both per-unit context budgets and per-run time budgets.

The budget includes **all content that Phase 4 will send**, not only optional context items. Explicit rules are mandatory but must still be counted.

### Candidate context kinds

Implement in Phase 3:

- `definition`
- `type`
- `callee`
- `caller`
- `test`
- `rule` only if the existing contract genuinely requires rule text to be duplicated in `context`; otherwise keep explicit rules in `ReviewUnit.rules` only.

Do not implement `config`, `similar`, or inferred conventions.

### Deterministic ranking

Use deterministic weights and proximity. Starting base weights:

| Context kind | Base weight |
|---|---:|
| Changed symbol definition | 100 |
| Direct imported type/definition | 85 |
| Direct callee | 75 |
| Direct caller | 65 |
| Related test | 55 |

Apply proximity multipliers:

- same file: `1.00`
- direct relative import: `0.85`
- AST-confirmed cross-file caller: `0.75`
- same-directory test heuristic only: `0.55`

A reference-count decay may be applied to prevent ubiquitous symbols from flooding context. The formula and tie-breakers must be deterministic and unit-tested. These are initial defaults, not learned values.

Sort by:

1. score descending
2. context kind priority
3. path lexicographically
4. start line ascending
5. stable item ID

### Token estimator

No LLM provider exists yet, so Phase 3 cannot use provider-reported token counts.

Implement a deterministic, conservative token estimator behind a small interface. Use a documented approximate heuristic (for example, UTF-8 byte/character estimate plus a safety margin). Do not claim exact model token counts. This estimator is replaceable in Phase 4.

The estimate must:

- Be stable for identical text.
- Be non-negative.
- Include all review payload text: diff hunks, definition, explicit rules, other context items, and fixed serialization/prompt framing reserve.
- Count `ReviewUnit.rules` even though they are not `ContextItem`s.
- Count a diff truncation marker and any framing metadata.

### Configuration

P3-01 adds the three runtime/parse limits to the strict `.reviewer.yml` `context` section. P3-10 adds the token-budget field. The fully resolved section after both tickets is:

```yaml
context:
  max_tokens_per_unit: 12000
  max_run_time_ms: 120000
  max_parse_time_ms: 2000
  max_total_parse_time_ms: 30000
```

Recommended schema bounds (time-limit fields are implemented in P3-01; `max_tokens_per_unit` is added in P3-10):

| Setting | Default | Minimum | Maximum | Meaning |
|---|---:|---:|---:|---|
| `max_tokens_per_unit` | 12000 | 1000 | 24000 | Approximate total review payload budget per ReviewUnit |
| `max_run_time_ms` | 120000 | 5000 | 600000 | Overall Context Engine wall-clock deadline |
| `max_parse_time_ms` | 2000 | 100 | 30000 | Maximum parse duration for one source file |
| `max_total_parse_time_ms` | 30000 | 1000 | 180000 | Cumulative parser time across the Context Engine run |

Validate that `max_parse_time_ms <= max_total_parse_time_ms <= max_run_time_ms`. If the selected values cannot satisfy this relation, return a readable `CONFIG_INVALID` error.

Use internal deterministic caps for caller candidates, re-export depth, callee count, and related-test count. Do not expose many more knobs before real use justifies them.

### Hard-cap policy — resolve the diff/rules contradiction

**The hard cap always wins. No emitted ReviewUnit may exceed `max_tokens_per_unit` according to the estimator.**

At the same time:

- Explicit applicable rules must never be silently dropped or truncated.
- The diff must never be silently omitted.
- Do not emit a ReviewUnit that pretends it contains the complete diff when it does not.

Use this deterministic policy:

1. Build a mandatory payload estimate that includes all applicable explicit rules in full, a compact diff identity/summary, the symbol identity/signature, and reserved framing overhead.
2. If the mandatory payload itself exceeds the hard cap, do not emit that ReviewUnit. Record a `mandatory-budget-exceeded` diagnostic with path, symbol identity, rule IDs, and required estimated tokens. Do not send an incomplete rule set to Phase 4.
3. Otherwise include complete relevant diff hunks in original hunk order while they fit. Never split a hunk. If trailing hunks do not fit, include as many complete hunks as possible, set `diffTruncated: true`, record the omitted hunk count, and add an explicit truncation warning/diagnostic.
4. If no complete relevant hunk fits, do not emit the ReviewUnit. Record `diff-exceeds-budget`. Do not send a unit with only a diff header and no actual changed lines.
5. Keep explicit rules verbatim and count all of them. If rules plus the minimum diff/signature/reserve do not fit, skip the unit as in step 2.
6. Keep the changed symbol's declaration signature/header. Include as much definition body as fits, truncating only at complete source-line boundaries and recording `definitionTruncated: true`.
7. Add optional context items in score order until the remaining budget is exhausted. Omit lower-ranked items first.
8. The estimator must recalculate after every inclusion/truncation decision. No final serialized review payload may exceed the configured cap.

This is the explicit resolution of “never remove the diff” versus “never exceed the cap”: preserve diff hunks at hunk boundaries; if at least one whole relevant hunk cannot fit, skip the unit and report why. The hard cap is never exceeded. Explicit rules are either all present in a ReviewUnit or the unit is not emitted.

### ReviewUnit diff representation

Because the original `ChangedFile` contains the full Phase 2 diff, define an explicit review-payload representation so a truncated diff is not accidentally reintroduced through `ReviewUnit.file`:

```ts
export interface ReviewUnitFile {
  path: string;
  oldPath: string | null;
  status: ChangedFile["status"];
  language: ChangedFile["language"];
  commentableLines: number[];
}

export interface ReviewUnitDiff {
  hunks: DiffHunk[];
  originalHunkCount: number;
  includedHunkCount: number;
  omittedHunkCount: number;
  truncated: boolean;
}
```

`ReviewUnit.file` should use the lightweight `ReviewUnitFile` projection, and `ReviewUnit.diff` should contain only the selected whole hunks. Keep the original complete `DiffResult` in the run artifact as the authoritative diff. The Phase 4 Review Engine must consume `ReviewUnit.diff`, not reach back into a full hunk list accidentally included in `ReviewUnit.file`.

This is an additive/shape change to the Phase 3 `ReviewUnit` contract and must be documented in the budget ADR and `systemdesign.md`.

### Run-time and parse-time limits

The Context Engine must be bounded for large repositories. Count/candidate caps alone are insufficient.

- `max_run_time_ms` is one monotonic wall-clock deadline for the entire `ContextEngine.build()` invocation. It includes snapshot reads, AST parsing, import/export resolution, candidate search, caller/callee extraction, test discovery, ranking, and unit assembly.
- `max_parse_time_ms` is the per-file Tree-sitter parse ceiling.
- `max_total_parse_time_ms` is the cumulative parsing budget across the run.
- Use `performance.now()` or another monotonic clock; do not use wall-clock timestamps for elapsed-time decisions.
- Use the pinned `web-tree-sitter` parse `progressCallback` to cancel an individual parse when its per-file, cumulative parse, or overall run deadline expires. A cancelled parse returns `null`; reset that parser before reuse.
- Apply query execution timeouts/progress checks using the APIs available in the exact pinned `web-tree-sitter` version. Verify types in P3-00; do not assume APIs from another release.
- Check the overall deadline between every Git operation, candidate file, import/re-export traversal, test candidate, AST extraction batch, and ranking operation.
- Pass the remaining overall time as the timeout to subprocess operations using the existing safe `runProcess` helper. Do not start a subprocess when no budget remains.
- Keep candidate-count and per-kind result caps in addition to time limits.

### Degradation behavior when limits are reached

Return an explicit partial result, not a success-shaped incomplete array:

```ts
export interface ContextBuildResult {
  units: ReviewUnit[];
  status: "complete" | "partial";
  diagnostics: ContextBuildDiagnostics;
}
```

`ContextBuildDiagnostics` must include at least:

- `elapsedMs`
- `deadlineExceeded`
- `parseBudgetExceeded`
- `filesConsidered`
- `filesParsed`
- `filesParseTimedOut`
- `unitsCreated`
- `unitsSkipped` with stable reason codes (`mandatory-budget-exceeded`, `diff-exceeds-budget`, `run-deadline`, etc.)
- `unitsWithTruncatedDiff`
- `unitsWithTruncatedDefinition`
- `candidateFilesSkippedByCap`
- `queryTimeouts`

Behavior:

- A single file exceeding `max_parse_time_ms`: reset the parser, log a warning, and use a conservative module-level fallback with the diff and bounded nearby source lines if the overall/cumulative budget still permits.
- Cumulative parse budget exhausted: do not start more AST parses. For remaining eligible changed files, create only a conservative diff-based module unit if it can be assembled within the remaining run and token budgets; otherwise record the skip reason.
- Overall wall-clock deadline reached: stop starting new work, preserve already completed units in deterministic input order, mark the result `partial`, and record the unprocessed files/units in diagnostics. Do not block indefinitely waiting for optional caller/test discovery.
- Never silently discard a timeout or represent a partial build as `complete`.

The Context Engine stage and run artifact must preserve `ContextBuildResult.diagnostics` so users can see why some units were omitted or degraded.

### Tests

- Identical input produces identical scores and ordering.
- Rules are counted in the budget and never silently truncated.
- A rule-heavy unit that cannot fit the mandatory payload is skipped with `mandatory-budget-exceeded`.
- Diff hunks are included only as complete hunks.
- Diff is truncated at hunk boundaries with explicit diagnostics when trailing hunks do not fit.
- A unit is skipped with `diff-exceeds-budget` if no complete relevant hunk fits.
- Definition body is truncated at line boundaries; signature is preserved.
- Budget includes diff, definition, rules, context items, and framing reserve.
- Budget is never exceeded according to the estimator.
- UTF-8/Unicode content remains valid.
- Token estimates are stable and non-negative.
- Per-file parse timeout triggers reset and fallback.
- Cumulative parse budget stops additional parsing.
- Overall deadline returns a `partial` result and diagnostics.
- Git/subprocess calls receive only the remaining time budget.
- Ties use deterministic ordering.

## 15. P3-11 — Assemble ReviewUnits and wire the pipeline

### Objective

Connect the real Context Engine to the existing pipeline while leaving later stages stubbed.

### ReviewUnit contract

Follow the current `src/types/context.ts` contract and current stage interface. A ReviewUnit should contain:

- Stable deterministic `id`.
- A lightweight `ReviewUnitFile` projection (path, oldPath, status, language, and commentable-line metadata; no full original hunk array).
- A `ReviewUnitDiff` containing only the selected whole hunks that fit the unit budget, plus original/included/omitted counts and a truncation flag.
- One AST-derived `ChangedSymbol`.
- Ranked `ContextItem[]` within budget.
- All applicable explicit `Rule[]`, verbatim and counted in the budget.

The complete untruncated `DiffResult` remains separately available in the run artifact. `ReviewUnit` must not retain a second copy of all original hunks, because that would bypass the budget and make Phase 4's payload ambiguous.

IDs should be deterministic for the same head SHA, path, and symbol identity. Do not use random UUIDs for context item IDs if replayability benefits from stable hashes.

Do not store Tree-sitter nodes or parser objects in a ReviewUnit.

### Assembly rules

- One ReviewUnit per changed semantic symbol.
- Multiple hunks within the same symbol produce one ReviewUnit.
- Changes in independent symbols produce separate units.
- Module-level changes produce a module unit.
- Unsupported language with eligible diff hunks uses a fallback module unit with diff plus approximately 30 lines of nearby head-side text.
- Skipped files produce no ReviewUnits.
- Empty files and rename-only files with no content hunks produce no ReviewUnits.
- Deletion-only changes use the deletion mapping and anchor contract from P3-04.
- Explicit rules are attached to every matching unit.

### Pipeline wiring

- Wire the real Context Engine in the existing composition root/pipeline dependencies.
- Update the Context Engine contract to return `ContextBuildResult` (`units`, `status`, `diagnostics`) so timeouts and budget-driven omissions are explicit. Record this contract change in the resource-budget ADR. The pipeline passes `result.units` to the still-stubbed Review Engine and persists the full diagnostics.
- Use constructor injection for parser runtime, snapshot reader, logger, and optional token estimator; do not add logger arguments to the Diff Engine or other stage contracts unnecessarily.
- Keep the existing demo/fake wiring deterministic. Do not make `--demo --dry-run` depend on real Tree-sitter parsing or network calls.
- A real `review` run should execute Diff and Context, persist `ContextBuildResult` (units, complete/partial status, structured diagnostics) and context stage counts/timing to `.reviewer-out/run.json`, and then stop at the still-unimplemented Review Engine with `NOT_IMPLEMENTED` as expected.
- Ensure the artifact contains enough context diagnostics to debug the build, but never include parser objects, grammar objects, or unbounded repository content.
- Keep logs on stderr and preserve the single shared `runId` across logger and artifact.

### Diagnostics

Log structured summary information:

- changed files considered
- files skipped (by existing skip reason)
- files parsed per language
- parse errors/recovery counts
- AST symbols extracted
- ReviewUnits created
- callers/callees/tests/types retrieved
- context items omitted or truncated by budget
- units skipped due to mandatory-budget overflow or unavailable complete hunks
- parse timeouts, cumulative parse-budget exhaustion, and overall deadline status
- approximate token estimates
- elapsed time per stage

Do not log whole source files or secret values.

### Tests

- Pipeline invokes real Context Engine after Diff Engine.
- Context stage output, `ContextBuildResult.status`, and structured diagnostics are present in the run artifact.
- Review stub receives `result.units`; its failure occurs after context and does not erase the context output or diagnostics.
- Demo/dry-run remains stable and deterministic.
- A failed context file does not discard unrelated ReviewUnits unless parser initialization or another global dependency fails.
- The same runId appears in logs and artifact.

---

## 16. Data contract changes and ADR policy

Phase 3 has several distinct architectural decisions. Do not force them into one ADR.

Before creating or updating any ADR:

1. Inspect the actual `docs/adr/` directory and identify the next free numbers.
2. Never assume a number is free, overwrite an ADR, or renumber an existing ADR.
3. If an existing ADR already covers a decision, update/reference it instead of creating a duplicate.

Expected ADRs (numbers are illustrative; use the next actually free numbers):

### ADR A — Tree-sitter runtime, grammar compatibility, and WASM packaging (P3-00)

Record:

- Exact `web-tree-sitter` version.
- Exact TypeScript/TSX/JavaScript grammar artifact versions and ABI compatibility.
- Grammar provenance and licenses.
- Runtime initialization and parser lifecycle.
- Normal `bun run` asset-loading location.
- `bun build --compile` WASM asset embedding result.
- Whether compiled executable distribution is supported now or deferred.
- How assets are located when the executable is run outside the source checkout/current working directory.

### ADR B — AST symbol, import/export resolution, and deletion/anchor contract (P3-04/P3-05/P3-07)

Record:

- `SymbolKind` includes `type` for interface/type-alias/enum declarations.
- `changedLines` contains head-side added line numbers only.
- `deletedLines` contains merge-base/old-side deleted line numbers only.
- `anchorLine` is a 1-based head-side commentable line.
- `startLine`/`endLine` are head-side inclusive coordinates.
- Fully deleted declarations fall back to a surviving module-level symbol when no matching head symbol exists.
- Default imports and explicit named/default barrel re-exports are resolved with bounded chain traversal.
- Ambiguous `export *` is not guessed.
- Caller resolution is static/best-effort, not a TypeScript type checker.

### ADR C — Context budget, truncation, and run deadlines (P3-10)

Record:

- Approximate deterministic token-estimation strategy and its limitations.
- `max_tokens_per_unit` includes diff, definition, explicit rules, other context, and framing reserve.
- Hard cap wins; no emitted ReviewUnit exceeds the estimate cap.
- Explicit rules are never silently truncated or dropped; a unit that cannot fit all mandatory rules plus minimum diff/signature is skipped with a diagnostic.
- Diff is retained at whole-hunk boundaries; trailing hunks may be omitted only with explicit truncation metadata/warning. If no full relevant hunk fits, skip the unit.
- Definition body may be truncated at source-line boundaries while preserving its signature.
- Per-unit `ReviewUnitDiff` records original/included/omitted hunk counts and truncation state.
- `max_run_time_ms`, `max_parse_time_ms`, and `max_total_parse_time_ms` defaults and bounds.
- Partial-result behavior and diagnostics when deadlines are reached.
- `ContextBuildResult` stage contract and run-artifact persistence.

### Shared type and documentation updates

For the symbol/deletion and budget decisions:

1. Confirm current actual definitions in `src/types` and `src/core/contracts.ts`.
2. Keep stage interfaces in `src/core/contracts.ts`; do not move them into `src/types`.
3. Keep shared data contracts plain serializable TypeScript types; no Tree-sitter imports in `src/types`.
4. Update `src/types/context.ts` and the appropriate symbol type owner.
5. Add the `ReviewUnitFile` metadata projection and `ReviewUnitDiff` whole-hunk/truncation representation so the full original diff cannot accidentally bypass the budget inside each unit.
6. Add `ContextBuildResult` and `ContextBuildDiagnostics`, update `ContextEngine.build()` in `src/core/contracts.ts`, and update pipeline/fake/test wiring.
7. Update `systemdesign.md` §4.2 and §5, `.reviewer.yml.example`, config tests, artifact tests, and all relevant Phase 3 tests together.

Do not silently change `ReviewUnit`, `ContextItem`, `ChangedSymbol`, `Language`, `ResolvedConfig`, or stage interfaces.

## 17. Suggested project layout

Use this as a target only; extend existing modules and avoid duplicate responsibilities.

```text
src/
  context/
    runtime.ts
    parser.ts
    language.ts
    adapters/
      typescript.ts
      tsx.ts
      javascript.ts
    snapshot.ts
    symbols.ts
    imports.ts
    calls.ts
    callers.ts
    tests.ts
    rules.ts
    rank.ts
    budget.ts
    limits.ts                # monotonic overall/parse deadlines and cooperative cancellation
    retrieve.ts
    engine.ts
  types/
    context.ts          # ReviewUnit, ReviewUnitFile, ReviewUnitDiff, ContextBuildResult/diagnostics
    diff.ts             # shared symbol contract, if currently owned here
  core/
    contracts.ts        # stage interface remains here
    pipeline.ts         # wire real ContextEngine
  config/
    schema.ts            # add context budget and time-limit settings
    defaults.ts
  utils/
    spawn.ts             # reuse Phase 2 safe subprocess helper
    tokens.ts            # deterministic approximate estimator if shared

tests/
  fixtures/context/
    typescript/
    tsx/
    javascript/
    malformed/
    deletion/
    imports/
    callers/
    tests/
  unit/
    context-runtime.test.ts
    context-parser.test.ts
    context-symbols.test.ts
    context-imports.test.ts
    context-calls.test.ts
    context-callers.test.ts
    context-tests.test.ts
    context-rank.test.ts
    context-budget.test.ts
  integration/
    context-engine.test.ts
    context-pipeline.test.ts
```

Dependency rules:

- `src/types` imports nothing from application modules or `web-tree-sitter`.
- `src/context` may import shared types and neutral utilities.
- `src/context` must not import internals from `src/diff`; it consumes `DiffResult` through contracts.
- `src/diff` must not import `src/context`.
- `src/core/pipeline.ts` and the composition root wire the stages together.
- Parser/grammar-specific node types stay internal to `src/context`.
- No circular imports.

---

## 18. Testing and evaluation strategy

### Unit tests

**Runtime/parsing**
- Runtime initialization and language loading.
- TypeScript, TSX and JavaScript grammar selection.
- Compiled-executable smoke test for embedded WASM assets (where compiled distribution is supported), invoked from an unrelated working directory.
- Unicode byte-offset/source slicing.
- CRLF/LF and EOF handling.
- Syntax recovery (`ERROR`/`MISSING` nodes).

**AST extraction**
- Functions, methods, constructors, classes, types, enums.
- Arrow/function expressions assigned to variables.
- Nested functions.
- Container identities.
- Comments/string literal false positives.
- Correct 1-based line ranges.

**Changed-symbol mapping**
- Additions inside function/method/class/type.
- Multiple hunks in one symbol.
- Multiple independent symbols.
- Module-level additions.
- Replacement changes (`changedLines` + `deletedLines`).
- Deletion-only E05 anchor.
- Entirely deleted declaration fallback.
- No valid anchor behavior.

**Repository snapshot**
- Exact head and merge-base content.
- Worktree modifications ignored.
- Untracked files ignored.
- Rename old/new paths.
- Git object and size errors.
- Symlink/gitlink exclusion.

**Context retrieval**
- Relative imports and type definitions.
- Local/imported callees.
- Same-file and cross-file callers.
- AST rejection of comments and strings.
- Related test discovery.
- Explicit path-scoped rules.
- Context item dedupe and stable IDs.

**Ranking/budget and limits**
- Stable scores and ordering.
- Full explicit rules are counted and preserved for every emitted unit.
- Mandatory diff hunk selection and definition signature.
- Whole-hunk diff truncation and explicit diagnostics.
- Oversized mandatory payload causes an explicit unit skip.
- Definition body truncation only at line boundaries.
- Approximate token estimates include all review payload fields and framing reserve.
- Hard budget cap.
- Per-file parse timeout, cumulative parse budget, and overall wall-clock deadline.
- Parser cancellation/reset and query timeout behavior.
- Partial `ContextBuildResult` and run-artifact diagnostics.

### Integration tests

Use the existing `tests/helpers/git-repo.ts` helper from Phase 2. Do not create another temp Git repository helper.

Create fixture repositories with base/head commits and run the real Diff Engine + Context Engine. All temp repositories must be cleaned in `finally` blocks.

Test at minimum:

1. A PR changing one function produces one ReviewUnit with its definition.
2. A PR changing two independent functions produces two ReviewUnits.
3. A changed method retrieves its containing class and local types.
4. A changed function retrieves direct callees.
5. A changed exported function retrieves real callers from the head snapshot.
6. Related tests are found and ranked.
7. Explicit `.reviewer.yml` rules are attached.
8. Deletion-only E05 maps to the surviving semantic function and anchor.
9. Entirely deleted functions fall back to module-level.
10. Skipped Phase 2 files produce no ReviewUnits.
11. Unsupported language uses a nearby-text module fallback.
12. A modified worktree does not change Context Engine output.
13. The same repository/commits/config produce deterministic ReviewUnits and IDs.
14. Context output is written to the run artifact before the Review stub fails.

### Cross-platform

Run `bun run check` on Ubuntu, macOS and Windows. Keep any existing Windows-specific symlink test skips; Phase 3 fixtures should not require actual filesystem symlinks.

### Quality targets

- Context Engine wall-clock and parsing budgets are enforced and observable.
- No false caller matches from comments or string literals.
- No cross-snapshot reads (all current context from head; deleted lines from merge base).
- No nondeterministic unit ordering.
- No duplicated units for the same symbol.
- No context budget overflow according to the implemented estimator.
- No parser or AST objects in serialized artifacts.

---

## 19. Development roadmap and tickets

Implement tickets sequentially. Each ticket must include tests and pass typecheck before moving to the next. One focused commit per ticket is preferred.

| Ticket | Goal | Main deliverable |
|---|---|---|
| P3-00 | Contract/dependency spike | Compatible runtime + grammar WASM choice, ADR decision |
| P3-01 | Parser runtime | One-time init, grammar registry, in-memory parse API, per-file/cumulative/overall time limits, diagnostics |
| P3-02 | Language adapters | TS/TSX/JS normalized AST queries |
| P3-03 | Git snapshot reader | Exact head/merge-base source reads, tree index, bounded blob access |
| P3-04 | Changed-symbol mapping | AST symbols, additions, deletedLines, anchorLine |
| P3-05 | Import/type resolution | Relative imports and relevant type definitions |
| P3-06 | Callee discovery | Local/imported definitions called by changed symbols |
| P3-07 | Caller discovery | Candidate search + AST-verified call sites |
| P3-08 | Related tests | Ranked relevant test snippets |
| P3-09 | Explicit rules | Applicable `.reviewer.yml` rules per ReviewUnit |
| P3-10 | Ranking/budget | Stable ContextItem ranking, hard token cap, whole-hunk truncation, partial-result diagnostics |
| P3-11 | Pipeline integration | Real ContextEngine wired; Review remains stubbed |

### P3-00 acceptance

A small Bun spike initializes the pinned runtime and parses one sample in each language on all three CI OSes. Dependency/grammar versions and licensing are recorded.

### P3-01 acceptance

Runtime is initialized once, all three grammars load, the parser accepts in-memory source strings without a Git snapshot dependency, Unicode and syntax errors are handled safely, parse cancellation is bounded, and fatal runtime failures are typed.

### P3-02 acceptance

Normalized definitions/imports/calls/types are extracted from fixtures with exact names and line ranges. No Tree-sitter-specific type leaks into shared contracts.

### P3-03 acceptance

All source content comes from the correct commit tree. Worktree changes and untracked files do not affect context retrieval.

### P3-04 acceptance

Changed lines map to the correct AST symbols. Multiple hunks merge. Deletions have old-side coordinates and valid head-side anchors where possible. The Phase 2 DiffResult remains unchanged.

### P3-05 acceptance

Relative imports and imported types resolve deterministically; unsupported resolution forms are safely omitted.

### P3-06 acceptance

Direct local/imported callees are retrieved and deduplicated. Ambiguous calls are not guessed.

### P3-07 acceptance

Callers are found from the head snapshot and verified by AST, including supported default imports and bounded explicit barrel re-exports. Strings/comments/declarations do not count as callers; ambiguous wildcard re-exports are omitted.

### P3-08 acceptance

Related tests are discovered, ranked and capped. No test code is executed.

### P3-09 acceptance

Explicit path-scoped rules appear in the correct ReviewUnits. No inferred convention is produced.

### P3-10 acceptance

Context ranking and approximate token estimates are deterministic. Explicit rules are counted and preserved in full for every emitted unit. The hard cap is never exceeded; oversized diffs are truncated only at whole-hunk boundaries with diagnostics, or the unit is skipped if no complete hunk fits. Per-file parse, cumulative parse, and overall run deadlines are enforced with explicit partial-result diagnostics.

### P3-11 acceptance

The real Context Engine runs after the Diff Engine, returns `ContextBuildResult`, persists its units/status/diagnostics in `run.json`, and the pipeline passes `result.units` to the Review stub. The Review stub then reports `NOT_IMPLEMENTED` without losing context output. Demo mode remains unchanged.

---

## 20. Common mistakes to avoid

- Reading source from the working tree instead of `headSha`/`mergeBase`.
- Parsing deleted lines against the head file.
- Putting Tree-sitter nodes or parser objects in shared types or artifacts.
- Slicing JavaScript strings with Tree-sitter byte offsets without conversion.
- Sharing one mutable Parser across concurrent operations.
- Assuming WASM grammar ABI compatibility without a smoke test.
- Treating all parser `ERROR` nodes as fatal for the entire PR.
- Mapping changed lines to the outer class when a method is the most-specific owner.
- Treating every matching identifier from `git grep` as a caller.
- Counting comments and strings as real call sites.
- Resolving imports by basename alone.
- Pretending name-based resolution is a TypeScript type checker.
- Creating one ReviewUnit per hunk instead of per semantic symbol.
- Duplicating class and method ReviewUnits for the same method-body change.
- Losing deletion-only changes because there are no added lines.
- Putting old-side deleted line numbers into `changedLines`.
- Choosing a deletion `anchorLine` that is not in `commentableLines`.
- Adding inferred conventions before Phase 6.
- Adding vector search or a persistent index.
- Introducing a multi-agent architecture.
- Calling OpenCode or writing review prompts in Phase 3.
- Logging full source files or secrets.
- Letting one unparseable file discard all other ReviewUnits.
- Changing the Phase 2 Diff Engine while implementing Context Engine behavior.

---

## 21. Definition of Done

Phase 3 is complete only when:

- The selected `web-tree-sitter` runtime and TS/TSX/JS WASM grammars are pinned and work on Ubuntu, macOS, and Windows.
- WASM packaging for `bun build --compile` is verified with a smoke executable, or compiled distribution is explicitly documented as unsupported/deferred with a tested adjacent-asset layout.
- Source parsing is performed against exact Git commit snapshots.
- AST-derived functions, methods, classes, and type declarations are extracted with correct line ranges.
- Added lines map to the most-specific semantic symbol.
- Multiple hunks within a symbol produce one ReviewUnit.
- Module-level changes have a safe fallback unit.
- Deletion-only changes map to an old-side symbol and a valid head-side anchor where one exists.
- Relative imports and relevant type definitions are retrieved best-effort.
- Direct callees are retrieved best-effort.
- Callers are found using candidate search and AST verification, including supported default imports and bounded explicit barrel re-exports.
- Related tests are discovered and ranked without executing them.
- Explicit repository rules are attached; inferred conventions are not implemented.
- Context ranking is deterministic.
- The approximate token budget counts diff, definition, explicit rules, context items, and framing reserve.
- No emitted ReviewUnit exceeds the hard cap; mandatory overflow is explicitly diagnosed and skipped.
- Per-file parse, cumulative parse, and total run deadlines are enforced; partial results are explicit.
- The real Context Engine is wired into the pipeline.
- `ReviewUnit[]` is persisted in the run artifact.
- The pipeline still stops at the Review Engine `NOT_IMPLEMENTED` stub, as expected before Phase 4.
- Demo mode remains deterministic.
- All existing Phase 1 and Phase 2 tests remain green.
- New Phase 3 tests pass.
- Typecheck passes.
- Ubuntu, macOS, and Windows CI pass.
- `systemdesign.md`, `.reviewer.yml.example`, shared types, and ADRs agree with the implementation.

**Do not begin Phase 4 until this definition of done is met.**

---

## 22. Recommended first implementation task

Start with **P3-00: Tree-sitter dependency, grammar compatibility, and WASM packaging spike**.

Do not begin by writing the full Context Engine or extracting symbols from the Diff Engine.

First prove that the pinned Bun runtime can initialize `web-tree-sitter`, load the exact TypeScript/TSX/JavaScript grammars, parse in-memory source strings on all three CI operating systems, and load the grammar assets from a `bun build --compile` smoke executable (or record a clear decision that compiled distribution is not supported yet). Run the compiled executable from an unrelated working directory.

Once runtime, ABI, and packaging decisions are proven and recorded, proceed to P3-01. P3-01 uses in-memory strings; Git snapshot reading begins only in P3-03.
