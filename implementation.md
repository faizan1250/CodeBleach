# implementation.md — Phase 1: Project Foundation

> **Purpose:** This document is the implementation checklist for Phase 1 of CodeBleach. Read `systemdesign.md` first. `systemdesign.md` remains the architectural source of truth; this document defines the work to complete in Phase 1.
>
> **Phase 1 is foundation only.** Do not implement Git diff parsing, code parsing, repository context retrieval, real LLM calls, review prompts, finding validation, inferred conventions, or GitHub publishing.

## 1. Objective

Deliver a working Bun + TypeScript project with:

- A reproducible Bun project setup and strict TypeScript configuration.
- Shared data contracts and Zod schemas at trust boundaries.
- Typed errors, a `Result<T, E>` type, and a structured JSON logger with secret redaction.
- A versioned, strict `.reviewer.yml` schema, defaults, migration entry point, and loader.
- An `LlmProvider` interface, a scripted `FakeProvider`, and a JSON parsing/repair helper.
- A pipeline whose stages are interfaces and test/demo fakes only.
- A CLI with `review`, `config validate`, `config print`, and `version` commands.
- CI that runs typechecking and tests.
- An `AGENTS.md` containing implementation rules for future coding agents.

At the end of Phase 1, this command must run without network access or real LLM/GitHub calls:

```bash
bun run src/cli/index.ts review --demo --dry-run
```

It must exit successfully and write a complete `.reviewer-out/run.json` containing synthetic outputs from every pipeline stage. This proves the contracts and orchestration work together; it does **not** prove that PR review logic works.

## 2. Scope boundaries

### Included

- Bun + TypeScript bootstrap.
- Shared TypeScript data types and the specified Zod schemas.
- Configuration parsing, defaulting, strict validation, and version handling.
- Error and result primitives.
- JSON logging and recursive artifact/log redaction.
- LLM provider abstraction and fake implementation.
- JSON parse/validation with exactly one repair retry.
- Pipeline orchestration with stub and demo dependencies.
- Run artifact generation.
- CLI and CLI integration tests.
- CI, README, `.reviewer.yml.example`, and `AGENTS.md`.

### Explicitly excluded

| Later phase | Excluded work |
|---|---|
| Phase 2 | Git diff execution/parsing, changed-file extraction, diff positions, changed-symbol extraction |
| Phase 3 | Tree-sitter, language adapters, repository indexing, callers/callees, test/context retrieval, context ranking and token budgets |
| Phase 4 | OpenCode API calls, real provider implementation, review prompts, real finding generation |
| Phase 5 | Deterministic finding checks, semantic validation, fingerprints and production deduplication |
| Phase 6 | Inferred repository conventions and inferred-knowledge caching |
| Phase 7 | GitHub Actions review workflow, Octokit publishing, PR comments and GitHub permissions for publishing |
| Phase 8 | Evaluation dataset, metrics, baselines, cost/latency evaluation and incremental review |

Do not add these features “while already in the code.” Define only the interfaces needed to keep later phases straightforward.

## 3. Fixed technology choices

| Area | Choice |
|---|---|
| Runtime | Bun (pin the installed stable version in `.bun-version`) |
| Language | TypeScript, strict mode |
| Package manager | Bun; commit `bun.lock` |
| Validation | Zod v4 |
| YAML | Prefer `Bun.YAML.parse`; verify it in the pinned Bun version |
| CLI arguments | `parseArgs` from `node:util`; no CLI framework |
| Tests | `bun test` |
| LLM integration | Interface only in Phase 1; no real OpenCode calls |
| External runtime dependencies | `zod` only |

Development dependencies: `typescript` and `@types/bun` (add another package only if the pinned Bun version demonstrably requires it). Do not add Commander, dotenv, Chalk, Lodash, a YAML dependency, a database, or an HTTP client in this phase.

If `Bun.YAML.parse` is unavailable in the pinned version, add the smallest suitable YAML package and record the reason in `docs/adr/`. Do not assume the API exists without a test.

## 4. Implementation rules

1. Read `systemdesign.md` before changing code.
2. Complete tickets P1-01 through P1-08 in order.
3. Keep every ticket typechecked and tested before moving on.
4. Make one commit per completed ticket, unless the user explicitly asks not to commit.
5. Add or update an ADR when changing an architectural decision or public contract.
6. Use `unknown`, not `any`, at untrusted boundaries.
7. Use Zod at trust boundaries; do not create redundant runtime schemas for every internal TypeScript interface.
8. Keep CLI code limited to argument parsing, dependency wiring, output, and exit-code mapping.
9. Keep logs on stderr and command results on stdout.
10. Tests must not make network calls and must not require secrets.
11. Do not execute source code from a reviewed repository.
12. Do not implement real Git, GitHub, or OpenCode functionality in Phase 1.

### Contract-location refinement

`systemdesign.md` currently places stage interfaces in `src/types`. In implementation, keep `src/types` limited to plain shared data contracts and place orchestration/stage interfaces in `src/core/contracts.ts`. These interfaces depend on shared data types and the resolved configuration type; they must not expose engine internals. Record this small refinement in `docs/adr/0001-contract-boundaries.md` and update the corresponding section of `systemdesign.md` when implementing the ticket. Do not introduce circular imports.

## 5. Project structure for Phase 1

Create this structure (small naming adjustments are acceptable only when documented):

```text
.github/
  workflows/
    ci.yml
AGENTS.md
.bun-version
.gitignore
.reviewer.yml.example
README.md
package.json
bun.lock
tsconfig.json

docs/
  adr/
    0001-contract-boundaries.md

src/
  cli/
    index.ts
    commands/
      review.ts
      config.ts
      version.ts
  config/
    schema.ts
    defaults.ts
    migrate.ts
    load.ts
  core/
    contracts.ts
    errors.ts
    result.ts
    logger.ts
    pipeline.ts
    run-artifact.ts
    stubs.ts
    demo.ts
  providers/
    types.ts
    fake.ts
    json.ts
  types/
    diff.ts
    context.ts
    finding.ts
    validation.ts
    rules.ts
    github.ts
    publish.ts
    index.ts
  utils/
    redact.ts

tests/
  unit/
  integration/
  fixtures/
    config/
    stubs.ts
```

`src/types` must not import from other `src/` directories. It may contain plain interfaces, type aliases, and enums/unions. `src/core/contracts.ts` owns the stage interfaces. `src/core/pipeline.ts` is the only module that orchestrates stages. The CLI wires concrete stub/demo implementations into the pipeline.

## 6. Tickets

Complete sequentially. Each ticket includes its deliverables and acceptance criteria.

---

### P1-01 — Repository bootstrap

**Create:** `package.json`, `tsconfig.json`, `.bun-version`, `.gitignore`, `README.md`, `src/`, `tests/`, and `docs/adr/0001-contract-boundaries.md`.

**Tasks**

- Initialize the repository with Bun.
- Pin the actual stable Bun version used for development in `.bun-version`.
- Set `package.json` to `"type": "module"` and `"private": true`.
- Add scripts:

```json
{
  "test": "bun test",
  "typecheck": "tsc --noEmit",
  "review": "bun run src/cli/index.ts review",
  "check": "bun run typecheck && bun test"
}
```

- Configure TypeScript with at least:
  - `strict: true`
  - `noUncheckedIndexedAccess: true`
  - `noImplicitOverride: true`
  - `verbatimModuleSyntax: true`
  - `moduleResolution: "bundler"`
  - `module: "Preserve"`
  - `target: "ESNext"`
  - `types: ["bun"]`
  - `noEmit: true`
  - `baseUrl: "."` and `paths: { "@/*": ["./src/*"] }` if using the `@/` alias.
- Ensure the chosen alias works in both Bun runtime and TypeScript. If alias support requires extra configuration, prefer relative imports rather than adding a runtime dependency.
- Add `.gitignore` entries for `node_modules/`, `.reviewer-out/`, `.reviewer-cache/`, `.env`, `.env.*`, and temporary files.
- Commit the generated `bun.lock`.
- Keep README concise: what CodeBleach is, prerequisites, install, check, and demo command.
- Add ADR `0001-contract-boundaries.md` documenting why pure data contracts live in `src/types` and stage interfaces live in `src/core/contracts.ts`.

**Accept**

- `bun install --frozen-lockfile` succeeds on a clean checkout.
- `bun run check` passes with one minimal placeholder test.
- The pinned Bun version is documented and reproducible.
- `zod` is the only runtime dependency.

---

### P1-02 — Shared types and Zod schemas

**Create:** `src/types/{diff,context,finding,validation,rules,github,publish,index}.ts`.

**Tasks**

- Implement the pure data interfaces from `systemdesign.md` §5 for diff, context, findings, and validation.
- Add the missing shared types required by the architecture:
  - `Rule` and `RuleKind`.
  - `PrMeta` (repository owner/name, PR number, base SHA, head SHA, and any minimal metadata required by the pipeline).
  - `PublishResult` (published count, skipped count, and a typed list of per-comment failures; no GitHub implementation yet).
- Do not put `ResolvedConfig` in `src/types`; it is the output type of the config schema and belongs to `src/config`.
- Keep stage interfaces out of `src/types`; define them in P1-06 under `src/core/contracts.ts`.
- Define Zod schemas only for trust-boundary data needed in Phase 1:
  - `SeveritySchema`
  - `CategorySchema`
  - `EvidenceSchema`
  - `RawFindingSchema`
  - `RawReviewOutputSchema`
  - `LlmVerdictSchema`
- Derive corresponding types from schemas with `z.infer` instead of duplicating schema-backed types.
- Use `z.strictObject` for LLM response schemas so unknown keys are rejected.

**Finding schema requirements**

- `title`: non-empty, maximum 120 characters.
- `description`: non-empty, maximum 2,000 characters.
- `suggestion`: optional, maximum 2,000 characters.
- `file`: non-empty string.
- `line`: positive integer.
- `endLine`: optional positive integer and, when provided, must be greater than or equal to `line`.
- `confidence`: number from 0 through 1.
- `evidence`: at least one evidence item; each item has a non-empty file, valid positive start/end lines, and a non-empty quote.
- `introducedByPr`: boolean claim from the model; later phases must independently verify it.
- `ruleId`: optional string.
- `RawFinding` must not contain `id`, `fingerprint`, `headSha`, or `origin`; application code adds these later.

**Accept**

- Valid finding parses successfully.
- Missing evidence, confidence outside 0–1, unknown keys, invalid line numbers, and `endLine < line` fail with useful errors.
- `z.toJSONSchema(RawReviewOutputSchema)` succeeds.
- `src/types` has no imports from other `src/` directories.
- Tests cover all schema constraints and exports.

---

### P1-03 — Errors, Result, logger, and redaction

**Create:** `src/core/{errors,result,logger}.ts` and `src/utils/redact.ts`.

**Tasks**

**Errors**

Implement:

```ts
export type ErrorCode =
  | "CONFIG_INVALID"
  | "CONFIG_UNSUPPORTED_VERSION"
  | "GIT_FAILED"
  | "PARSE_FAILED"
  | "PROVIDER_FAILED"
  | "PROVIDER_BAD_OUTPUT"
  | "GITHUB_FAILED"
  | "NOT_IMPLEMENTED"
  | "INTERNAL";

export class ReviewerError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(input: {
    code: ErrorCode;
    message: string;
    retryable?: boolean;
    cause?: unknown;
  });
}
```

Use this constructor shape consistently. Preserve `cause` and set a useful error name. Do not construct errors with an ambiguous positional string argument.

**Result**

Implement:

```ts
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ...;
export const err = <E>(error: E): Result<never, E> => ...;
```

**Logger**

- `createLogger({ level, runId, secrets? })` returns `debug/info/warn/error(msg, fields?)`.
- Emit one JSON object per line to stderr; never log routine messages to stdout.
- Every line includes `ts`, `level`, `runId`, and `msg`.
- Support nested fields containing arrays and objects.
- Serialize `Error` values safely (`name`, redacted `message`, optional redacted stack); do not JSON-stringify errors into `{}`.
- Redact before serialization.

**Redaction**

- `redact(text: string, extraSecrets?: string[]): string` replaces exact supplied secret values and recognizable token patterns with `[REDACTED]`.
- Include patterns for GitHub tokens, common `sk-`-style API keys, AWS access key IDs, bearer authorization values, and PEM private-key blocks.
- Sort exact secret values longest-first and ignore empty values.
- Add a recursive sanitizer for artifact/logger payloads. It must redact nested string values and values under obviously sensitive keys such as `token`, `password`, `secret`, `api_key`, `apiKey`, and `authorization`.
- Do not log full environment variables, request headers, or provider payloads by default.

**Accept**

- Unit tests cover every redaction pattern and exact secret replacement.
- Nested objects and arrays are redacted.
- Sensitive-key values are redacted even when their value does not match a known token pattern.
- Logger output is valid JSONL written to stderr.
- A secret passed through `secrets` never appears in logger output or serialized run artifacts.

---

### P1-04 — `.reviewer.yml` schema, defaults, migration, and loader

**Create:** `src/config/{schema,defaults,migrate,load}.ts`, `tests/fixtures/config/`, and `.reviewer.yml.example`.

**Tasks**

- Implement schema version 1 based on `systemdesign.md` §6.
- Use `z.strictObject` at every object level so misspelled and unknown keys fail.
- All optional user-facing settings receive explicit defaults. `version` defaults to `1` when absent.
- The loaded `ResolvedConfig` must be fully defaulted for fields used by later phases. Path overrides may remain intentionally partial because they represent selective overrides.
- Include the following schema areas:
  - `version`
  - `review.enabled`
  - `review.categories` (`bugs`, `security`, `performance`, `concurrency`)
  - `review.severity_threshold`
  - `review.confidence_threshold`
  - `review.category_overrides`
  - `review.max_findings`
  - `review.max_changed_lines_per_file`
  - `ignore.paths`
  - `repository.language`
  - `rules[]` with unique `id`, `kind`, `text`, optional `paths`, and optional `severity`
  - `path_overrides[]` with `paths` and a partial `review` override.
- Validate confidence thresholds in the inclusive range 0–1, positive integer limits, non-empty rule text, supported rule kinds, and unique rule IDs.
- Support `typescript`, `tsx`, and `javascript` as initial language values.
- Use defaults from `systemdesign.md`, plus ignore patterns for `build/**`, `node_modules/**`, and `**/*.snap`.
- Keep defaults in one module; do not duplicate them in CLI code or tests.

**Migration behavior**

- `migrate(raw: unknown)` first validates that the YAML root is an object and reads its version.
- Missing version means version 1.
- Version 1 passes through the v1 migration path.
- A version greater than 1 returns `CONFIG_UNSUPPORTED_VERSION`.
- A malformed or unsupported lower version returns `CONFIG_INVALID`.
- Structure migrations as a version-to-version chain so a future v2 migration can be added without rewriting the loader.

**Loader contract**

```ts
type ConfigLoadResult = {
  config: ResolvedConfig;
  source: "file" | "defaults";
  path?: string;
};

function loadConfig(repoDir: string): Promise<Result<ConfigLoadResult, ReviewerError>>;
```

- Missing `.reviewer.yml` → return defaults.
- YAML syntax error → `CONFIG_INVALID` with the config path and line/column when the parser provides them.
- Schema error → `CONFIG_INVALID` with readable dotted paths (for example, `review.confidence_threshold: expected a number between 0 and 1`).
- Read only `.reviewer.yml` at the repository root.
- Resolve and verify the config file path remains inside the supplied repository directory; reject a symlink that points outside the repo.
- Do not silently fall back to defaults when a present config file is invalid.
- Verify `Bun.YAML.parse` exists in the pinned Bun version with a test. Add a YAML dependency only if that test proves it is unavailable.

**Example config**

Create `.reviewer.yml.example` with a valid v1 configuration and comments explaining the main options. It must pass the same loader/schema validation as a real config file.

**Accept**

- Missing file returns fully resolved defaults.
- Valid minimal and full configs parse.
- `.reviewer.yml.example` parses.
- Unknown/typo keys fail.
- Wrong types and out-of-range thresholds fail.
- Duplicate rule IDs fail.
- `version: 2` returns `CONFIG_UNSUPPORTED_VERSION`.
- Malformed YAML returns `CONFIG_INVALID` with a useful message.
- A config symlink escaping `repoDir` is rejected.
- `config print` can serialize the resolved config as JSON.

---

### P1-05 — LLM provider contract, FakeProvider, and JSON repair helper

**Create:** `src/providers/{types,fake,json}.ts`; re-export provider types from `src/types/provider.ts` only if required by the shared type barrel. Avoid duplicate interface definitions.

**Tasks**

Implement the provider contracts from `systemdesign.md`:

```ts
export interface LlmRequest {
  system: string;
  user: string;
  jsonSchema?: object;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface LlmResponse {
  text: string;
  parsed?: unknown;
  usage?: { inputTokens: number; outputTokens: number };
  model: string;
  raw?: unknown;
}

export interface LlmProvider {
  readonly name: string;
  readonly capabilities: {
    structuredOutput: boolean;
    streaming: boolean;
  };
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}
```

**FakeProvider**

- Accept scripted steps: `{ match?: (request) => boolean; respond: string | object | Error }[]`.
- Record every request in a public read-only `calls` collection for assertions.
- Consume the first matching scripted step in order.
- `Error` responses are thrown.
- String responses become `LlmResponse.text` directly.
- Object responses are serialized with `JSON.stringify` and placed in `LlmResponse.text`; do not pretend the provider has already validated them.
- Use stable fake model metadata and no network calls.
- Throw a clear test error if no scripted step matches.

**JSON helper**

Implement:

```ts
completeJson<T>(
  provider: LlmProvider,
  request: LlmRequest,
  schema: z.ZodType<T>
): Promise<T>
```

- Parse `LlmResponse.text`; do not trust `response.parsed` as a substitute for validation.
- Strip a surrounding Markdown JSON code fence only when the entire response is fenced.
- Validate parsed data with Zod.
- On JSON parse or schema validation failure, make exactly one repair request. Include the original malformed response and concise validation errors in the repair request.
- Validate the repair response again.
- After the second failure, throw `ReviewerError` with code `PROVIDER_BAD_OUTPUT`.
- Do not retry provider/network errors in this helper; provider retry policy belongs to the concrete provider in a later phase.

**Accept**

- Valid JSON succeeds on the first call.
- Fully fenced JSON succeeds.
- Invalid JSON and schema-invalid JSON each trigger exactly one repair attempt.
- Repair request includes the validation error and original invalid response.
- Invalid response twice yields `PROVIDER_BAD_OUTPUT`.
- Provider-thrown errors propagate unchanged.
- Unmatched FakeProvider scripts fail loudly.

---

### P1-06 — Stage contracts, stub engines, demo fakes, and walking-skeleton pipeline

**Create:** `src/core/{contracts,pipeline,run-artifact,stubs,demo}.ts` and `tests/fixtures/stubs.ts`.

**Stage contracts**

Place stage interfaces in `src/core/contracts.ts`. They should use only public shared data types and `ResolvedConfig`; do not expose engine implementation types.

```ts
export interface DiffEngine {
  run(input: {
    repoDir: string;
    baseSha: string;
    headSha: string;
    config: ResolvedConfig;
  }): Promise<DiffResult>;
}

export interface ContextEngine {
  build(diff: DiffResult, config: ResolvedConfig, repoDir: string): Promise<ReviewUnit[]>;
}

export interface ReviewEngine {
  review(units: ReviewUnit[], config: ResolvedConfig): Promise<Finding[]>;
}

export interface ValidationEngine {
  validate(
    findings: Finding[],
    diff: DiffResult,
    units: ReviewUnit[],
    config: ResolvedConfig
  ): Promise<ValidatedFinding[]>;
}

export interface Publisher {
  publish(
    findings: ValidatedFinding[],
    diff: DiffResult,
    meta: PrMeta
  ): Promise<PublishResult>;
}
```

Add `PrMeta`, `PublishResult`, `RunSummary`, and any minimal artifact types needed to the appropriate shared/core type modules. Do not invent GitHub API behavior in these types.

**Pipeline contract**

```ts
runPipeline(
  deps: {
    diff: DiffEngine;
    context: ContextEngine;
    review: ReviewEngine;
    validation: ValidationEngine;
    publisher: Publisher;
    logger: Logger;
  },
  input: {
    repoDir: string;
    baseSha: string;
    headSha: string;
    pr?: PrMeta;
    dryRun: boolean;
    outDir: string;
  }
): Promise<RunSummary>;
```

`runPipeline` loads configuration through the config loader before invoking any engine. Keep the loader easy to replace in tests (for example, an optional injected `loadConfig` dependency with the production loader as default).

**Execution order**

1. Create `runId` and start timestamp.
2. Load config.
3. Run diff stage.
4. Run context stage.
5. Run review stage.
6. Run validation stage.
7. Publish unless `dryRun` is true.
8. Write/update the final run artifact and return `RunSummary`.

**Timing and artifact behavior**

- Record each stage's name, status, duration in milliseconds, and useful item count where applicable.
- `dryRun: true` must skip the publisher entirely and record it as `skipped` with reason `dry-run`.
- Write `.reviewer-out/run.json` (or the supplied `outDir`) after each completed stage and again on completion/failure, using an atomic temp-file-and-rename strategy.
- Artifact must be JSON-serializable, pretty-printed, and recursively redacted before writing.
- Include `schemaVersion`, `runId`, `startedAt`, `completedAt`, `baseSha`, `headSha`, `configSource`, resolved config snapshot, stage results, available intermediate outputs, final status, and serialized error when present.
- Suggested statuses: `running`, `completed`, `failed`.
- Config errors must stop execution before any engine stage. Still attempt to write a failed artifact with no engine stages completed and `configSource: "unavailable"` when config cannot be loaded.
- A `ReviewerError` from a stage ends the run, records the failed stage and error, writes the artifact, and is re-thrown. Convert unexpected thrown values into a non-retryable `INTERNAL` error while preserving the original cause.
- If artifact writing itself fails, surface that failure without silently claiming the run was saved. Preserve the original pipeline error as cause/context where possible.

**Stubs versus demo fakes**

- `src/core/stubs.ts`: real CLI default wiring for Phase 1. Each not-yet-implemented stage throws `ReviewerError({ code: "NOT_IMPLEMENTED", ... })`.
- `src/core/demo.ts`: deterministic synthetic engines used only with `--demo`. Return a small, internally consistent dataset (for example, one changed file, one review unit, two findings, and one accepted validation result).
- `tests/fixtures/stubs.ts`: test-only fakes with configurable outputs, call recording, and failure injection.
- Do not make demo mode read or parse the current Git repository. The demo dataset must be stable and offline.

**Accept**

- Fakes produce a complete artifact with all expected stage outputs and counts.
- Stage call order is asserted.
- `dryRun` never calls the publisher.
- A stage failure writes a failed artifact and is re-thrown.
- Config failure invokes no stage and still attempts a failed artifact.
- Artifact updates are valid JSON and nested secrets are redacted.
- Artifact path uses the requested output directory.

---

### P1-07 — CLI

**Create:** `src/cli/index.ts` and `src/cli/commands/{review,config,version}.ts`.

**Commands**

```bash
# Normal CLI contract (will hit Phase 1 stubs and return NOT_IMPLEMENTED)
bun run src/cli/index.ts review --base <sha> --head <sha> [--repo .] [--out .reviewer-out] [--dry-run] [--log-level info]

# Offline demo; synthetic SHAs are supplied internally
bun run src/cli/index.ts review --demo --dry-run

bun run src/cli/index.ts config validate [--repo .]
bun run src/cli/index.ts config print [--repo .]
bun run src/cli/index.ts version
```

**Tasks**

- Use `parseArgs` from `node:util` with strict option parsing.
- Support `--help` with concise usage output.
- Unknown flags, missing option values, invalid command combinations, or missing required normal-review arguments → usage message and exit code `2`.
- Normal `review` requires both `--base` and `--head` (environment fallbacks: `REVIEWER_BASE_SHA`, `REVIEWER_HEAD_SHA`).
- `--demo` is permitted only with `review`; it supplies deterministic synthetic base/head identifiers if not provided. Demo mode must not call Git, GitHub, or any network service.
- `REVIEWER_LOG_LEVEL` is the fallback for `--log-level`.
- `--repo` defaults to `.`; `--out` defaults to `.reviewer-out`.
- `review` without `--demo` wires the stub engines. It writes a failed artifact, prints a clear not-implemented message, and exits `1`.
- `review --demo --dry-run` wires deterministic demo fakes, skips publisher, prints a concise success summary, and exits `0`.
- `--dry-run` means “do not publish.” It must not be described as a general offline guarantee in later phases; Phase 1 demo mode is explicitly offline because it uses only fakes.
- `config validate`: print whether the file is valid or defaults are being used; invalid config exits `2`.
- `config print`: print the fully resolved configuration as JSON to stdout; logs remain on stderr.
- `version`: read and print the version from `package.json`; do not duplicate a separate hard-coded version constant.
- Centralize exit-code mapping: `0` success, `1` runtime/stage failure, `2` usage or config error.
- Avoid `process.exit()` when possible; set `process.exitCode` so stdout/stderr can flush.
- No business logic in `cli/`; it parses args, wires dependencies, calls `core/`, and formats user-facing output.

**Accept (spawn the CLI in tests)**

- `config validate` with valid, invalid, and missing config directories returns expected exit codes and messages.
- `config print` emits valid JSON and includes defaults when no config file exists.
- Normal `review` with missing `--base` or `--head` exits `2`.
- Normal `review --base x --head y` reaches stubs, writes failed artifact, and exits `1`.
- `review --demo --dry-run` exits `0` and writes a complete `.reviewer-out/run.json` without network access.
- `version` matches `package.json`.
- Unknown flags and invalid command combinations exit `2`.

---

### P1-08 — CI and repository hygiene

**Create:** `.github/workflows/ci.yml` and `AGENTS.md`.

**CI tasks**

- Trigger on `push` and `pull_request`.
- Set minimum permissions: `contents: read`.
- Pin third-party Actions to verified full commit SHAs; add a comment with the corresponding release tag. Do not guess SHAs.
- Checkout with `persist-credentials: false`.
- Set up the Bun version from `.bun-version` using the supported input of the pinned setup action.
- Run:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
```

- Do not add the future PR-review workflow in Phase 1.

**AGENTS.md tasks**

Keep it to 40 lines or fewer. Include:

- Commands to install, typecheck, test, and run the demo.
- Dependency direction and module ownership.
- “Zod only at trust boundaries.”
- “Never log secrets.”
- “Never execute reviewed code.”
- “Do not add real Git/GitHub/OpenCode integration before its phase.”
- “Update `systemdesign.md` and add an ADR when a public contract or architecture decision changes.”

**Accept**

- CI passes on a pull request.
- A deliberately introduced type error makes CI fail.
- A deliberately failing test makes CI fail.
- CI installs from the committed lockfile and does not require secrets.

## 7. Required test matrix

At minimum, include the following coverage before declaring Phase 1 complete.

| Area | Tests |
|---|---|
| TypeScript setup | `bun run typecheck` passes; strict compiler options are active |
| Finding schemas | Valid data; missing evidence; confidence out of range; unknown key; invalid line range |
| Error primitives | Error code, retryability, message, and cause are preserved |
| Result | `ok` and `err` constructors preserve discriminated-union behavior |
| Redaction | Exact values; GitHub token; API key; AWS key; bearer header; PEM block; nested object/array; sensitive key |
| Logger | Valid JSONL, stderr output, run ID, redacted message and fields |
| Config | Missing file; valid minimal/full file; example file; typo key; wrong type; bad threshold; duplicate IDs; unsupported version; malformed YAML; escaping symlink |
| FakeProvider | Ordered match; call recording; string response; object response serialization; thrown error; unmatched script |
| JSON helper | Valid JSON; fenced JSON; invalid JSON repair; schema repair; second failure; provider error propagation |
| Pipeline | Stage order; output counts; dry-run skips publisher; config failure; stage failure; artifact update; recursive redaction |
| CLI | Success/error exit codes; missing args; unknown flags; config commands; version; demo artifact |

Use temporary directories for filesystem tests and `Bun.spawn` for CLI integration tests. Clean up temporary directories even when assertions fail.

## 8. Artifact contract for the Phase 1 demo

The exact JSON structure may include additional metadata, but it must be versioned and should follow this shape:

```json
{
  "schemaVersion": 1,
  "runId": "demo-run-id",
  "startedAt": "2026-01-01T00:00:00.000Z",
  "completedAt": "2026-01-01T00:00:01.000Z",
  "baseSha": "demo-base",
  "headSha": "demo-head",
  "configSource": "defaults",
  "status": "completed",
  "stages": [
    { "name": "diff", "status": "completed", "ms": 1, "count": 1 },
    { "name": "context", "status": "completed", "ms": 1, "count": 1 },
    { "name": "review", "status": "completed", "ms": 1, "count": 2 },
    { "name": "validation", "status": "completed", "ms": 1, "count": 1 },
    { "name": "publish", "status": "skipped", "ms": 0, "reason": "dry-run" }
  ],
  "diff": {},
  "units": [],
  "findings": [],
  "validated": [],
  "publishResult": null
}
```

The example values are illustrative. Tests should assert the schema and relationships, not exact timestamps or durations. The demo's findings and stage results should be mutually consistent.

## 9. Definition of done

- [ ] P1-01 through P1-08 are complete.
- [ ] `bun install --frozen-lockfile` succeeds on a clean checkout.
- [ ] `bun run check` passes locally and in CI.
- [ ] `bun run src/cli/index.ts review --demo --dry-run` exits `0` and creates a complete `.reviewer-out/run.json`.
- [ ] `bun run src/cli/index.ts config validate` succeeds when no config file exists and defaults are used.
- [ ] Invalid config produces a readable error and exit code `2`.
- [ ] Normal review invocation reaches the Phase 1 stub, writes a failed artifact, and exits `1`.
- [ ] No Git diff parsing, Tree-sitter, context retrieval, real OpenCode calls, validation logic, inferred conventions, or GitHub publishing has been added.
- [ ] No network calls or secrets are needed by tests.
- [ ] `zod` is the only runtime dependency (unless a documented YAML fallback was proven necessary).
- [ ] `src/types` contains no imports from other `src/` directories.
- [ ] No circular imports exist.
- [ ] ADR and `systemdesign.md` reflect any contract-location refinement.

## 10. Handoff to Phase 2

Phase 2 implements the Diff Engine behind the existing `DiffEngine` contract. It consumes the shared diff contracts and `ResolvedConfig` ignore/size settings. Do not alter public contracts casually; if a change is required, update the types, tests, `systemdesign.md`, and an ADR in the same change.
