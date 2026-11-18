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
2. **Deterministic where possible.** Diff, positions, ids, dedupe, schema checks, evidence checks = code. Only bug-finding and semantic validation = LLM.
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
→ (optional) LLM validation → dedupe vs existing PR comments → rank & cap
→ verify head SHA unchanged → publish review → write artifact
```

---

## 4. Module designs

### 4.1 Diff Engine (`src/diff`)
- **Source of truth:** local `git diff --find-renames --unified=3 <merge-base>..<head>` (needs `fetch-depth: 0` or explicit SHA fetch). Don't rely on the REST `patch` field (truncated for large files).
- Parse unified diff into `ChangedFile[]` → `DiffHunk[]` → `DiffLine[]` with `oldLine`, `newLine`, and GitHub `position`.
- **Valid comment targets** = lines on the RIGHT side present in a hunk (added or context). Compute `Set<number>` per file (`commentableLines`).
- Use the review-comment API's `line` + `side: "RIGHT"` + `commit_id`; keep `position` as computed fallback.
- Filters (each yields `skipReason`): binary, deleted-only, lockfiles, `dist/`, `*.min.*`, generated (header markers `@generated`, `DO NOT EDIT`), files > N KB / N changed lines (config-driven), unsupported language (still listed, but no symbols).
- Renames: carry `oldPath`; review only if content changed.
- **Symbol mapping:** parse head file with tree-sitter, collect function/method/class nodes with line ranges, intersect with `changedLines` (added lines) → `ChangedSymbol[]`. Multiple hunks in one symbol merge into one symbol with all `changedLines`. Changed lines outside any symbol → synthetic `module-level` symbol.
- **Initial languages:** TypeScript/TSX/JavaScript only. Add languages via a `LanguageAdapter` (see 4.2).

### 4.2 Context Engine (`src/context`)
On-demand, per PR, **no persistent index** in MVP.

`LanguageAdapter` interface (one per language): grammar wasm path, queries for definitions / imports / calls / types, test-file heuristics, symbol-name extraction.

For each `ChangedSymbol`, collect `ContextItem`s:

| Kind | How |
|---|---|
| definition | full function text + enclosing class/module header |
| imports/types | resolve import specifiers in file → read referenced type/interface definitions (relative imports only at first) |
| callees | tree-sitter call expressions in body → resolve through imports → definition text (signature + body, truncated) |
| callers | `git grep -n -w <symbolName>` (or `rg`) on head → parse hit files → keep hits that are real call expressions (not strings/comments) → enclosing function text. Cap N. |
| tests | files matching test patterns that import the changed file OR mention the symbol name; ranked by (imports file) > (mentions symbol) > (same dir/name) |
| config | files referenced by `process.env.X`/config keys used in symbol (grep) — later |
| similar | sibling functions in same file/dir with same kind; grep by shared identifiers — later, only if eval shows value |
| conventions | explicit rules from config (always) + inferred (Phase 6) |

Ranking: score = kind weight × proximity (same file > imported > grep hit) × reference count decay. Fill a **token budget** per ReviewUnit (default ~12k tokens context, hard cap config) in score order; always include definition + diff. Record `reason` and `tokens` per item. Unsupported language → diff hunks + ±30 lines surrounding file text only.

Symbol resolution is **best-effort by name + import path**, not a type checker. Be explicit in prompts that callers/callees may be incomplete.

### 4.3 Review Engine (`src/review`)
- **MVP: one agent, one pass per ReviewUnit** with a single focused prompt (bugs, null handling, security, regressions). Add specialized passes (security, concurrency, perf) as separate prompt files only if evals show recall gaps. Separate agents are justified only when a pass needs different tools/context or different models for cost; not before.
- Input: `ReviewUnit` (diff hunks with line numbers, symbol, context items, rules).
- Output: `RawReviewOutput` (Zod). The LLM never produces ids, SHAs or fingerprints — code adds them.
- Batch small units per call to save tokens; split large ones. Bounded concurrency (default 3).
- Prompt rules: report only issues introduced by the PR; cite exact code in `evidence`; use only provided context; say nothing if no confirmed bug (`findings: []` is a valid answer); untrusted code goes inside delimited blocks and is declared as data.

### 4.4 Validation Engine (`src/validate`)
Ordered; cheap/deterministic first. Any hard failure → reject.

**Deterministic (code):**
1. Schema valid. 2. `file` is in the PR diff. 3. `line` exists in head file. 4. `line` ∈ `commentableLines` (else try nearest changed line of same symbol within ±N, else reject). 5. `evidence.quote` appears verbatim (whitespace-normalized) in file at/near cited range or in provided context. 6. Line/symbol touched by PR (`introducedByPr`). 7. Severity ≥ threshold and confidence ≥ threshold (per category). 8. Not a duplicate (fingerprint, plus same file+symbol+category similarity). 9. Not already posted on this PR. 10. Not matched by ignore rules.

**Semantic (LLM, optional, only for findings that pass deterministic checks and are severity ≥ medium):** independent prompt, fresh context, *different framing* ("try to refute this finding using the code; answer `confirmed | refuted | inconclusive` with evidence"). Prefer a different model than the reviewer if available. A same-model self-check is a weak signal — never the only gate for high severity.

**Outcome:** `accepted | rejected | inconclusive`. `inconclusive` ⇒ discard (logged). Every check records `{name, passed, detail}` for eval/debug.

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
  kind: "function" | "method" | "class" | "module";
  container?: string;
  startLine: number; endLine: number;
  changedLines: number[];      // head-side added line numbers inside this symbol
}
export interface ChangedFile {
  path: string; oldPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed";
  language: Language | null;
  skipReason?: "binary" | "generated" | "too-large" | "ignored" | "deleted" | "lockfile";
  hunks: DiffHunk[];
  commentableLines: number[];
  symbols: ChangedSymbol[];
}
export interface DiffResult { baseSha: string; headSha: string; mergeBase: string; files: ChangedFile[] }

// ---- Context ----
export interface ContextItem {
  id: string;
  kind: "definition" | "caller" | "callee" | "type" | "test" | "config" | "similar" | "rule";
  file: string; startLine: number; endLine: number;
  text: string; score: number; tokens: number; reason: string;
}
export interface ReviewUnit {
  id: string;
  file: ChangedFile; symbol: ChangedSymbol;
  context: ContextItem[];
  rules: Rule[];               // explicit first, inferred second (flagged)
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
  fingerprint: string;         // sha1(file + symbol + category + normalized title) — stable across runs
  headSha: string;
  symbol?: string;
  origin: { pass: string; unitId: string };
}

// ---- Validation ----
export interface CheckResult { name: string; passed: boolean; detail?: string }
export interface ValidatedFinding {
  finding: Finding;
  status: "accepted" | "rejected" | "inconclusive";
  checks: CheckResult[];
  llmVerdict?: { verdict: "confirmed" | "refuted" | "inconclusive"; reasoning: string };
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
- **Inferred** (Phase 6): derived by deterministic scans (naming/export patterns, error-handling idioms, test layout, common wrappers). Stored as `{pattern, evidence files, support ratio}`; only patterns with high support are kept. Injected in a separate "advisory" section. **Inferred knowledge can never raise severity, never be the sole basis for a finding above `low`, and never override an explicit rule.** Cache in `.reviewer-cache/inferred.json` keyed by hash of sampled file list; restore via `actions/cache`; refresh when the key changes. This is a cache, not "learning".

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
ignore:
  paths: ["**/*.lock", "dist/**", "**/*.generated.*"]
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
```

Behavior: missing file → defaults. Invalid file → `ConfigError` (CLI exit 2); in Action, publish a single comment describing the config error rather than silently reviewing with defaults. Unknown keys → error (catches typos). Evolution: `version` field + `migrate(raw)` chain; new fields are always optional with defaults.

---

## 7. LLM provider & OpenCode integration

```ts
export interface LlmRequest {
  system: string; user: string;
  jsonSchema?: object;            // from z.toJSONSchema(...)
  model?: string; maxTokens?: number; temperature?: number; timeoutMs?: number;
}
export interface LlmResponse { text: string; parsed?: unknown; usage?: { inputTokens: number; outputTokens: number }; model: string; raw?: unknown }
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
- **Logging:** JSON lines to stderr, levels `debug|info|warn|error`, `runId` on every line, redaction built in. Human-readable results go to stdout.
- **Reliability:** per-call timeout + abort, bounded retries (exp backoff + jitter) only on retryable errors, partial-failure tolerant (a failed unit ≠ failed run), head-SHA recheck before publish.
- **Cost:** skip irrelevant files, token budgets, batch small units, cache LLM responses by `hash(prompt+model)` in `.reviewer-cache/` (dev/eval only at first), incremental re-review on `synchronize` = only changed files since last reviewed SHA (Phase 8).

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
  diff/                git.ts, parse.ts, positions.ts, filters.ts, symbols.ts
  context/             adapters/typescript.ts, parser.ts, search.ts, retrieve.ts, rank.ts, budget.ts
  review/              engine.ts, prompt.ts, normalize.ts
  validate/            engine.ts, deterministic.ts, llm.ts, dedupe.ts
  providers/           types.ts, fake.ts, opencode.ts
  github/              client.ts, publish.ts, fingerprint.ts
  types/               diff.ts context.ts finding.ts validation.ts provider.ts index.ts
  utils/               tokens.ts, redact.ts, spawn.ts, glob.ts
tests/{unit,integration,fixtures}/
evals/                 cases/, run.ts   (Phase 8)
```

**Dependency rules:** `types` imports nothing. Engines import `types` + `providers/types` + `utils` only. Only `core/pipeline` and `cli` wire engines together. `github/` is the only place that imports Octokit. No circular imports.

---

## 11. Testing & evaluation

- **Unit:** diff parsing (fixtures incl. rename/binary/deleted/no-newline), position mapping, symbol mapping, config, finding schema, dedupe, fingerprinting, redaction.
- **Integration:** pipeline with `FakeProvider` + fixture repos (git repos built in tmp dirs); Octokit with recorded/mocked responses; opt-in live OpenCode test (`LIVE=1`).
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
| 6 | Validation | Deterministic gates + optional independent LLM check | LLM-only | Cheap, objective checks catch most hallucinations | Deterministic yes, LLM Phase 5 |
| 7 | Caching | GitHub Actions cache for inferred/index data; local dir for dev | None | Runner is ephemeral | Later |
| 8 | OpenCode | `LlmProvider` interface; surface chosen by spike | Hardcode one SDK | API shape unverified; avoid lock-in | Interface yes, impl Phase 4 |
| 9 | Multi-language | `LanguageAdapter` + wasm grammar per language | Regex fallback | Add TS first, then Python/Go | TS only |
| 10 | Comment positions | Local diff → `commentableLines`; use `line/side/commit_id` | REST `patch` parsing; legacy `position` only | Reliable on big diffs; matches current API | Yes |

---

## 13. Roadmap

| Phase | Goal | Done when |
|---|---|---|
| 1 Foundation | Bun/TS repo, types, config loader, CLI, logger, errors, provider interface, walking-skeleton pipeline with fakes, CI | `bun test` + typecheck green; `review --dry-run` produces `run.json` via fakes |
| 2 Diff Engine | git diff → `DiffResult` with positions, filters, symbols | Fixture diffs map to correct lines/symbols |
| 3 Context Engine | TS adapter, definitions, callers, callees, tests, ranking, budget | `ReviewUnit`s for a fixture repo contain expected items within budget |
| 4 Review Engine | OpenCode spike → provider, prompts, Zod parse, repair retry | Seeded-bug fixtures yield findings; garbage output handled |
| 5 Validation | Deterministic checks, dedupe, optional LLM check | Hallucinated file/line/evidence rejected in tests |
| 6 Repo awareness | Rules → prompt, path overrides, inferred conventions + cache | Explicit rules affect prompts; inferred never overrides |
| 7 GitHub | Octokit publisher, workflow, dedupe markers, SHA recheck | Real PR gets correct inline comments, no dupes on re-push |
| 8 Eval/optimize | Eval harness, baselines, caching, incremental review | Precision/cost tracked per change |

---

## 14. Risks

LLM hallucinated findings (→ validation, silence default) · wrong comment positions (→ computed from local diff, 422 fallback) · name-based caller resolution misses/over-matches (→ cap, label as best-effort) · OpenCode API shape/stability (→ spike, interface, retries) · prompt injection via code (→ delimiting, no tools, discard) · cost blowups on large PRs (→ file/line/token caps, skip rules) · concurrent pushes (→ cancel-in-progress, SHA recheck).

## 15. Postpone

Vector search/embeddings · multi-agent · auto-fix commits · PR chat/`@reviewer` commands · dashboards · non-TS languages · cross-repo context · learning from 👍/👎 · type-checker-grade symbol resolution · SARIF/Check Runs output.

## 16. MVP complete when

On a real PR in your own repo: Action runs on open/push, posts ≤10 inline comments on correct lines with evidence, no duplicates on re-push, ignores generated/binary files, respects `.reviewer.yml`, fails open, produces a debug artifact, and the eval set shows precision you accept (target ≥ 0.8 on seeded cases, zero findings on clean PRs).
