# systemdesign.md — Personal AI PR Reviewer

Audience: the implementing agent. This is the source of truth for architecture, contracts and decisions. Phase-specific work lives in `implementation.md` (Phase 1) and later `implementation-phaseN.md`.

**Do not deviate from the decisions here without writing a short ADR note in `docs/adr/`.**

---

## 1. Scope

A personal, single-user tool that reviews PRs on trusted GitHub repos and posts inline comments. Goal: **high precision, repo-aware, evidence-backed findings.**

Non-goals: SaaS, multi-tenancy, billing, dashboards, vector DB/embeddings, microservices, multi-agent orchestration, executing PR code.

Fixed stack: Bun, TypeScript (strict), Octokit, GitHub Actions, web-tree-sitter, Zod, `bun test`, OpenCode as LLM backend behind a provider interface.

---

## 2. Principles

1. **CLI-first.** The GitHub Action is a thin wrapper that calls `bun run src/cli/index.ts review ...`. Everything runs locally with `--dry-run`.
2. **Deterministic where possible.** Diff, positions, ids, dedupe, schema checks, evidence checks, and finding validation = code. Only bug-finding = LLM (Phase 5 validation is deterministic-only, ADRs 0028/0030).
3. **Never trust LLM output.** Zod-validate at the boundary, then re-verify against the repo.
4. **Default is silence.** Weak, inconclusive or unverifiable findings are discarded (but logged to the run artifact).
5. **Modules communicate only through typed data contracts** (`src/types`). No module imports another engine's internals.
6. **Every run is replayable.** All intermediate data is written to `.reviewer-out/run.json`.

---

## 3. Architecture

```mermaid
flowchart TD
  EV[GitHub PR event] --> GA[GitHub Action]
  GA --> CLI[CLI: review]
  CLI --> CFG[Config loader .reviewer.yml]
  CLI --> DIFF[Diff Engine]
  DIFF -->|DiffResult| CTX[Context Engine]
  CFG -->|ResolvedConfig| CTX
  CTX -->|ReviewUnit[]| REV[Review Engine]
  REV <-->|LlmProvider| PROV[(OpenCode provider)]
  REV -->|RawFinding[]| VAL[Validation Engine]
  VAL <-->|LlmProvider| PROV
  VAL -->|ValidatedFinding[]| PUB[GitHub Publisher]
  PUB --> GH[(PR review + comments)]
  CLI --> ART[.reviewer-out/run.json]
```

Single process, single run per PR event. No server, no database, no queue.

### Pipeline (improved flow)

```
event → resolve SHAs → load config → git diff (local) → filter files
→ parse changed files (tree-sitter) → changed symbols → build ReviewUnits (context + rules)
→ review pass(es) → normalize + fingerprint → deterministic validation
→ same-run dedupe & cap → rank
→ verify head SHA unchanged → publish review → write artifact
```

---

## 4. Module designs

### 4.1 Diff Engine (`src/diff`)
- **Source of truth:** local Git object database at `<mergeBase>` and `<head>` (needs `fetch-depth: 0` or explicit SHA fetch). Don't rely on the REST `patch` field (truncated for large files). The working tree may be dirty and must not affect output; sizes/headers come from head blobs.
- Raw metadata via `git diff --raw -z --no-abbrev` (old/new mode, blob OIDs, status, renames, paths) classifies `120000`/`160000` either side as `unsupported-mode` (typechanges/gitlinks/symlinks); `100644`<->`100755` stays supported. Binary via `git diff --numstat -z` (renames ok), no patch for detection.
- Raw, numstat, and patch invocations all pin `--diff-algorithm=myers --inter-hunk-context=0 --find-renames=50% --no-indent-heuristic` so user Git config cannot change output; copy detection stays off (ADRs 0008, 0009). Blob sizes via `git cat-file --batch-check` (head-side, never a gitlink as blob); patches ONLY for eligible files via safe pathspec (argv arrays, no shell). Never fetch the full patch for rejectable files.
- CLI resolves revs via `git rev-parse --verify --end-of-options <rev>^{commit}` (dash-prefixed rejected pre-Git as `INVALID_INPUT`); engine stays full-SHA-only. Missing objects are `GIT_FAILED` with a fetch hint.
- Parse unified diff into `ChangedFile[]` → `DiffHunk[]` → `DiffLine[]` with `oldLine`, `newLine`, and GitHub `position`.
- **Valid comment targets** = lines on the RIGHT side present in a hunk (added or context). Compute `Set<number>` per file (`commentableLines`).
- Use the review-comment API's `line` + `side: "RIGHT"` + `commit_id`; keep `position` as computed fallback.
- Filters (each yields a `DiffSkipReason`, precedence `deleted > unsupported-mode > binary > lockfile > ignored > too-large > generated`): binary, deleted-only, lockfiles, `dist/`, `**/*.min.*`, generated (header markers `@generated`, `DO NOT EDIT`), files > N KB / N changed lines (config-driven), unsupported language (still listed, but no symbols).
- Renames: carry `oldPath`; review only if content changed.
- **Symbols (Phase 2):** one synthetic module-level symbol per eligible supported file with content hunks (`{ name: "<module>", kind: "module" }`, head-line range, added head lines); no AST parsing. Phase 3 refines it into real function/method/class symbols with Tree-sitter (ADR 0005).
- **Initial languages:** TypeScript/TSX/JavaScript via case-insensitive extension mapping; anything else gets `language: null`. Add languages via a `LanguageAdapter` (see 4.2, Phase 3).

### 4.2 Context Engine (`src/context`)
On-demand, per PR, **no persistent index** in MVP.

`LanguageAdapter` interface (`src/context/language.ts:89-101`, one per language): `extractDefinitions`, `extractImports`, `extractExports`, `extractCalls` (node-scoped), `extractTypes`, `extractCallSites` (whole-tree, target-scoped), `getTestFileScore`, `getSymbolName`, plus `language`/`extensions`/`grammarId`. One wasm grammar per language; test-file heuristics live in the shared adapter layer.

For each `ChangedSymbol`, collect `ContextItem`s:

| Kind | How |
|---|---|
| definition | full function text + enclosing class/module header |
| imports/types | resolve import specifiers in file → read referenced type/interface definitions (relative imports only at first) |
| callees | tree-sitter call expressions in body → resolve through imports → definition text (signature + body, truncated) |
| callers | `git grep -n -w <symbolName>` (or `rg`) on head → parse hit files → keep hits that are real call expressions (not strings/comments) → enclosing function text. Cap N. |
| tests | head-snapshot-only discovery per symbol (`src/context/tests.ts`): candidate test files (via `getTestFileScore` + symbol grep + bounded module scan) ranked by evidence — direct relative file import > symbol import through a barrel re-export > AST-verified call in test code > base-name match > comment/string-only mention (always weakest, never outranks AST-confirmed). A same-name local definition without import evidence excludes the file. Cap `MAX_TESTS_PER_SYMBOL=16` per symbol; snippet is a bounded extraction around the evidence line (`TEST_SNIPPET_CONTEXT_LINES=10`), never the whole file |
| config | files referenced by `process.env.X`/config keys used in symbol (grep) — later |
| similar | sibling functions in same file/dir with same kind; grep by shared identifiers — later, only if eval shows value |
| conventions | explicit rules from config (always) + inferred (Phase 6) |

Ranking: score = kind weight (definition 100, type 85, callee 75, caller 65, test 55)
  × proximity (same-file 1.00, direct import 0.85, cross-file caller 0.75,
  same-dir test 0.55, other 0.50) × reference-count decay
  (`1 / (1 + 0.15 * (refs - 1))`); ties break by kind priority, path, start
  line, then stable id (ADR 0013). Fill the per-unit hard cap
  `context.max_tokens_per_unit` (default 12000, bounds 1000–24000, estimator
  `ceil(bytes * 23 / 80)` plus 200-token framing reserve) in score order.
  The hard cap always wins: rules are counted but never truncated (over-budget
  mandatory payload skips the unit as `mandatory-budget-exceeded`); diff hunks
  are kept whole in original order or omitted with `truncated: true` (no
  fitting hunk skips as `diff-exceeds-budget`); the definition keeps its
  signature and truncates its body at line boundaries. Over-deadline runs
  return `ContextBuildResult{units, status: partial, diagnostics}` instead of
  a success-shaped array. Always include definition + diff. Record `reason`
  and `tokens` per item. Unsupported language → diff hunks + ±30 lines
  surrounding file text only.

Symbol resolution is **best-effort by name + import path**, not a type checker. Be explicit in prompts that callers/callees may be incomplete.

Test discovery is bounded: `MAX_TEST_GREP_MATCHES=200` per symbol-name grep, `MAX_TEST_SCAN_FILES=200` scanned files, deterministic ordering throughout; expected misses stay silent, only `parse-cancelled`/`cap-reached`-class outcomes become diagnostics.

Snapshot blob reads are one-shot `git cat-file --batch` fetches (`src/context/snapshot.ts`, ADR 0026): single-OID lazy reads cost one spawn (header size replaces the old size probe), `prefetchBlobs` pulls all changed-file head/base blobs up front in 16-OID chunks, all argv-only with stdin from memory and no persistent background process. Protocol parsing is binary-safe with in-order OID checks; per-blob and cumulative byte caps still gate caching; prefetch is best-effort and never throws. Diagnostics carry additive `gitCalls/blobsFetched/blobCacheHits/batchFetches` alongside `queryTimeouts` and the parse-cache counters. Tree reads (`readHeadText`/`readBaseText`) forward the caller's signal to blob fetches, but no context-engine caller passes one yet (`ContextEngine.build` takes no options) — context-side cancellation is programmatic-only with no live caller in v1.

`queryTimeouts` counts engine-observed timed-out Git subprocess calls only (`isGitTimeout` in `src/context/snapshot.ts`: `GIT_FAILED` whose cause reason is `"timeout"`). Git runs single-attempt with no retry, and resolvers rethrow timeout-cause errors instead of recording them as content misses, so the engine counts each exactly once at its catch sites. Deadline skips, parse cancellations, and non-timeout Git failures (exit, output-limit, abort) never increment it. A Git subprocess that exceeds its stdout/stderr byte cap (`runProcess` reason `"output-limit"`, `isGitOutputLimit`) surfaces as the distinct transport code `transport-output-limit` — never `cap-reached` (reserved for caller/callee/test/file candidate caps) and never a budget/timeout code — with its own budget-independent path through the same rethrow-and-count-once structure.

Per-run parse cache (`src/context/parse-cache.ts`): one extraction bundle per `(commit, path, language)` key (lowercased commit; head/base entries stay separate via distinct SHAs; source-equality re-parses on overwrite, so identical blobs parse once per review with no stale cross-content). Stores plain extraction data only — never Tree/WASM handles — so nothing disposes beyond `clear()` at run end. Hits never touch the run budget; misses parse once under it (per-file, cumulative, and deadline limits all apply); cancelled parses are never cached. Caps `MAX_PARSE_CACHE_ENTRIES=256`, `MAX_PARSE_CACHE_BYTES=8MiB` (source-bytes proxy). Diagnostics carry additive `parseCacheHits/Misses/Entries`; `filesParsed` counts actual parses only (hits excluded). Cached outputs are byte-identical to uncached ones.

Partial behavior: `ContextBuildResult.status` is `complete` (no issues) | `partial` (issues with units produced, or deadline/budget with zero units) | `failed` (zero units plus a retrieval-failure diagnostic; cap-only, budget-only, or parse-cancelled-only diagnostics stay `partial`). A transport `transport-output-limit` diagnostic is fatal only when zero usable units remain (otherwise `partial` with preserved context); it never completes and never converts every failure to fatal. Engine diagnostics (`ContextDiagnostic{stage, path, symbol?, code, reason}`, stages `snapshot | parse | import | caller | callee | test`) are bounded (max 100, key-deduped) and carry static codes (`cap-reached | budget-exceeded | parse-cancelled | timeout | transport-output-limit | deadline` plus per-stage `*-failed` fallbacks) plus path/symbol truncated to 200 chars — never messages, source text, or file content. Partial/failed runs still persist `run.json` with units + diagnostics verbatim (redacted by `sanitizePayload`).

### 4.3 Review Engine (`src/review`)
- **MVP: one agent, one pass per ReviewUnit** with a single focused prompt (bugs, null handling, security, regressions). One unit maps to one provider request (plus bounded transport retries, one JSON repair, one `max_output_tokens` cap escalation, ADR 0024); never batch units or split a semantic unit. Add specialized passes (security, concurrency, perf) as separate prompt files only if evals show recall gaps. Separate agents are justified only when a pass needs different tools/context or different models for cost; not before.
- Input: `ReviewUnit` (diff hunks with line numbers, symbol, context items, rules).
- Output: `ReviewBuildResult` (ADR 0017) — `status` (`complete | partial | failed | skipped`), code-owned `Finding[]` (ids, `sha1(file + symbol + category + evidence-anchored quote)` fingerprints, head SHA, symbol, origin), bounded redacted per-unit diagnostics, and usage (`requests/retries/repairRequests/incompleteRetries`, tokens/cost only when the provider reports them). Model output passes strict `RawReviewOutput` (Zod) validation first; the LLM never produces ids, SHAs or fingerprints. A failed unit never erases findings from successful ones. Bounded concurrency (default 3), stable result order. One stage deadline (`review_timeout_ms`, default 600000) plus caller `AbortSignal` bound the whole run (ADR 0018): stops skip queued units with `REVIEW_DEADLINE_EXCEEDED` / `REVIEW_CANCELLED` and abort in-flight requests, preserving completed findings.
- Prompt rules: report only issues introduced by the PR; cite exact code in `evidence`; use only provided context; say nothing if no confirmed bug (`findings: []` is a valid answer); untrusted code goes inside delimited blocks and is declared as data.

### 4.4 Validation Engine (`src/validate`)
Ordered; cheap/deterministic first. Any hard failure → reject. Deterministic-only in v1 (ADRs 0028, 0030): the engine makes no `LlmProvider` calls and `llmVerdict` stays absent.

**Deterministic (code):**
1. Schema valid. 2. `file` is in the PR diff. 3. `line` exists in the exact head snapshot. 4. `line` ∈ `commentableLines` (else nearest changed line of the same symbol within ±5, else reject). 5. `evidence.quote` matches the exact snapshot (redactSource + whitespace-collapsed, case-sensitive literal form) — exact cited range first, else a bounded ±3-line literal-substring fallback over the full-window redaction with minimal-span coordinates (one distinct range verifies at actual lines, several are ambiguous `evidence_side_ambiguous`); either matched span must also clear the per-snapshot PEM interval index (single combined delimiter scan in source order, no per-line sort): fragment-of-PEM-block spans mismatch. Head side at `headSha`, deleted lines at `mergeBase`, at/near the cited range or in provided context. Non-PEM secret patterns rely on the window redaction gate alone. 6. Line/symbol touched by PR (code-derived `introducedByPr` from verified evidence locations, never the model boolean or cited ranges). 7. Severity ≥ threshold and confidence ≥ threshold (per category). 8. Not a same-run duplicate (Phase 4 fingerprint, plus same file+symbol+category similarity). 9. Not matched by ignore rules. (Cross-run / already-posted-on-PR dedupe is Phase 7, not validation.)

**No semantic LLM validation in v1:** the optional independent-LLM check described here in earlier revisions is superseded for Phase 5 v1 by ADR 0028 D1 — deferred until Phase 8 produces evaluation evidence and a separate architectural decision approves it. Deterministic provenance/evidence validation is not proof of semantic correctness.

**Outcome:** `accepted | rejected | inconclusive`. `inconclusive` ⇒ discard (logged). Every check records `{name, outcome, code, detail}` (`outcome: passed | failed | inconclusive | skipped`, stable machine-readable `code` per `docs/adr/0029-phase5-result-contract.md`, bounded detail with no source text or secrets) for eval/debug. Accepted findings carry a code-owned head-side `derivedTarget`; rejected duplicates link the retained finding via `duplicateOfId`. `llmVerdict` stays absent in v1 (deterministic-only, ADR 0028 D1).

**Cancellation (ADR 0034):** an optional caller `AbortSignal` threads `PipelineInput.signal` → `ValidationEngine.validate` → location/evidence reads → the underlying Git subprocess (`runProcess` kills and reaps on abort). Aborted reads are the typed `"aborted"` status and always resolve to `inconclusive` (never accepted); timeout/output-limit/protocol failures keep their own outcomes. The reader is still released (`clear()`) on cancel. The CLI wires no caller signal, so cancellation is programmatic-only in v1.

**Accepted invariant (ADR 0035):** publish eligibility needs the complete invariant — status `accepted` plus a valid head-side `derivedTarget` plus `derivedAttribution.introducedByPr: true` with a defined valid `AttributionBasis`. `isAcceptedFinding` enforces all of it (status alone never passes); the pipeline fails closed (`INTERNAL`, nothing published or counted) on any status-`accepted` item that fails the guard. The guard is shape-only by design (no semantic validation): it never re-derives target/basis against the `DiffResult` — semantic re-proof stays the validator's job. Size diagnostics keep their typed kind: `per-file-limit` names the per-file byte cap, `cumulative-limit` names the total run cap, both preserving typed byte counts/limits; untyped cap wording and transport output-limit still propagate as stage failures, never content-size statuses.

### 4.5 GitHub Publisher (`src/github`)
- One `pulls.createReview` call (`event: "COMMENT"`) with `comments[]` + summary body; `commit_id` = head SHA.
- If a comment 422s (bad position), drop it and list it in the summary instead of failing the review.
- **Dedupe:** each comment body ends with hidden marker `<!-- reviewer:fp=<fingerprint> -->`. On `synchronize`, list existing review comments, skip fingerprints already posted. Never edit/delete human comments. Outdated comments are left to GitHub's outdated handling; optionally resolve own stale threads later.
- Before publishing, re-fetch PR head SHA; if changed → abort (a newer run will handle it).
- Cap comments per review (config `max_findings`, default 10). Overflow goes in summary.
- Rate limits/5xx: Octokit retry+throttling plugins, bounded retries with jitter. Secondary rate limit → back off and fail open.
- Summary: counts, skipped files + reasons, config warnings, run id. No noise when zero findings (short "no issues found" summary).

### 4.6 Config (`src/config`) — see §6.

### 4.7 Providers (`src/providers`) — see §7.

---

## 5. Data contracts (`src/types`)

Plain TS interfaces for internal data; **Zod schemas only at trust boundaries** (config file, LLM output, GitHub payloads).

```ts
export type Language = "typescript" | "tsx" | "javascript";
export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Category =
  | "bug" | "null-handling" | "security" | "concurrency" | "error-handling"
  | "breaking-change" | "resource-leak" | "performance" | "api-usage" | "convention";

// ---- Diff ----
export interface DiffLine {
  kind: "add" | "del" | "ctx";
  oldLine: number | null;
  newLine: number | null;
  position: number;            // GitHub diff position (fallback)
  text: string;
}
export interface DiffHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] }

export interface ChangedSymbol {
  name: string;
  kind: "function" | "method" | "class" | "type" | "module";
  container?: string;
  startLine: number; endLine: number;
  changedLines: number[];      // head-side added line numbers inside this symbol
  deletedLines?: number[];     // merge-base deleted line numbers (ADR 0012)
  anchorLine?: number;          // head-side commentable anchor for deletion-only symbols
}
export interface ChangedFile {
  path: string; oldPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed";
  language: Language | null;
  skipReason?: DiffSkipReason;
  hunks: DiffHunk[];
  commentableLines: number[];
  symbols: ChangedSymbol[];
}
// Closed union (ADRs 0006, 0010); new reasons are a contract change, not an engine edit.
export type DiffSkipReason =
  | "binary" | "generated" | "too-large" | "ignored" | "deleted" | "lockfile" | "unsupported-mode";
export interface DiffResult { baseSha: string; headSha: string; mergeBase: string; files: ChangedFile[] }

// ---- Context ----
export interface ContextItem {
  id: string;
  kind: "definition" | "caller" | "callee" | "type" | "test" | "config" | "similar" | "rule";
  file: string; startLine: number; endLine: number;
  text: string; score: number; tokens: number; reason: string;
}
export interface ReviewUnit {
  id: string;                  // stable hash of headSha + path + symbol identity (P3-11)
  file: ReviewUnitFile;        // lightweight projection; never the full ChangedFile hunks
  diff: ReviewUnitDiff;        // only the budgeted whole hunks for this unit
  symbol: ChangedSymbol;
  context: ContextItem[];
  rules: Rule[];               // explicit only; inferred travels on a separate advisory carrier (Phase 6 plan, ADR 0039)
}
export interface ReviewUnitFile {
  path: string; oldPath: string | null;
  status: ChangedFile["status"];
  language: ChangedFile["language"];
  commentableLines: number[];
}
export interface ReviewUnitDiff {
  hunks: DiffHunk[];           // whole hunks only, in original order
  originalHunkCount: number; includedHunkCount: number;
  omittedHunkCount: number; truncated: boolean;
}
// P4-09 wiring (ADR 0019): ContextEngine.build returns ContextBuildResult so
// token/deadline omissions are explicit; the pipeline passes result.units to
// the real ReviewEngine with the resolved diff headSha (or records an explicit
// skipped review for --no-llm) and persists units + status + diagnostics in
// run.json. The complete DiffResult stays in the artifact as the authoritative
// diff. P5-09 wiring: live runs validate findings with the deterministic
// ValidationEngine (repo-bound snapshot reader over exact headSha/mergeBase);
// --no-llm still skips validation, the publisher stays a Phase 7 stub.
// The complete DiffResult stays in the artifact as the authoritative diff.
// Status gains "failed" (zero units + retrieval failure); diagnostics gains
// ContextDiagnostic[] plus parseCacheHits/Misses/Entries (filesParsed counts
// actual parses only, cache hits excluded).
export interface ContextBuildResult {
  units: ReviewUnit[];
  status: "complete" | "partial" | "failed";
  diagnostics: ContextBuildDiagnostics;
}

// ---- Findings ----
export interface Evidence { file: string; startLine: number; endLine: number; quote: string }
export interface RawFinding {            // produced by LLM, Zod-validated
  title: string; severity: Severity; category: Category;
  file: string; line: number; endLine?: number;
  description: string; suggestion?: string;
  confidence: number;                    // 0..1
  evidence: Evidence[];                  // min 1
  introducedByPr: boolean;
  ruleId?: string;                       // explicit rule it violates
}
export interface Finding extends RawFinding {   // produced by code
  id: string;                  // run-scoped uuid
  fingerprint: string;         // sha1(file + symbol + category + evidence-anchored quote) — stable across runs
  headSha: string;
  symbol?: string;
  origin: { pass: string; unitId: string };
}

// ---- Review result (ADR 0017) ----
export type ReviewStatus = "complete" | "partial" | "failed" | "skipped";
export interface ReviewUsage {   // tokens/cost present only when the provider reports them
  requests: number; retries: number; repairRequests: number; incompleteRetries: number;
  inputTokens?: number; outputTokens?: number; reasoningTokens?: number; totalTokens?: number;
  costUsd?: number; costKnown: boolean;
}
export interface ReviewDiagnostic {
  stage: "provider" | "prompt" | "parse" | "normalize" | "unit";
  code: string; message: string; unitId?: string; retryable: boolean;
}
export interface ReviewBuildResult {
  status: ReviewStatus; findings: Finding[]; diagnostics: ReviewDiagnostic[]; usage: ReviewUsage;
  unitsSubmitted: number; unitsReviewed: number; unitsFailed: number;
  promptVersion: string; promptHash: string; model: string;
}

// ---- Validation (P5-08 result contract, ADR 0029; run artifact schema v2) ----
export type ValidationCheckOutcome = "passed" | "failed" | "inconclusive" | "skipped";
export interface CheckResult { name: string; outcome: ValidationCheckOutcome; code: ValidationCheckCode; detail?: string }
export interface ValidatedFinding {
  finding: Finding;
  status: "accepted" | "rejected" | "inconclusive";
  checks: CheckResult[];
  llmVerdict?: { verdict: "confirmed" | "refuted" | "inconclusive"; reasoning: string };
  derivedAttribution?: { introducedByPr: boolean; basis?: { kind: "added-lines" | "deleted-lines"; evidenceIndex: number; file: string; lines: number[] } }; // P5-05 code-owned, model boolean ignored (ADR 0028 D3)
  derivedTarget?: ValidationTarget | undefined; // P5-03 head-side anchor (required when accepted, diagnostic otherwise)
  duplicateOfId?: string | undefined; // retained finding id when rejected as a same-run duplicate
}

// ---- Stage interfaces (each independently testable) ----
// Live in `src/core/contracts.ts:16-44` (ADR 0001): `src/types` holds pure
// shared data only and imports nothing from `src/`. `ResolvedConfig` lives in
// `src/config/schema.ts:107`. Only `src/core/pipeline.ts` and `src/cli/` wire engines.
```

---

## 6. Repository-aware review & `.reviewer.yml`

**Two knowledge sources, strictly ranked:**
- **Explicit** (`.reviewer.yml`): authoritative. Injected as numbered rules with ids (`rule:arch-001`). Findings may cite `ruleId`. Rule violations may be reported at the rule's severity.
- **Inferred** (Phase 6, planning-only — ADRs 0039–0041, plan `implementation-phase6.md` §§5.2–5.5): derived by deterministic scans (naming/export patterns, error-handling idioms, test layout, common wrappers), each with a locked eligibility predicate. Stored as `{pattern, evidence[{file,startLine,endLine}], matching/eligible/sampled counts, supportRatio = matching/eligible}`; only high-support patterns are kept. Injected via a SEPARATE convention-advisory pass with bounded context, labeled advisory. **App-enforced invariants (not prompt obedience): advisory output is `convention`-category ONLY at severity == `low** (`info` is below-threshold and ineligible, never a quieter advisory)**, provenance stamped by orchestration, deterministic merge never alters primary findings, ANY `ruleId` presence on advisory output is rejected at the orchestration merge boundary before validation (even real rule ids, which validation would otherwise accept via `rule_ok`), explicit wins on conflict per the §5.1/§5.4 head-coordinate identity (equal head-canonical path + equal fallback-resolved symbol + shared-head-line overlap over verified `derivedTarget`/actuals; base evidence maps only via exact one-to-one diff correspondence, unmappable excluded, no manufactured conflict; no prose similarity).** Advisory findings run through a SEPARATE `validate()` call under an isolated advisory policy (severity threshold pinned to `low`, no inherited path thresholds, confidence bar preserved, convention gate kept — plan §5.2, no validator/config change) and merge in their own domain (validate → conflict-suppress → advisory-internal dedupe → `MAX_ADVISORY_FINDINGS_PER_RUN` named cap → append; NEVER a combined cap with primaries — plan §5.3 order 1–9). Verified locations ride the run-scoped §5.5 handoff envelope (discarded after run; `ValidatedFinding`/`run.json` v2 unchanged); conflict/advisory diagnostics are transient-only (orchestration return + bounded logger aggregates, no per-finding conflict records — ADR 0041). Cache in `.reviewer-cache/inferred.json` keyed by hash of sampled OIDs + detector versions + schema + sampling-policy version; restore via `actions/cache`; refresh when the key changes. This is a cache, not "learning". No `src/conventions/` runtime exists today; Phase 7 publishing/integration and Phase 8 evaluation are out and unchanged.

**Schema v1 (strict):**

```yaml
version: 1
review:
  enabled: true
  categories: { bugs: true, security: true, performance: false, concurrency: true }
  severity_threshold: medium         # drop below this
  confidence_threshold: 0.85
  category_overrides:                # per-category thresholds
    security: { confidence_threshold: 0.7 }
  max_findings: 10
  max_changed_lines_per_file: 1500
  max_file_size_kb: 500               # over-limit head blobs skip with "too-large"
ignore:
  paths: ["**/*.lock", "dist/**", "**/*.generated.*"]   # additive: merged over built-in defaults, see ADR 0004
repository:
  language: typescript
rules:                                # explicit knowledge
  - id: arch-001
    kind: architecture                # architecture | convention | testing | performance | error_handling | security
    text: "Controllers must not contain business logic."
    paths: ["src/controllers/**"]     # optional scoping
    severity: medium                  # optional
path_overrides:
  - paths: ["tests/**"]
    review: { categories: { performance: false } }
context:
  max_run_time_ms: 120000
  max_parse_time_ms: 2000
  max_total_parse_time_ms: 30000
  max_tokens_per_unit: 12000
llm:
  request_timeout_ms: 90000
  max_output_tokens: 32768
  max_retries: 2
  max_concurrent_requests: 3
  max_review_unit_input_tokens: 64000
  review_timeout_ms: 600000
```

Behavior: missing file → defaults. Invalid file → `ConfigError` (CLI exit 2); in Action, publish a single comment describing the config error rather than silently reviewing with defaults. User `ignore.paths` extend (never replace) the built-in defaults. A `.reviewer.yml` symlink is followed only when its resolved target stays inside the resolved repository root and is a regular file; outside targets, dangling links, loops, and directories are config errors, never silent defaults. Unknown keys → error (catches typos). Evolution: `version` field + `migrate(raw)` registry chain; new fields are always optional with defaults.

Optional `review.max_file_size_kb` (default 500 KB, absolute ceiling 26623 KB, ADRs 0007, 0009) is measured from the head-commit blob; over-limit files skip with `"too-large"`. An accepted blob plus its 1-byte growth sentinel must fit the 26 MiB per-stream blob-read cap, so values above the ceiling are rejected at config load. Configured glob fields are validated against the documented `*`/`**`/`**/`/`?` subset at load time.

Optional `context` time limits bound the Context Engine (Phase 3): `max_run_time_ms` (default 120000, 5000–600000) is the overall wall-clock deadline, `max_parse_time_ms` (default 2000, 100–30000) caps one file parse, `max_total_parse_time_ms` (default 30000, 1000–180000) caps cumulative parsing. Config load rejects `max_parse_time_ms > max_total_parse_time_ms > max_run_time_ms` violations as `CONFIG_INVALID`. Optional `llm` controls tune the fixed-model integration (Phase 4, ADR 0016): `request_timeout_ms` (default 90000, 1000–600000), `max_output_tokens` (default 32768), `max_retries` (default 2, 0–5), `max_concurrent_requests` (default 3, 1–10), `max_review_unit_input_tokens` (default 64000, per-unit ceiling), `review_timeout_ms` (default 600000, 1000–3600000, overall review wall-clock deadline, ADR 0018). There are no `provider`/`model`/`api_family` selectors: the target is pinned in code (`src/llm/constants.ts`), unknown `llm.*` keys are rejected. Token ceilings are enforced pre-request against conservative local hard limits (`src/llm/limits.ts`): the P4-00 catalog read verified only `api.responses.base_url`, so no `limit.*` was ever authenticated and no runtime catalog tightening exists — validated catalog metadata could only lower these bounds, never raise them (ADR 0022). Config load rejects input+output+margin combinations that cannot fit the local context window as `CONFIG_INVALID`; oversized units skip with `INPUT_BUDGET_EXCEEDED` diagnostics and impossible requests are rejected before any network touch, never silently truncated. Phase 1–3 configuration files load unchanged with `llm` defaults applied.

---

## 7. LLM provider & OpenCode integration

```ts
export interface LlmRequest {
  system: string; user: string;
  jsonSchema?: object;            // from z.toJSONSchema(...)
  model?: string; maxTokens?: number; temperature?: number; timeoutMs?: number;
}
export interface LlmResponse {
  text: string; parsed?: unknown;
  usage?: { inputTokens: number; outputTokens: number; reasoningTokens?: number };
  costUsd?: number;            // provider-reported charge only, never estimated
  retries?: number;           // transport retries behind this response (ADR 0018)
  model: string; raw?: unknown;
}
export interface LlmProvider {
  readonly name: string;
  readonly capabilities: { structuredOutput: boolean; streaming: boolean };
  complete(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}
```

Rules: the Review/Validation engines depend only on `LlmProvider`. Always Zod-validate the result even if the provider claims structured output. On parse failure: one repair retry (feed the validation error back), then discard the unit and record a partial failure. Ship `FakeProvider` (scripted responses) for tests.

**What "OpenCode API" means — verified vs. to-verify (resolve in a Phase 4 spike, before writing the real provider):**

*Surface A — OpenCode server + JS SDK* (`@opencode-ai/sdk`). Docs describe a server you either spawn (`createOpencode`) or connect to (`createOpencodeClient({ baseUrl })`). Structured output (`json_schema` format, with `StructuredOutputError` after retries) is documented as available **only on the `@opencode-ai/sdk/v2` client**. This is an *agent* harness (sessions, tools) — so for reviewing untrusted code you must disable/limit tools and verify the exact permission config keys in the docs. Note the docs state a V1/V2 split; check `https://opencode.ai/docs/llms.txt` for current V2 API before coding.

*Surface B — OpenCode Zen/Go model gateway* (`https://opencode.ai/zen/v1`, Go: `/zen/go/v1`), Bearer API key, `GET /models`. Third-party sources (not primary docs) report the gateway exposes **different protocols per model** (`/chat/completions`, `/messages`, `/responses`; some models Gemini-native) — **do not assume OpenAI-compatibility for every model, nor `response_format` support.** Third-party issue reports also show intermittent 5xx/auth errors → retries + fail-open are mandatory.

Spike deliverable (`docs/opencode-spike.md`): chosen surface, auth, model ids, whether schema-constrained output works for the chosen model, timeouts, tool restriction, a working 30-line script. Then implement `OpenCodeProvider` accordingly. Don't silently substitute another vendor.

**Resolved by the P4-00 spike (ADR 0015) and pinned in P4-01 (ADR 0016):** the
surface is direct OpenCode Go OpenAI Responses at
`https://opencode.ai/inference/go/openai/v1/responses` with raw model ID
`muse-spark-1.3-contributor`, bearer `OPENCODE_API_KEY`, CodeBleach User-Agent,
and one stable opaque `x-opencode-session` per run. No tools, no SDK/agent
host, no repository execution. Every model request requires exact
`CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING=true` (Not-ZDR gate, pre-network). Resolved
by P4-07 (ADR 0017): completed-response usage/cost/reasoning capture
(`usage.{input,output,reasoning}Tokens`, provider-reported `costUsd`), the
`ReviewBuildResult` status/usage/diagnostics contract, and redacted `run.json`
persistence. Resolved by P4-08 (ADR 0018): provider-reported transport-retry counts
(`LlmResponse.retries`, exhausted-error `retries`, `usage.retries` distinct
from repairs), the overall `review_timeout_ms` stage deadline, and
deadline/caller abort propagation with partial-result preservation. Resolved
by P4-09 (ADR 0019): CLI/pipeline composition — one config load, fixed
provider + engine built from `config.llm` bounds, one opaque `ses_`-prefixed
session per run, resolved `diff.headSha` passed per review call for code-owned
attribution, `--no-llm` offline preview (skipped review `no_llm_flag`,
validation/publish skipped `review_skipped_no_llm`, exit 0), demo unchanged
and network-free, live preflight non-ZDR warning. Resolved by the
reliability pass (ADR 0025): pipeline LLM preflight right after config —
consent, key, fixed-model wiring, and usable budgets fail `CONFIG_INVALID`
before diff and context (offline/canned engines declare
`requiresLlm: false` and skip it); `--dry-run` preflights identically. Validation runs
deterministically with results in `run.json`: a live `--dry-run` completes with
validated, rejected, and inconclusive findings and still skips publish
(`dry-run`) — while a non-dry-run live run validates then still fails at the
Phase 7 publisher stub (`NOT_IMPLEMENTED`, no GitHub calls).
Still open: Go allowance/billing-source surfacing beyond `raw`.

**Prompt-injection & secrets (applies to all LLM calls):** wrap code in delimited blocks and state it is untrusted data; reviewer prompt contains no secrets; no tool access for the model beyond what's strictly needed; redact secrets (regex + entropy) and skip `.env*`, `*.pem`, key files before sending; discard any finding whose output tries to change instructions/format; never execute anything suggested by the model.

---

## 8. GitHub integration & security

- Trigger: `pull_request` types `opened, synchronize, reopened`. **Never `pull_request_target`.** Fork PRs get no secrets under `pull_request`; skip them with a notice (personal repos: acceptable).
- Permissions: `contents: read`, `pull-requests: write`. Nothing else.
- `concurrency: { group: reviewer-${{ github.event.pull_request.number }}, cancel-in-progress: true }`.
- Checkout PR head SHA with `persist-credentials: false`, `fetch-depth: 0`. **Never run `bun install`, scripts, tests or builds from the reviewed repo.** The reviewer is installed from its own repo/action. Subprocesses: only `git` (and optionally `rg`), via `Bun.spawn` with an args array (no shell strings), timeouts, output size caps.
- Secrets: `OPENCODE_API_KEY` via GitHub secrets, never logged (logger redacts known secret values + patterns).
- Failure policy: reviewer failure must not block merging by default — log, upload artifact, exit 0 unless misconfiguration.
- Upload `.reviewer-out/` as a workflow artifact (always, retention 7 days).

---

## 9. Non-functional

- **Errors:** `ReviewerError{ code, retryable, cause }`. `Result<T,E>` for expected failures at module boundaries (config load, parse); throw for bugs. Exit codes: `0` ok, `1` runtime failure, `2` config/usage error.
- **Logging:** JSON lines to stderr, levels `debug|info|warn|error`, one CLI-minted `runId` shared by every line and the run artifact, redaction built in. Human-readable results go to stdout.
- **Reliability:** per-call timeout + abort, bounded retries (exp backoff + jitter) only on retryable errors, overall review-stage deadline (`review_timeout_ms`) with caller-cancel propagation, partial-failure tolerant (a failed unit ≠ failed run), head-SHA recheck before publish.
- **Cost:** skip irrelevant files, token budgets, one request per ReviewUnit with no batching, cache LLM responses by `hash(prompt+model)` in `.reviewer-cache/` (dev/eval only at first), incremental re-review on `synchronize` = only changed files since last reviewed SHA (Phase 8).

---

## 10. Project structure

```
.github/workflows/     ci.yml (tool tests), review.yml (later)
docs/adr/              decision notes
prompts/review/ prompts/validation/
src/
  cli/                 index.ts, commands/{review,config,version}.ts
  core/                pipeline.ts, errors.ts, result.ts, logger.ts, run-artifact.ts
  config/              schema.ts, defaults.ts, load.ts, migrate.ts
  diff/                   diff/                git.ts (orchestration + public surface), revisions.ts, git-exec.ts, blobs.ts, patches.ts, parse.ts, positions.ts, filters.ts, paths.ts
  context/             adapters/typescript.ts, parser.ts, search.ts, retrieve.ts, rank.ts, budget.ts
  review/              engine.ts (orchestration), stage.ts, pool.ts, unit-runner.ts, prompt.ts, normalize.ts, result.ts
  llm/                 constants.ts, training-gate.ts, preflight.ts
  validate/            engine.ts, deterministic.ts, llm.ts, dedupe.ts
  providers/           types.ts, fake.ts, json.ts, opencode.ts
  github/              client.ts, publish.ts, fingerprint.ts
  types/               diff.ts context.ts finding.ts review.ts validation.ts provider.ts index.ts
  utils/               tokens.ts, redact.ts, spawn.ts, glob.ts
tests/{unit,integration,fixtures}/
evals/                 cases/, run.ts   (Phase 8)
```

**Dependency rules:** `types` imports nothing. Engines import `types` + `providers/types` + `utils` only. Only `core/pipeline` and `cli` wire engines together. `github/` is the only place that imports Octokit. No circular imports.

---

## 11. Testing & evaluation

- **Unit:** diff parsing (fixtures incl. rename/binary/deleted/no-newline), position mapping, symbol mapping, config, finding schema, dedupe, fingerprinting, redaction.
- **Integration:** pipeline with `FakeProvider` + fixture repos (git repos built in tmp dirs); Octokit with recorded/mocked responses; deterministic offline seeded-bug smoke plus an opt-in live seeded-bug smoke (`tests/live/review-live-smoke.test.ts`, `CODEBLEACH_LIVE_SMOKE=1`, manual-only, Not-ZDR per ADR 0023).
- **Eval (Phase 8):** `evals/cases/*` = `{repo fixture, base, head, expected: [{file, line±n, category}] | []}`. Mix real historical bug-fix PRs (reverse them to reintroduce bugs), synthetic seeded bugs, and **clean PRs** (must yield zero findings). Metrics: precision, recall, false-positive rate, duplicate rate, tokens/cost/latency per PR. Gate: prompt/config changes must not drop precision; commit eval baselines and compare in CI (manually triggered, since it costs money). Prioritize precision.

---

## 12. Architecture decisions

| # | Decision | Choice | Alternatives | Why | MVP? |
|---|---|---|---|---|---|
| 1 | Entry point | CLI-first; Action wraps CLI | Action-only | Local debug/dry-run/evals | Yes |
| 2 | Agents | 1 agent, specialized prompt passes later | Multi-agent | Simpler, cheaper; split only on measured recall gaps | Yes |
| 3 | Parsing | web-tree-sitter (WASM) + per-language adapters | Native `tree-sitter` bindings; TS compiler API | WASM avoids native-build/binary issues under Bun; one API for many languages | Yes |
| 4 | Context | On-demand per PR (git grep + AST) | Full repo index | No state to invalidate; repos are small | Yes |
| 5 | Rules | Explicit authoritative; inferred advisory | Inferred-only | Inferred is noisy | Explicit yes, inferred later |
| 6 | Validation | Deterministic gates only (no LLM check in v1) | LLM-only | Cheap, objective checks catch most hallucinations | Yes (deterministic-only v1; semantic LLM deferred, ADRs 0028/0030) |
| 7 | Caching | GitHub Actions cache for inferred/index data; local dir for dev | None | Runner is ephemeral | Later |
| 8 | OpenCode | `LlmProvider` interface; surface chosen by spike | Hardcode one SDK | API shape unverified; avoid lock-in | Interface yes, impl Phase 4 |
| 9 | Multi-language | `LanguageAdapter` + wasm grammar per language | Regex fallback | Add TS first, then Python/Go | TS only |
| 10 | Comment positions | Local diff → `commentableLines`; use `line/side/commit_id` | REST `patch` parsing; legacy `position` only | Reliable on big diffs; matches current API | Yes |

---

## 13. Roadmap

| Phase | Goal | Done when |
|---|---|---|
| 1 Foundation | Bun/TS repo, types, config loader, CLI, logger, errors, provider interface, walking-skeleton pipeline with fakes, CI | `bun test` + typecheck green; `review --dry-run` produces `run.json` via fakes |
| 2 Diff Engine | deterministic git diff → `DiffResult` with positions, filters, skip reasons, one synthetic module symbol per eligible file | Fixture diffs map to correct lines/positions/symbols; identical output under hostile Git config |
| 3 Context Engine | TS adapter, definitions, callers, callees, tests, ranking, budget | `ReviewUnit`s for a fixture repo contain expected items within budget |
| 4 Review Engine | OpenCode spike → provider, prompts, Zod parse, repair retry, result/usage/artifact | Done (P4-10, ADR 0020): deterministic seeded-bug smoke green, garbage/incomplete handled, suite + types green, x-plat CI |
| 5 Validation | Deterministic checks, same-run dedupe (done, deterministic-only v1, ADRs 0028–0038; no LLM check) | Hallucinated file/line/evidence rejected in tests |
| 6 Repo awareness | Rules → prompt, path overrides, inferred conventions + cache (planning-only, ADRs 0039–0041; no `src/conventions/` runtime exists) | Explicit rules affect prompts; inferred advisory-only via separate pass (isolated §5.2 policy, §5.3 merge domains + §5.3.1 entry point, §5.4 head-coordinate conflict, §5.5 handoff envelope; transient-only diagnostics), never overrides |
| 7 GitHub | Octokit publisher, workflow, dedupe markers, SHA recheck (not started; no runtime exists) | Real PR gets correct inline comments, no dupes on re-push |
| 8 Eval/optimize | Eval harness, baselines, caching, incremental review (not started) | Precision/cost tracked per change |

---

## 14. Risks

LLM hallucinated findings (→ validation, silence default) · wrong comment positions (→ computed from local diff, 422 fallback) · name-based caller resolution misses/over-matches (→ cap, label as best-effort) · OpenCode API shape/stability (→ spike, interface, retries) · prompt injection via code (→ delimiting, no tools, discard) · cost blowups on large PRs (→ file/line/token caps, skip rules) · concurrent pushes (→ cancel-in-progress, SHA recheck).

## 15. Postpone

Vector search/embeddings · multi-agent · auto-fix commits · PR chat/`@reviewer` commands · dashboards · non-TS languages · cross-repo context · learning from 👍/👎 · type-checker-grade symbol resolution · SARIF/Check Runs output.

## 16. MVP complete when

On a real PR in your own repo: Action runs on open/push, posts ≤10 inline comments on correct lines with evidence, no duplicates on re-push, ignores generated/binary files, respects `.reviewer.yml`, fails open, produces a debug artifact, and the eval set shows precision you accept (target ≥ 0.8 on seeded cases, zero findings on clean PRs).
