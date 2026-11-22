# implementation-phase2.md — Phase 2: Diff Engine

> **Purpose:** This document is the implementation checklist for Phase 2 of CodeBleach. Read `systemdesign.md`, the completed Phase 1 `implementation.md`, and every existing ADR first. `systemdesign.md` remains the architectural source of truth; this document defines the work for Phase 2 and records the required contract updates. Phase 1 YAML syntax errors must continue to report the parser message and config path only: do not add Bun call-site `line`/`column` values as YAML source coordinates. Correct ADR 0004 §3 and revert only the faulty YAML coordinate extraction from commit `32bb6e5` in a separate Phase 1 cleanup; that correction is not Phase 2 work.

> **Current-repository note:** Phase 1 already contains `src/core/contracts.ts`, the logger, config loader, and shared diff types. The eight Phase 2 implementation files listed in §9.1.1 are expected to be new. Confirm the live branch before creating files; do not overwrite or duplicate anything that has appeared since this document was prepared.
>
> **Phase 2 implements deterministic Git diff extraction only.** It does not implement Tree-sitter parsing, repository context retrieval, LLM review, finding validation, or GitHub publishing.

---

## 1. Objective

Implement the real `DiffEngine` behind the existing `src/core/contracts.ts` interface.

Given a repository directory, base commit SHA, head commit SHA, and resolved configuration, the engine must:

1. Verify the repository and commit inputs.
2. Calculate the merge base of base and head.
3. Run local Git diff commands safely and deterministically.
4. Parse Git's NUL-delimited file metadata and unified diff hunks.
5. Produce `DiffResult`, `ChangedFile[]`, `DiffHunk[]`, and `DiffLine[]` using the existing shared contracts.
6. Calculate accurate old/new line numbers and per-file GitHub diff positions.
7. Calculate valid right-side `commentableLines`.
8. Detect file status, renames, binary files, and no-content-change renames.
9. Apply ignore, lockfile, generated-file, file-size, and changed-line filters with explicit `skipReason` values.
10. Return deterministic output suitable for artifacts, later context retrieval, and eventual GitHub inline comments.

At the end of Phase 2, a real command must be able to inspect a local PR-like commit range and print the resulting `DiffResult` without using an LLM or GitHub API.

**Primary acceptance criterion:** fixture repositories with known commits must produce correct file metadata, hunk lines, line numbers, commentable lines, and diff positions.

---

## 2. Phase boundary and architectural clarification

There is one phase-boundary mismatch in the current design documents:

- `systemdesign.md` §4.1 describes Tree-sitter-based changed-symbol mapping as part of the Diff Engine.
- The Phase 1 implementation plan assigns Tree-sitter and AST-based parsing to Phase 3, while Phase 2 owns Git diff parsing and changed-line extraction.

For this implementation, preserve the Phase 1 boundary while still satisfying its Phase 2 changed-symbol requirement:

- **Phase 2:** Git metadata, file changes, unified diff parsing, line mapping, filters, `commentableLines`, and one coarse synthetic module-level `ChangedSymbol` per eligible supported source file.
- **Phase 3:** Tree-sitter, TypeScript/TSX/JavaScript AST parsing, and refinement of the synthetic module-level symbol into real functions, methods, classes, and module scopes.

Do not add Tree-sitter or regex-based function detection in Phase 2. The Phase 2 synthetic symbol is deliberately coarse; it represents the whole changed source file and carries the added head-side line numbers. It is not a claim that a particular function was identified.

Before implementation, inspect `docs/adr/` and confirm the highest existing ADR number. ADRs `0001` through `0004` already exist in the current repository. Do not reuse or overwrite them. Create the symbol-boundary ADR as `0005-symbol-extraction-phase-boundary.md` if `0005` is still unused; otherwise allocate the next unused sequential number and update every reference in this document. Update `systemdesign.md` §4.1 and the roadmap so they agree. Keep the `ChangedFile.symbols` shape unchanged. Phase 3 will replace/refine the synthetic module-level symbol with AST-derived symbols in the context/review-unit path.

Do not introduce Tree-sitter or grammar dependencies in Phase 2.

---

## 3. Scope boundaries

### Included

- Real `DiffEngine` implementation.
- Safe Git subprocess wrapper using `Bun.spawn` with argument arrays.
- Repository-root and commit-SHA verification.
- Merge-base resolution.
- Git name/status metadata parsing (`-z` output).
- Unified diff parsing.
- Added/deleted/context line classification.
- Old and new line number accounting.
- Per-file diff position accounting.
- `commentableLines` calculation.
- Rename, binary, deleted, added, and modified-file handling.
- Path normalization and language detection.
- Ignore and generated-file filters.
- Lockfile/minified-file filtering.
- File-size and changed-line limits.
- A small glob matcher for the supported `.reviewer.yml` patterns, if one does not already exist.
- A diagnostic CLI `diff` command for local inspection.
- Unit and temporary-Git-repository integration tests.
- Run-pipeline wiring so the real Diff Engine replaces the Phase 1 diff stub in normal mode.
- Documentation and ADR updates.

### Explicitly excluded

| Later phase | Excluded work |
|---|---|
| Phase 3 | Tree-sitter, AST parsing, language adapters, symbol definitions, callers/callees, imports/types, tests, context ranking, token budgets |
| Phase 4 | OpenCode calls, real LLM provider, prompts, real finding generation |
| Phase 5 | Finding validation, evidence verification, same-run fingerprints/dedupe (deterministic-only v1, no semantic LLM; cross-run GitHub dedupe is Phase 7) |
| Phase 6 | Inferred repository conventions and inferred-knowledge caching |
| Phase 7 | GitHub Actions PR-review workflow, Octokit publishing, inline comments, PR summaries |
| Phase 8 | Evaluation datasets, metrics, baselines, caching optimization, incremental re-review |

Do not execute source files, tests, builds, package scripts, or other code from the repository being analyzed. Phase 2 invokes Git read-only commands only.

---

## 4. Existing contracts and compatibility

Use the contracts established in Phase 1. Do not duplicate or redefine them inside `src/diff`.

Expected relevant contracts (use the actual checked-in definitions as the final reference):

```ts
export type Language = "typescript" | "tsx" | "javascript";

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  oldLine: number | null;
  newLine: number | null;
  position: number;
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface ChangedSymbol {
  name: string;
  kind: "function" | "method" | "class" | "module";
  container?: string;
  startLine: number;
  endLine: number;
  changedLines: number[];
}

export type DiffSkipReason =
  | "binary"
  | "generated"
  | "too-large"
  | "ignored"
  | "deleted"
  | "lockfile";

export interface ChangedFile {
  path: string;
  oldPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed";
  language: Language | null;
  skipReason?: DiffSkipReason;
  hunks: DiffHunk[];
  commentableLines: number[];
  symbols: ChangedSymbol[];
}

export interface DiffResult {
  baseSha: string;
  headSha: string;
  mergeBase: string;
  files: ChangedFile[];
}
```

The existing stage interface should remain unchanged:

```ts
export interface DiffEngine {
  run(input: {
    repoDir: string;
    baseSha: string;
    headSha: string;
    config: ResolvedConfig;
  }): Promise<DiffResult>;
}
```

### Contract rules

- `skipReason` is not an arbitrary string. Its shared public type is `DiffSkipReason = "binary" | "generated" | "too-large" | "ignored" | "deleted" | "lockfile"`. Update `src/types/diff.ts`, the barrel export, `systemdesign.md` §5, and tests together. This is a shared-contract change and requires an ADR (planned 0006 or next unused number). Do not add values ad hoc inside the engine.
- `DiffResult.baseSha` and `headSha` are the resolved full commit IDs actually used.
- `mergeBase` is the full commit ID returned by `git merge-base`.
- `ChangedFile.path` is the path at the head commit. For a rename, `oldPath` is the path at the base side. For non-renames, `oldPath` is `null`.
- All paths use `/` separators regardless of host OS and are repository-relative.
- `hunks` preserve Git's hunk order and line text.
- `commentableLines` is sorted ascending, unique, and contains head-side line numbers only.
- For an eligible supported source file with content changes, `symbols` contains exactly one synthetic module-level symbol in Phase 2. Phase 3 replaces/refines this placeholder with AST-derived symbols. Unsupported, deleted, binary, filtered, or rename-only files use `symbols: []`.
- Skipped files remain represented in `DiffResult.files` with a `skipReason` and empty `hunks`, `commentableLines`, and `symbols`. This makes skip decisions observable without storing very large or irrelevant patch bodies.
- Unsupported languages remain represented with `language: null`; do not drop them from the diff result.
- A rename with no content changes remains represented as `status: "renamed"`, `oldPath` populated, and empty hunks. Do not fabricate a content diff.

The current repository declares `ChangedFile.skipReason` as `string`, while this phase requires a fixed six-value union. This is an intentional shared-contract tightening, not merely a local implementation detail. Add and export `DiffSkipReason` in `src/types/diff.ts`, change `skipReason?: DiffSkipReason`, update `src/types/index.ts` if needed, update `systemdesign.md` §5, add an ADR, and add type-level/runtime tests in the same PR. Use `0006-diff-skip-reason-union.md` if that ADR number is free; otherwise allocate the next unused sequential number. Do not leave the code, architecture document, and Phase 2 contract inconsistent.

---

## 5. Git execution strategy

### 5.1 Source of truth

Use the local Git object database, not the working tree and not GitHub's REST `patch` field.

The working tree may contain uncommitted changes and must not affect the output. Read file sizes and generated-file headers from the head commit's Git blobs, not by following paths on disk.

Use these Git operations conceptually:

1. `git rev-parse --show-toplevel`
2. `git rev-parse --verify <sha>^{commit}` for base and head.
3. `git merge-base <baseSha> <headSha>`.
4. `git diff --name-status -z --find-renames=50% --diff-algorithm=myers --inter-hunk-context=0 <mergeBase> <headSha> --`.
5. `git diff --no-ext-diff --no-textconv --no-color --find-renames=50% --diff-algorithm=myers --inter-hunk-context=0 --unified=3 <mergeBase> <headSha> --`.

**Determinism requirement:** Always pass both `--diff-algorithm=myers` and `--inter-hunk-context=0` explicitly to both diff invocations. Do not rely on user/global/repository Git configuration. `diff.interHunkContext=10` can merge distinct hunks and shift every later file-local diff position; `diff.algorithm` can alter the add/delete sequence. Pinning these flags makes output independent of those settings. Pin the rename threshold with `--find-renames=50%`. Do not enable copy detection; in particular, do not pass `--find-copies` or `--find-copies-harder`.
6. `git cat-file -s <headSha>:<path>` for head-side blob size when required.
7. `git show <headSha>:<path>` for the first bytes/lines of a text file when generated-header detection is required.

Use the exact same rename-detection options for name/status metadata and unified patch output so their file ordering agrees.

Do not rely on the REST `patch` field; large patches can be truncated. Do not invoke `git fetch` from the engine. If a commit or merge base is unavailable (for example, a shallow checkout), return a clear `GIT_FAILED` error instructing the caller to fetch sufficient history.

### 5.2 Safe subprocess execution

Create `src/utils/spawn.ts` if Phase 1 does not already provide a suitable safe helper. Reuse one helper for all Git commands.

Requirements:

- Use `Bun.spawn` with `cmd: string[]`; never use a shell command string, `sh -c`, `bash -c`, or interpolated command text.
- Set `cwd` to the canonical repository root.
- Capture stdout and stderr separately.
- Use a bounded timeout (default 30 seconds per Git command; make the constant easy to test).
- Enforce output limits by counting bytes as chunks are read, not by relying on `Bun.spawn({ maxBuffer })` or by interpreting a process exit signal. Bun may read materially beyond the configured `maxBuffer` before termination. Start with a 26 MiB stdout cap and a 1 MiB stderr cap. As soon as a cap is exceeded, set an explicit `outputLimitExceeded` flag, kill the child, continue only as needed to reap/close its streams, and return a `GIT_FAILED` output-limit error. Never accumulate bytes beyond the cap. A `maxBuffer` may be retained as a secondary guard, but it is not the enforcement mechanism. Keep bounded stderr for diagnostics.
- Ensure the process is reaped on timeout, abort, or output-limit failure. Output overflow must be detected by the counted byte length; do not infer it from a signal or non-zero exit code.
- Do not inherit or trust ambient Git redirection variables such as `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, or `GIT_COMMON_DIR`. Remove these from the child environment or explicitly neutralize them.
- Use `GIT_OPTIONAL_LOCKS=0` where appropriate. Do not mutate repository configuration.
- Never log full stdout. Log only command purpose, exit status, and a redacted/truncated stderr excerpt.
- Convert command spawn errors, timeout, non-zero exit status, and output-limit failures into `ReviewerError({ code: "GIT_FAILED", ... })` with useful safe details.
- Preserve the underlying error as `cause`.
- Do not retry deterministic Git failures automatically.

Bun's `Bun.spawn` supports argument-array commands and stream readers; verify the exact API against the Bun version pinned in `.bun-version`. Do not treat `maxBuffer` as a hard security boundary because its observed read size can overshoot the configured value. Implement an explicit counted-stream limit.

### 5.3 Repository and commit validation

Before running the diff:

1. Resolve `repoDir` to a canonical absolute path.
2. Verify it is the repository root, not an arbitrary subdirectory. Use `git rev-parse --show-toplevel` and compare canonical paths.
3. Accept full SHA-1 (40 hex characters) or SHA-256 (64 hex characters) commit IDs only. Reject refs, abbreviated SHAs, option-like strings, and empty values.
4. Verify both inputs resolve to commits. Normalize the returned IDs to lowercase.
5. Compute `mergeBase = git merge-base baseSha headSha`.
6. If no merge base exists, fail with a clear `GIT_FAILED` error; do not guess a comparison base.
7. If base and head are equal, return an empty `files` array with `mergeBase` equal to that commit.

Do not automatically fetch missing refs. The caller (local user or future GitHub Action) is responsible for making the commits available locally.

### 5.4 Git environment and portability

- Use `Bun.spawn` argument arrays on Linux, macOS, and Windows.
- Do not assume `/bin/sh`, GNU utilities, or POSIX path separators.
- Keep repository-relative paths normalized to `/` before matching patterns or serializing.
- Use Node/Bun path utilities only for host filesystem paths, not to reinterpret Git's `/`-separated repository paths.
- Tests must use temporary directories and clean them in `finally` blocks.
- Skip only tests that genuinely require unavailable OS capabilities; do not skip ordinary Git diff tests on Windows.
- The Phase 2 claim is cross-platform only if the CI matrix runs Ubuntu, macOS, and Windows. Expand `.github/workflows/ci.yml` to all three hosted runners and execute the full `bun run check` on each. If a runner cannot be supported, explicitly narrow the supported platforms in the docs rather than claiming untested portability.
- Current pre-Phase-2 CI is Ubuntu-only; Phase 2 owns the matrix expansion and must provide evidence from all three OS runners.

---

## 6. File metadata and unified diff parsing

Implement parser logic as pure functions so it can be tested without spawning Git.

Suggested files:

```text
src/diff/
  git.ts          # GitDiffEngine and Git command orchestration
  parse.ts        # NUL metadata and unified diff parser
  positions.ts    # line counters, GitHub position, commentableLines
  filters.ts      # ignore/lockfile/generated/size/line filters
  paths.ts        # repository-relative path normalization + language detection
```

If one of these responsibilities already exists, extend it instead of creating duplicate modules.

### 9.1.1 Expected new files in the current Phase 1 repository

The latest reviewed Phase 1 tree contains none of the following eight Phase 2 files/directories. They are expected additions, not edits to pre-existing Phase 2 modules:

1. `src/utils/spawn.ts`
2. `src/utils/glob.ts`
3. `src/diff/git.ts`
4. `src/diff/parse.ts`
5. `src/diff/positions.ts`
6. `src/diff/filters.ts`
7. `src/diff/paths.ts`
8. `src/cli/commands/diff.ts`

Confirm the current branch before creating them; if any have since been added, extend the existing implementation instead of overwriting it. Do not create a separate duplicate DiffEngine or glob matcher.

### 9.1.2 Logger injection without changing the stage contract

The Phase 1 `DiffEngine.run()` interface has no logger parameter. Keep it that way. `GitDiffEngine` must accept the existing logger in its constructor, for example:

```ts
interface DiffLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const diff = new GitDiffEngine({ logger });
```

Use a structural interface in a neutral contract location or local to `src/diff`; avoid importing an engine implementation into the Diff Engine. The composition root passes the same logger already associated with the pipeline run. Do not instantiate a new logger or generate a new `runId`.

### 6.1 File metadata: NUL-delimited output

Use `git diff --name-status -z --find-renames ...` as the authoritative source for file paths and statuses. Parse the output as NUL-delimited fields, not whitespace-separated text.

Expected shapes:

```text
M\0path\0
A\0path\0
D\0path\0
R100\0old-path\0new-path\0
```

Support at least:

- `A` → `added`
- `M` → `modified`
- `D` → `deleted`
- `R<score>` → `renamed`, with `oldPath` and new `path`
- `T` (file type change) → `modified`, unless a more accurate supported treatment is available and documented

Do not enable copy detection in Phase 2. If an unexpected status is returned, fail with `PARSE_FAILED` rather than silently assigning the wrong path.

Use the resulting ordered metadata list to associate file patches with patch sections. The parser should not depend on splitting a `diff --git` header on spaces, because repository paths can contain spaces and other quoted characters.

### 6.2 Unified diff file sections

Parse the patch output as an ordered sequence of file sections. A line beginning with `diff --git ` starts the next section. Associate section N with metadata record N from the NUL-delimited name/status output.

If the number of patch sections and metadata records differs, return `PARSE_FAILED` with a useful diagnostic.

Recognize file metadata before hunks, including:

- `new file mode`
- `deleted file mode`
- `old mode` / `new mode`
- `similarity index`
- `rename from` / `rename to`
- `index`
- `---` / `+++`
- `Binary files ... differ`
- `GIT binary patch`

Do not mistake `---` or `+++` lines inside a hunk for file headers; once inside a hunk, they are ordinary deletion/addition lines.

### 6.3 Hunk headers

Support standard unified hunk headers:

```text
@@ -<oldStart>[,<oldCount>] +<newStart>[,<newCount>] @@ optional section text
```

When a count is omitted, it is `1`. Preserve explicit zero counts, such as `-0,0` for a new file or `+0,0` for a deleted file.

For each hunk, construct:

```ts
{
  oldStart,
  oldLines,
  newStart,
  newLines,
  lines
}
```

Validate that consumed old-side and new-side line counts equal the counts declared in the hunk header. A malformed/truncated hunk must fail with `PARSE_FAILED`; do not return partially trusted line mappings.

### 6.4 Hunk body lines

For each ordinary hunk body line:

| Prefix | `kind` | `oldLine` | `newLine` |
|---|---|---|---|
| ` ` | `ctx` | current old line | current new line |
| `+` | `add` | `null` | current new line |
| `-` | `del` | current old line | `null` |

After recording a context line, increment both counters. After an addition, increment only the new counter. After a deletion, increment only the old counter.

Preserve `DiffLine.text` exactly after removing the one diff prefix character. Do not trim whitespace. Preserve trailing `\r` when present in the content. This matters for evidence checks in later phases.

The marker `\\ No newline at end of file` is metadata, not a diff line. Do not increment either line counter or GitHub diff position for it.

Empty source lines are valid: a line consisting only of the diff prefix must be preserved with `text: ""`.

### 6.5 GitHub diff positions

Calculate `DiffLine.position` as a 1-based position within that file's patch:

- The first body line immediately below the first `@@` hunk header has position `1`.
- Increment for every `ctx`, `add`, and `del` body line.
- Continue increasing across later hunks in the same file; do not reset for a new hunk.
- Reset to `1` for the first body line of each new file.
- Do not count `diff --git`, metadata lines, hunk headers, or the no-newline marker.

This position is retained as a fallback. The future publisher should prefer GitHub's `line` + `side` parameters; GitHub documents `position` as a legacy/deprecated parameter.

### 6.6 Commentable lines

`ChangedFile.commentableLines` contains sorted unique head-side line numbers for:

- `add` lines (`newLine !== null`)
- `ctx` lines (`newLine !== null`)

It must not include:

- `del` lines
- `null` line numbers
- lines outside parsed hunks
- any line from a file with a `skipReason`

For a deleted file, set `commentableLines: []`.

For a binary or filtered file, set `commentableLines: []`.

For an ordinary modified/added/renamed-with-content file, derive it from the hunks. Deduplicate and sort numerically.

### 6.7 No-newline and special cases

The parser must correctly handle:

- New file with `-0,0` old range.
- Deleted file with `+0,0` new range.
- Multiple hunks in one file.
- Empty hunk lines.
- No newline at end of file markers.
- Rename with content changes.
- Rename with no content changes.
- Mode-only change with no hunks.
- Binary file with no text hunks.
- File paths containing spaces, quotes, backslashes, tabs, and valid UTF-8 Unicode.
- A file name containing a literal newline, using Git's quoted-path behavior in patch headers but NUL-delimited metadata for the authoritative path.
- CRLF file content without trimming the carriage return from `DiffLine.text`.
- Empty diff.

Combined merge diffs are not expected because the engine compares two commit trees. If encountered, reject explicitly rather than parsing them as ordinary hunks.

---

## 7. Path normalization and language detection

Create pure utilities in `src/diff/paths.ts` or reuse existing helpers.

### Path rules

- Git paths are repository-relative and use `/` separators.
- Reject NUL bytes, absolute paths, and path segments equal to `..`.
- Do not call `realpath` on changed file paths; paths come from Git tree metadata and must not be read directly from the working tree.
- Normalize paths before ignore matching and serialization.
- Preserve case in the returned path. Apply case normalization only where the host-independent filter rule explicitly requires it.

### Initial language mapping

| Extensions | Language |
|---|---|
| `.ts`, `.mts`, `.cts` | `typescript` |
| `.tsx` | `tsx` |
| `.js`, `.jsx`, `.mjs`, `.cjs` | `javascript` |
| Anything else | `null` |

The extension comparison should be case-insensitive. Do not attempt AST parsing in this phase.

Unsupported languages remain visible in `DiffResult.files`; set `language: null` and `symbols: []`. Do not invent a new `skipReason` for unsupported language.

### Coarse Phase 2 symbol extraction (no AST)

Phase 1 explicitly includes changed-symbol extraction in Phase 2, while Tree-sitter belongs to Phase 3. Satisfy that boundary with a single synthetic module-level symbol, not regex-based function detection:

```ts
{
  name: "<module>",
  kind: "module",
  startLine: 1,
  endLine: Math.max(1, headLineCount),
  changedLines: addedHeadLineNumbers,
}
```

Rules:

- Create this symbol only for a supported TypeScript, TSX, or JavaScript file that has content hunks and is not skipped.
- `changedLines` is the sorted unique set of `newLine` values from `add` lines. It contains added head-side lines only, as defined by the shared contract.
- For a deletion-only edit in a file that still exists at head, keep the module symbol with `changedLines: []`; the hunks still preserve the deletion and surrounding right-side context.
- Determine `headLineCount` from the head commit blob, not the working tree. Count LF bytes and account for a final line without a newline. Empty content has zero physical lines; use `endLine: 1` to satisfy the current positive-range convention.
- Rename with content changes gets one symbol based on the new path/head blob. Rename-only or mode-only changes get no symbol.
- Unsupported, deleted, binary, and filtered files get `symbols: []`.
- Do not label this placeholder as a function or method. Phase 3 will replace/refine it with Tree-sitter-derived symbols.

---

## 8. File filters

Apply filters deterministically. Every filtered file remains in `DiffResult.files` with its path, old path, status, language, and a `skipReason`; set `hunks`, `commentableLines`, and `symbols` to empty arrays for skipped files.

Use the first matching reason according to this precedence:

1. `deleted`
2. `binary`
3. `lockfile`
4. `ignored`
5. `too-large`
6. `generated`

If the existing product contract has a different explicit precedence, record the reason in an ADR rather than allowing order to vary between runs.

### 8.1 Deleted files

- Keep the file record and parsed status.
- Set `skipReason: "deleted"`.
- Do not attempt to read a head-side blob.
- `commentableLines` must be empty.

### 8.2 Binary files

Detect Git's binary markers (`Binary files ... differ` and `GIT binary patch`) and set `skipReason: "binary"`.

Do not decode binary content as UTF-8 or attempt to parse it as source code.

### 8.3 Lockfiles

Recognize common lockfiles even when a user's ignore list is incomplete:

- `bun.lock`, `bun.lockb`
- `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`
- `Cargo.lock`
- `Gemfile.lock`
- `Pipfile.lock`, `poetry.lock`, `uv.lock`
- `composer.lock`
- `go.sum`
- `Podfile.lock`
- `gradle.lockfile`

Also honor the resolved default/user ignore patterns. Use `skipReason: "lockfile"` for recognized lockfiles.

### 8.4 Ignore patterns

Use `ResolvedConfig.ignore.paths`. Phase 2 must not re-add defaults if Phase 1 already resolves defaults plus user patterns; it must consume the final resolved list once.

Create `src/utils/glob.ts` with a deliberately documented and validated subset. The current Phase 1 config schema only checks `ignore.paths` entries with `z.string().min(1)`; that is not sufficient. Phase 2 must wire glob syntax validation into the Zod schema, not merely add a matcher.

Supported grammar:

- `*` matches zero or more characters within one path segment.
- `**` matches across path separators, but only as a complete path segment.
- `**/` matches zero or more directory segments, so `**/*.lock` matches root-level and nested lockfiles.
- `?` matches exactly one character within one path segment.
- `/` is the only path separator in patterns.
- Literal ordinary filename characters are allowed.

Reject empty patterns, NUL, backslashes, absolute patterns, `.` or `..` path segments, repeated empty segments, malformed `***`, `**` embedded inside another segment, and unsupported glob operators such as brace expansion, character classes, extglob syntax, or negation. Do not silently interpret unsupported syntax as literal text.

Export a pure `isValidGlobPattern(pattern: string): boolean` (or a typed parse result) and a matcher/compiled form from this module. In `src/config/schema.ts`, use a Zod refinement for `ignore.paths` that calls this validator and emits a path-specific message. If `rules[].paths` or `path_overrides[].paths` are also glob patterns in the checked-in schema, apply the same validator there so no configured glob is accepted in one section and rejected at use time in another. Keep `glob.ts` independent of `config` to avoid import cycles.

Tests must prove that valid supported syntax is accepted, unsupported/malformed patterns are rejected by `config validate`, and matching semantics are correct. Invalid patterns must fail during configuration loading, not silently never match.

Use `skipReason: "ignored"` for custom/default path rules that are not recognized lockfiles.

### 8.5 File size limit

The system design calls for a configurable maximum file size as well as the existing changed-line cap. Phase 1 currently defines `max_changed_lines_per_file` but may not include a file-byte limit.

Add optional `review.max_file_size_kb` to the v1 config schema with a default of `500` KB. This is an additive optional v1 setting; existing configurations must continue to parse unchanged. Update:

- `src/config/schema.ts`
- `src/config/defaults.ts`
- `.reviewer.yml.example`
- config tests and docs
- `systemdesign.md` §6

Record this additive config contract in `docs/adr/0007-diff-limits-and-glob-validation.md` if that ADR number is free; otherwise allocate the next unused sequential number. Inspect and preserve all existing ADRs first. Use `git cat-file -s <headSha>:<path>` to measure the head-side blob size. Do not read the working-tree file.

If the blob size exceeds `max_file_size_kb * 1024`, set `skipReason: "too-large"`.

For deleted files there is no head blob, and the `deleted` reason wins.

### 8.6 Changed-line limit

Count changed lines as additions plus deletions across all hunks. Do not count context lines.

If the total is greater than `review.max_changed_lines_per_file`, set `skipReason: "too-large"`.

The threshold is strict: exactly the configured limit is allowed; limit + 1 is skipped.

### 8.7 Generated files

For candidate text files not already filtered, inspect only the head Git blob, not the working tree.

Inspect at most the first 8 KiB or first 20 lines, whichever comes first. Match case-insensitive generated markers such as:

- `@generated`
- `DO NOT EDIT`
- `GENERATED FILE`
- `Code generated ... DO NOT EDIT`

Keep the marker list centralized and tested. Avoid searching the entire file for these phrases because ordinary source comments may mention generated files as examples.

Set `skipReason: "generated"` when a header marker is found.

### 8.8 Minified files

Use ignore patterns such as `**/*.min.*` where configured by defaults. Do not add an independent ad-hoc heuristic that labels every long line as minified; that would create unstable filter behavior.

---

## 9. Diff engine implementation

### 9.1 Suggested structure

```text
src/
  diff/
    git.ts          # GitDiffEngine, commit/merge-base and Git command flow
    parse.ts        # name-status and unified diff parsers
    positions.ts    # line counters, diff positions, commentable lines
    filters.ts      # skip-reason selection and generated/size/line filters
    paths.ts        # path validation, normalization, language detection
  utils/
    spawn.ts        # bounded safe Bun.spawn helper
    glob.ts         # small tested glob matcher if one does not exist
```

`src/diff` may import:

- Shared data types from `src/types`.
- `ResolvedConfig` from the config contract/type location already established in Phase 1.
- `ReviewerError` and `Result` from `src/core` where appropriate.
- Small utilities from `src/utils`.

Do not import Context Engine, Review Engine, Validation Engine, GitHub Publisher, or CLI command internals.

### 9.2 Class and pure function boundaries

Recommended shape:

```ts
export class GitDiffEngine implements DiffEngine {
  constructor(deps: { logger: DiffLogger }) {
    // Store the injected logger; do not create a second logger/runId here.
  }

  async run(input: DiffEngineInput): Promise<DiffResult> {
    // Validate repository and SHAs.
    // Resolve merge base.
    // Fetch metadata and patch with read-only Git commands.
    // Parse, filter, and map line positions.
    // Return a deterministic DiffResult.
  }
}
```

Define a small structural `DiffLogger` interface local to `src/diff/git.ts` (or a neutral shared contracts/types module) with `debug`, `info`, `warn`, and `error` methods matching the existing logger. Inject it through the `GitDiffEngine` constructor: `new GitDiffEngine({ logger })`. The `DiffEngine.run()` contract must remain unchanged; do not add logger to its input. The CLI/pipeline composition root passes the existing logger into the constructor. Do not create another logger or another runId inside the diff engine.

Keep pure functions separately testable:

```ts
parseNameStatusZ(output: Uint8Array): FileChangeMetadata[];
parseUnifiedDiff(output: string, metadata: FileChangeMetadata[]): ParsedFilePatch[];
assignDiffPositions(files: ParsedFilePatch[]): ParsedFilePatch[];
getCommentableLines(hunks: DiffHunk[]): number[];
detectLanguage(path: string): Language | null;
matchGlob(path: string, pattern: string): boolean;
```

Names can vary to match existing code style, but responsibilities must remain separated.

### 9.3 Error behavior

Use existing `ReviewerError` codes:

- `GIT_FAILED`: Git unavailable, invalid repository, missing commit, missing merge base, shallow checkout, timeout, output cap, or non-zero Git exit.
- `PARSE_FAILED`: malformed NUL metadata, unsupported Git status, mismatch between metadata sections and patch sections, malformed hunk, invalid path encoding, or inconsistent hunk line counts.
- `INTERNAL`: unexpected programming errors only.

Do not convert a parser error into an empty diff. An empty diff is a valid result only when Git proves there are no changed files.

Error messages must include the operation being performed and safe diagnostic context, but not dump a full diff or arbitrary blob contents.

---

## 10. CLI and pipeline wiring

### 10.1 Diagnostic `diff` command

Add a read-only CLI command so the Diff Engine can be exercised before the Context Engine exists:

```bash
bun run src/cli/index.ts diff --base <full-base-sha> --head <full-head-sha> [--repo .]
```

Behavior:

- Load `.reviewer.yml` using the existing config loader.
- Instantiate `GitDiffEngine`.
- Run the diff engine with the supplied repository and SHAs.
- Print pretty JSON `DiffResult` to stdout.
- Send structured logs to stderr.
- Use existing centralized exit-code mapping.
- Unknown flags or missing arguments return exit code `2`.
- Git or parser failures return exit code `1`.
- This command is diagnostic only. It does not write GitHub comments or call an LLM.

Add the command to CLI usage/help and README examples.

### 10.2 Normal `review` wiring

In non-demo mode, replace the Phase 1 Diff stub with `GitDiffEngine`.

Keep Context, Review, Validation, and Publisher as Phase 1 not-implemented stubs until their phases are implemented. A normal `review` run may therefore complete the diff stage and then fail at the Context stage with `NOT_IMPLEMENTED`; the run artifact must retain the successful `DiffResult` and identify Context as the failed stage.

Do not make `--demo` inspect the current repository. Demo mode must keep using deterministic fakes.

`--dry-run` still means "do not publish"; it does not mean "stop after diff".

### 10.3 Run artifact

Ensure the `run.json` artifact records the real `DiffResult` when the diff stage succeeds. Do not duplicate a second diff serialization format.

Keep the single runId generated at the CLI/pipeline boundary and use it consistently in logs and the artifact. This is a Phase 1 invariant; do not regress it. The Diff Engine constructor receives the same logger instance; it must not create another runId.

---

## 11. Test strategy

Use both pure parser tests and integration tests against temporary real Git repositories. Tests must never access GitHub, OpenCode, or the network.

### 11.1 Unit tests: metadata parsing

Test at least:

- Modified file (`M`).
- Added file (`A`).
- Deleted file (`D`).
- Rename (`R100`, plus rename with content changes).
- Type change (`T`) if Git emits it for a supported fixture.
- Multiple entries in one NUL-delimited output.
- Paths containing spaces.
- Paths containing quotes and backslashes.
- Valid UTF-8 Unicode paths.
- Path containing a newline if supported by Git's NUL metadata.
- Missing NUL terminator / truncated metadata.
- Unknown status.
- Malformed rename pair.

### 11.2 Unit tests: unified diff parsing

Test at least:

- One simple modified file with addition, deletion, and context lines.
- New file with `-0,0` hunk range.
- Deleted file with `+0,0` hunk range.
- Multiple hunks in one file.
- Empty added line and empty context line.
- `\ No newline at end of file` marker.
- CRLF content preserves `\r` in line text.
- Hunk header with omitted line counts.
- Hunk header with explicit zero counts.
- Hunk section text after `@@`.
- A line beginning with `---` or `+++` inside a hunk.
- Binary marker and `GIT binary patch`.
- Mode-only changes with no hunks.
- Rename-only changes with no hunks.
- Malformed header.
- Too few or too many consumed old/new lines relative to hunk counts.
- Metadata/patch file-section count mismatch.
- Combined diff marker is rejected explicitly.

### 11.3 Unit tests: positions and commentable lines

For every hunk test, assert:

- Old-side line numbers.
- New-side line numbers.
- `DiffLine.kind`.
- `DiffLine.position`.
- Position continues increasing across hunks in the same file.
- Position resets for the next file.
- Deletion lines have `newLine: null` and are not commentable.
- Added/context lines are commentable.
- `commentableLines` is sorted and unique.
- Deleted, binary, and filtered files have no commentable lines.

Include a fixture where the second hunk begins after a large line gap to ensure the position counter is not derived from source line numbers.

### 11.4 Unit tests: filters and paths

Test:

- All built-in ignore patterns.
- User-defined ignore pattern matching.
- Additive semantics: custom patterns do not remove built-ins.
- `*`, `**`, `**/`, and `?` glob behavior.
- Root-level and nested `**/*.lock` matches.
- Lockfile recognition by basename.
- Generated markers (all supported marker forms).
- Generated marker outside the inspected header does not cause a skip.
- File size exactly at limit is accepted; limit + 1 is skipped.
- Changed lines exactly at limit are accepted; limit + 1 is skipped.
- Changed line count excludes context lines and includes additions + deletions.
- Language detection for TS, TSX, JS, and unsupported paths.
- Path normalization and traversal rejection.
- Deterministic filter precedence when a file matches multiple rules.

### 11.5 Integration tests: temporary Git repositories

Create a test helper that:

1. Creates a temporary directory.
2. Initializes a Git repository with a known initial branch.
3. Sets local test-only `user.name` and `user.email`.
4. Writes files and creates a base commit.
5. Writes changed files and creates a head commit.
6. Returns repository path, base SHA, and head SHA.
7. Removes the temporary repository in `finally`.

Test the real `GitDiffEngine` against at least:

- Modified TypeScript file.
- Added TypeScript file.
- Deleted file.
- Modified file with multiple hunks.
- Rename with changes.
- Rename with no content changes.
- Binary file.
- Ignored file.
- Lockfile.
- Generated file.
- File above the byte limit.
- File above the changed-line limit.
- Empty diff (base equals head).
- Invalid SHA.
- Missing commit object.
- Non-repository directory.
- Shallow/missing merge-base behavior where a reliable fixture can be built.
- Working tree dirty after head commit: output must still reflect the head commit, not the uncommitted content.
- Repository config sets `diff.interHunkContext=10` and `diff.algorithm=patience`: explicit CLI options must still produce the same hunks/positions as defaults.
- Repository config sets `diff.renames=copies`: output must still contain no copy (`C`) statuses and must retain the explicit rename policy.

### 11.6 CLI tests

Spawn the CLI with `Bun.spawn` and assert:

- `diff --base <sha> --head <sha>` exits 0 and prints valid JSON.
- Missing `--base` or `--head` exits 2.
- Unknown flags exit 2.
- Invalid repository/commit exits 1 with a readable message.
- Logs stay on stderr; JSON stays on stdout.
- `review --demo --dry-run` remains unchanged and succeeds.
- Normal `review` uses the real Diff Engine; with later stages still stubbed, the artifact includes a successful diff stage before the expected Context `NOT_IMPLEMENTED` failure.

---

## 12. Observability and artifact details

The `DiffResult` itself is the only diff data contract. Avoid separate competing JSON schemas.

The run artifact should preserve:

- Base SHA.
- Head SHA.
- Merge-base SHA.
- Every changed file, including skipped files.
- Status and old path for renames.
- Skip reason.
- Hunk old/new ranges.
- Every parsed line's kind, old/new line, position, and exact text.
- `commentableLines`.
- For an eligible supported source file with content changes, `symbols` contains one synthetic module-level symbol; other files use `symbols: []`.

Do not log full patch contents. Use summary logging:

```text
filesTotal
filesAnalyzed
filesSkipped
additions
 deletions
hunks
binaryFiles
renamedFiles
```

The exact log field names may follow the existing logger conventions. Never log full source text or file blobs.

Summary logging is required, but `DiffEngine.run()` intentionally has no logger parameter. Inject the logger through `GitDiffEngine` construction (`new GitDiffEngine({ logger })`) from the composition root. Keep the stage interface unchanged. Use the same logger/runId already created for the pipeline; do not generate a new ID inside the engine. Add tests that assert the injected logger receives summary counts and that the artifact/log runId remains the Phase 1 runId.

---

## 13. Documentation changes

Update:

- `README.md`: how to run the new `diff` diagnostic command.
- `systemdesign.md` §4.1: source of truth, command strategy, parser/positions, filters, and the Phase 3 symbol-mapping handoff.
- `systemdesign.md` §5 only if an actual shared type changes.
- `systemdesign.md` §6 for `review.max_file_size_kb` if added.
- `systemdesign.md` §13 roadmap: Phase 2 done criterion should focus on correct diff/file/line/position/filter output; Phase 3 adds AST symbol mapping.
- `docs/adr/0005-symbol-extraction-phase-boundary.md` (or next free ID): Phase 2 versus Phase 3 symbol extraction boundary.
- `docs/adr/0006-diff-skip-reason-union.md` (or next free ID): narrowing `ChangedFile.skipReason` from `string` to `DiffSkipReason`.
- `docs/adr/0007-diff-limits-and-glob-validation.md` (or next free ID): additive file-size config setting and the supported glob grammar/validation, if implemented as specified.
- `docs/adr/0008-deterministic-git-diff-output.md` (or next free ID): pinning Myers algorithm, zero inter-hunk context, and rename detection threshold.

Before creating any ADR, list the current `docs/adr/` files, confirm no target filename exists, and allocate sequential unused IDs beginning at `0005`. Never overwrite ADRs `0001`–`0004` or any later ADR already present. If the current repository has advanced, renumber all planned references consistently.

Keep docs consistent. Do not leave one document saying symbols are extracted in Phase 2 and another saying Tree-sitter belongs to Phase 3.

---

## 14. Implementation tickets

Complete tickets in order. Each ticket must end with typecheck and relevant tests passing.

### P2-01 — Preflight, contracts, and ADR

**Tasks**

- Read `systemdesign.md`, Phase 1 `implementation.md`, and existing ADRs.
- Inspect the actual checked-in Phase 1 contracts and config shape; do not assume the documents exactly match code.
- Confirm `DiffEngine` contract and `ChangedFile` types.
- Inspect and list all ADRs before creating any. The current repository already has ADRs 0001–0004; never overwrite them. Allocate new IDs beginning at 0005, skipping any occupied number.
- Add the symbol-extraction boundary ADR (planned 0005) and update `systemdesign.md` to align the phase boundary.
- Add an ADR for the `skipReason` union contract change (planned 0006) and update the source type plus `systemdesign.md` §5.
- Add the additive `review.max_file_size_kb` and glob-validation ADR (planned 0007) if this design is retained.
- Record deterministic Git diff flags in an ADR (planned 0008).
- Do not overwrite or silently renumber an existing ADR.

**Accept**

- No unresolved conflict remains about whether Phase 2 includes Tree-sitter.
- `DiffSkipReason` is a six-value shared union in code and `systemdesign.md`, with its contract change recorded in an ADR.
- Every ADR number is unique; existing ADRs 0001–0004 and any later files remain untouched.
- No duplicate public type definitions are introduced.
- ADRs explain genuine decisions, not routine implementation details.

### P2-02 — Safe process helper

**Create/modify:** `src/utils/spawn.ts`, tests.

**Tasks**

- Implement `src/utils/spawn.ts` as a small `runProcess` helper around `Bun.spawn`.
- Accept an argument array, cwd, timeout, and stdout/stderr byte caps.
- Read stdout and stderr as streams and count bytes before buffering each chunk.
- When a cap would be exceeded, set an explicit overflow flag, kill the child, reap it, and report output overflow regardless of the resulting exit signal/code.
- Do not rely on `maxBuffer` alone; a measured Bun read can overshoot it.
- Capture bounded stderr for diagnostics.
- Preserve spawn errors as causes.
- Ensure no shell is involved.
- Add a Git-specific wrapper in `src/diff/git.ts` that maps failures to `GIT_FAILED`.

**Accept**

- Argument values containing spaces/metacharacters are passed as one argument.
- Non-zero exits, timeouts, missing executables, aborts, and output cap are handled.
- A child that writes beyond the configured cap is explicitly identified as overflow even if Bun reports a signal or non-zero exit.
- Tests assert captured bytes never exceed the configured cap.
- No subprocess test uses a shell command string.

### P2-03 — Repository, SHA, and merge-base resolution

**Create/modify:** `src/diff/git.ts`, tests.

**Tasks**

- Canonicalize `repoDir`.
- Verify it is the repository root.
- Validate full 40/64-character hex SHAs before passing them to Git.
- Resolve base/head commit IDs.
- Compute merge base.
- Handle equal SHAs and empty diffs.
- Emit actionable errors for missing objects and shallow history.

**Accept**

- Valid repository and commits resolve to the expected IDs.
- Invalid IDs and missing commits fail deterministically.
- The engine does not auto-fetch or contact a remote.

### P2-04 — File metadata and unified diff parser

**Create:** `src/diff/parse.ts` and parser tests.

**Tasks**

- Parse `--name-status -z` records, including rename pairs.
- Use identical explicit rename detection (`--find-renames=50%`), `--diff-algorithm=myers`, and `--inter-hunk-context=0` settings in both metadata and patch commands.
- Parse ordered patch sections using section boundaries, not path splitting.
- Prove user Git settings such as `diff.algorithm` and `diff.interHunkContext` cannot change parsed hunks or positions.
- Parse hunk headers and all hunk line prefixes.
- Preserve line text exactly.
- Recognize binary/no-hunk/mode-only changes.
- Validate section and hunk counts.

**Accept**

- All metadata and hunk parser unit tests in §11.1–11.2 pass.
- Identical commit/config inputs produce identical output with hostile/alternate Git config values (`diff.interHunkContext=10`, `diff.algorithm=patience`, and `diff.renames=copies`).
- `diff.renames=copies` does not introduce `C` copy statuses.
- Malformed input fails with `PARSE_FAILED`, never partial `DiffResult`.

### P2-05 — Line mappings, positions, and commentable targets

**Create:** `src/diff/positions.ts` and tests.

**Tasks**

- Assign old/new source line numbers.
- Assign per-file GitHub diff positions.
- Continue positions across hunks; reset per file.
- Calculate sorted unique right-side commentable line numbers.
- Ensure deleted/binary/skipped files expose no commentable targets.

**Accept**

- Unit tests verify all line numbers and position values, including multi-hunk files.
- The algorithm matches GitHub's documented diff-position definition.

### P2-06 — Filters, paths, and language detection

**Create:** `src/diff/filters.ts`, `src/diff/paths.ts`, and `src/utils/glob.ts` if needed.

**Tasks**

- Normalize and validate Git paths.
- Detect TS/TSX/JS extensions.
- Apply lockfile, ignore, generated, binary, deleted, byte-size, and changed-line filters.
- Keep unsupported languages in the result with `language: null`.
- Keep skipped files observable with `skipReason` and empty hunks/commentable lines/symbols.
- Reuse resolved additive ignore patterns.
- Implement `isValidGlobPattern()` in `src/utils/glob.ts` and wire it into Zod validation for `ignore.paths` (and any other configured glob fields that the current schema exposes). The existing `z.string().min(1)` check is insufficient.
- Invalid/unsupported glob syntax must fail `config validate` with a path-specific `CONFIG_INVALID` message.
- Add `review.max_file_size_kb` with default 500 KB if missing from the current resolved config. Existing v1 configs must continue to parse.

**Accept**

- Filter precedence is deterministic and tested.
- All default and custom patterns behave as documented.
- Invalid glob patterns are rejected by the config loader before the Diff Engine runs.
- The engine reads head-commit blob metadata/content through Git, not working-tree paths.

### P2-07 — GitDiffEngine orchestration

**Create/modify:** `src/diff/git.ts` and integration tests.

**Tasks**

- Run repository validation, commit resolution, merge-base, metadata, and patch commands.
- Associate metadata records with patch sections.
- Apply filters and positions.
- Return the existing `DiffResult` contract.
- Create one synthetic module-level symbol for each eligible supported source file with content changes; leave `symbols` empty for unsupported, skipped, deleted, binary, and rename-only files.
- Inject the existing logger through the `GitDiffEngine` constructor; keep `DiffEngine.run()` unchanged.
- Ensure the exact Git flags pin `--diff-algorithm=myers` and `--inter-hunk-context=0` in both diff commands.
- Ensure output is deterministic for identical repository objects, SHAs, and config, regardless of user Git diff settings.

**Accept**

- Temporary Git repository integration tests pass.
- Dirty working-tree changes do not affect output.
- No network calls occur.
- No reviewed code is executed.

### P2-08 — CLI and pipeline wiring

**Create:** `src/cli/commands/diff.ts`; update CLI wiring and README.

**Tasks**

- Create `src/cli/commands/diff.ts` and add the diagnostic `diff` command with strict argument parsing.
- Construct `GitDiffEngine` with the existing CLI logger (`new GitDiffEngine({ logger })`); do not add a logger argument to `DiffEngine.run()`.
- Print `DiffResult` JSON to stdout and logs to stderr.
- Use the existing exit-code mapper.
- Wire `GitDiffEngine` into normal `review` mode.
- Keep demo mode fully fake/offline.
- Keep later pipeline stages as NOT_IMPLEMENTED stubs.

**Accept**

- CLI tests in §11.6 pass.
- Demo behavior and artifact counts remain unchanged.
- Real review artifact contains diff output before the expected Phase 3 Context stub failure.

### P2-09 — Full verification and handoff

**Tasks**

- Run formatter/linter if the repository defines them.
- Expand `.github/workflows/ci.yml` from the current Ubuntu-only job to an OS matrix: `ubuntu-latest`, `macos-latest`, and `windows-latest`, with the existing pinned actions and Bun version.
- Run the same `bun run check` command on all three operating systems. Keep only genuinely OS-specific tests skipped (for example, symlink creation where Windows runner permissions do not allow it); ordinary Git diff tests must run on all three.
- Run `bun run typecheck` and `bun test` (or `bun run check`).
- Run the diagnostic `diff` command against a disposable local fixture repository.
- Run the demo dry-run.
- Confirm no external network requests, LLM calls, or GitHub API calls occur.
- Review `git diff` for scope creep and update docs/ADRs.

**Accept**

- All Phase 2 acceptance criteria pass.
- CI is green on Ubuntu, macOS, and Windows, or the documented support matrix is explicitly narrowed with a reason.
- No Phase 3/4/5/6/7/8 work has been implemented.

---

## 15. Required test matrix

| Area | Required coverage |
|---|---|
| Git subprocess | No shell; safe argv; non-zero exit; timeout; output cap enforced by byte counting (not signal inference); missing Git; process reaping |
| Repo validation | Non-repo; repo subdirectory; canonical repo root; linked worktree if available |
| Commit validation | Full SHA-1; full SHA-256 where fixture support exists; invalid/abbreviated SHA; missing commit |
| Merge base | Normal divergent branches; base=head; unrelated history; shallow/missing object error |
| Determinism | Same output under `diff.interHunkContext=10`, `diff.algorithm=patience`, and `diff.renames=copies`; explicit Myers + zero inter-hunk context; no copy statuses |
| Name status | M/A/D/R/T; NUL parsing; unusual UTF-8 paths; malformed/truncated records |
| Unified patch | Single/multiple hunks; zero counts; no-newline; CRLF; empty lines; malformed counts |
| Line mapping | Old/new counters; add/del/context; no-newline metadata; multiple hunks |
| Diff positions | Correct 1-based per-file positions; positions continue across hunks; reset per file |
| Commentable lines | Add/context only; sorted unique; none for deleted/binary/skipped files |
| Filters | Ignore; lockfile; generated; binary; too-large by bytes; too-large by changed lines; precedence; invalid glob rejected at config boundary |
| Paths | Spaces; Unicode; quotes; tabs; newlines; traversal rejection; slash normalization |
| Language | TS, TSX, JS; unsupported extension gives null |
| Engine | Empty diff; deterministic output; dirty worktree ignored; rename-only; mode-only |
| CLI | JSON stdout; logs stderr; exit codes; missing args; unknown flags; real diff command; injected logger receives summary; one runId correlated across logs/artifact |
| CI platforms | Full typecheck and test suite on Ubuntu, macOS, Windows; only capability-specific skips |
| Regression | `review --demo --dry-run` unchanged; runId consistency preserved; artifacts include real diff |

Tests should create commits in temporary Git repositories. Do not use the CodeBleach working repository itself as a test fixture.

---

## 16. Definition of done

- [ ] P2-01 through P2-09 are complete.
- [ ] `GitDiffEngine` implements the Phase 1 `DiffEngine` contract without adding a logger to `run()` input.
- [ ] `ChangedFile.skipReason` uses exported `DiffSkipReason` union (`binary | generated | too-large | ignored | deleted | lockfile`) in code and `systemdesign.md`; the contract change has an ADR.
- [ ] Repository root, full commit SHAs, and merge base are verified.
- [ ] Diff metadata and unified hunks are parsed without relying on whitespace splitting for paths.
- [ ] Added, deleted, context lines map to correct old/new line numbers.
- [ ] `DiffLine.position` is 1-based and continues across hunks within a file.
- [ ] `commentableLines` contains only sorted unique right-side hunk lines.
- [ ] Renames, binary files, deleted files, mode-only changes, and rename-only changes are handled.
- [ ] Ignore, lockfile, generated, max-file-size, and max-changed-line filters work and provide skip reasons.
- [ ] Glob syntax is validated by the configuration Zod schema; unsupported patterns fail `config validate` with a useful path.
- [ ] Git diff invocation pins `--diff-algorithm=myers` and `--inter-hunk-context=0` (and an explicit rename threshold) in both metadata and patch commands.
- [ ] `Bun.spawn` output caps are enforced by counted stream bytes; overflow cannot be mistaken for an ordinary signal/exit failure.
- [ ] Unsupported languages remain visible with `language: null`.
- [ ] Each eligible supported changed source file has exactly one synthetic module-level symbol; no Tree-sitter dependency is added.
- [ ] Diagnostic `diff` CLI command emits valid JSON and uses correct exit codes.
- [ ] Normal review wiring uses `GitDiffEngine`; later stages remain explicit stubs.
- [ ] Demo mode remains deterministic, offline, and unchanged.
- [ ] The run artifact captures the real `DiffResult` when the diff stage succeeds.
- [ ] `bun run check` passes locally and in CI on Ubuntu, macOS, and Windows (or the supported OS matrix is explicitly narrowed and documented).
- [ ] Tests require no network access, API keys, OpenCode, or GitHub credentials.
- [ ] Documentation and ADRs agree on the Phase 2/Phase 3 boundary.

---

## 17. Handoff to Phase 3

Phase 3 consumes the `DiffResult` produced here and implements the Context Engine.

It will add:

- `web-tree-sitter` and TypeScript/TSX/JavaScript grammars.
- A `LanguageAdapter` for the initial languages.
- AST-based refinement of the synthetic module-level symbol into changed function/method/class/module symbols.
- Definitions, imports/types, callees, best-effort callers, and related tests.
- `ReviewUnit[]` construction.
- Context ranking and token budgets.

Phase 3 must not re-parse Git diffs or recompute line positions. It consumes `DiffResult` and its exact `DiffLine`/`commentableLines` mappings. It can enrich copied `ChangedFile` values in `ReviewUnit` with AST symbols without mutating the original `DiffResult`, or expose a separate symbol-extraction result if an ADR establishes that cleaner contract.

The stable Phase 2 contract is the handoff boundary: a correct, deterministic, repository-relative diff with trustworthy line mappings.

---

## 18. Required ADR allocation and cross-document changes

Before creating ADR files, inspect the current `docs/adr/` directory. The Phase 1 repository already contains ADRs `0001`, `0002`, `0003`, and `0004`; the earlier draft of this Phase 2 plan incorrectly proposed reusing `0002` and `0003`. Never overwrite an existing ADR. Use the next available sequential IDs, beginning at `0005`. The planned allocation is:

| Planned ID | ADR | Decision recorded |
|---|---|---|
| `0005` | `symbol-extraction-phase-boundary` | Phase 2 creates only a synthetic module symbol; Tree-sitter symbols belong to Phase 3. |
| `0006` | `diff-skip-reason-union` | Narrow `ChangedFile.skipReason` from `string` to the six-value `DiffSkipReason` union. |
| `0007` | `diff-limits-and-glob-validation` | Add `max_file_size_kb` and define/validate the supported glob grammar. |
| `0008` | `deterministic-git-diff-output` | Pin Myers algorithm, zero inter-hunk context, and rename threshold for reproducible output. |

This is a proposed allocation, not permission to overwrite. If any planned ID now exists, move that ADR to the next unused number and update all references. Do not renumber or rewrite historical ADRs.

Required source/document changes:

- `src/types/diff.ts`: export `DiffSkipReason` and use it for `ChangedFile.skipReason`.
- `src/types/index.ts`: re-export `DiffSkipReason`.
- `systemdesign.md` §5: update the `ChangedFile` contract to the same union.
- `systemdesign.md` §4.1 and §13: align Diff Engine responsibilities, symbol handoff, and phase descriptions.
- `src/config/schema.ts`: validate configured glob patterns through the new pure glob validator.
- `src/config/defaults.ts` and `.reviewer.yml.example`: add the default 500 KB max-file-size setting if it is not already present; preserve existing additive ignore semantics.
- `.github/workflows/ci.yml`: expand the test/typecheck matrix to Ubuntu, macOS, and Windows so portability is actually exercised.
- `README.md`: document the new `diff` CLI command.

The first four ADRs are existing historical decisions. Do not modify them as part of Phase 2 unless a separate, explicitly justified correction is required.

---

## 19. Reference documentation

Use the official documentation when implementing and verify it against the pinned tool versions:

- Git diff format and rename metadata: https://git-scm.com/docs/git-diff
- Git diff name/status and path handling: https://git-scm.com/docs/git-diff
- Git merge-base: https://git-scm.com/docs/git-merge-base
- Git cat-file: https://git-scm.com/docs/git-cat-file
- Bun child processes (`Bun.spawn`): https://bun.sh/docs/runtime/child-process
- GitHub review comment positions and line/side parameters: https://docs.github.com/en/rest/pulls/reviews and https://docs.github.com/en/rest/pulls/comments

GitHub documents `position` as the number of diff lines after the first hunk header in that file, continuing across hunks; the API is moving toward `line` and `side`. Keep `position` correct because it exists in the current shared contract, but do not design Phase 2 around publishing comments.

---

## GREEN addendum (Phase 2 edge closure, ADR 0010)

GREEN closes the edge contract without weakening ordinary-file behavior: raw metadata (`--raw -z --no-abbrev`, pinned flags) classifies 120000/160000 either side as `unsupported-mode` (100644<->100755 stays supported); binary via `numstat -z` (renames ok) with no patch for detection; early path filters (lockfile/ignore incl `**/*.min.*`) before blob sizes; head blob sizes via `cat-file --batch-check` (never a gitlink as blob, 26623KB ceiling, missing objects are `GIT_FAILED` with fetch hint); patches ONLY for eligible files via safe pathspec (argv arrays, `patchMaxStdoutBytes` seam unchanged, genuine over-cap `GIT_FAILED` no truncate); CLI resolves via `rev-parse --verify --end-of-options <rev>^{commit}` (dash-prefixed `INVALID_INPUT` pre-Git, full SHAs to the engine, unique abbrev ok / ambiguous `INVALID_INPUT`, missing-object `GIT_FAILED` exit 1). Precedence `deleted > unsupported-mode > binary > lockfile > ignored > too-large > generated`. Positions and contracts preserved (E02/E03/E04 hunks, E05 `changedLines: []` plus Phase 3 TODO). No new ADR: no new decision beyond ADR 0010.
