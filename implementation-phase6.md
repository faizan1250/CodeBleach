# CodeBleach — Phase 6: Inferred Repository Conventions

**Document type:** normative implementation plan  
**Status:** Implemented on `fix/phase6-final-hardening` (P6-00..P6-05 plus
hardening A–D, §22); routine enablement remains gated on the real-PR labeled
advisory evaluation, which has not passed yet  
**Audience:** coding agent implementing Phase 6 and reviewers approving each Phase 6 PR  
**Repository:** `faizan1250/CodeBleach`  
**Base branch:** `main`

## Baseline and source of truth

The implementation agent must fetch the latest `main` before starting. The baseline inspected for this plan is:

- **Current main / documentation baseline:** PR #72 merge, `54db1f89cdd5b12f015f8111c5f9400959860600` (2026-11-22). PR #72 is documentation-only.
- **Last runtime-source baseline:** PR #69 merge, `5b8aba80657bdd656c2dd87903133bd9f54c140b`. PRs #70–#72 changed documentation only; they did not change `src/`, tests, dependencies, or runtime configuration.
- **Phase 6 decision records:** ADR 0039 (explicit/inferred authority), ADR 0040 (advisory policy and merge isolation), ADR 0041 (validation handoff, order, transient diagnostics), and ADR 0042 (shared per-finding validation core and internal advisory validation entry).
- **Existing implementation plan:** this document replaces the earlier planning draft as the single normative Phase 6 implementation sequence. Historical ADRs are not rewritten.

If `main` has advanced, use the new main head and re-check every source reference below. Do not reset or overwrite newer work.

Read `AGENTS.md` and `systemdesign.md` before making any changes. `AGENTS.md` is authoritative for repository ownership and execution safety. In particular:

- `src/types` contains pure data types and must not import runtime modules from `src/`.
- Stage interfaces live in `src/core/contracts.ts`.
- Only `src/core/pipeline.ts` and `src/cli/` wire engines together.
- Only `src/github/` may import Octokit.
- Do not execute code, tests, or builds from a repository being reviewed. This restriction is about the untrusted target repository, not CodeBleach itself.
- For CodeBleach's own source and tests, run `bun run check` before every commit as required by `AGENTS.md`; CI is an additional gate, not a substitute for that local check.
- Never log secrets. Logs go to stderr; user-facing results go to stdout.
- Contract or architecture decisions require `systemdesign.md` updates and a new ADR. Never rewrite an accepted historical ADR.
- Keep each PR small and independently reviewable.

**Current state:** Phase 6 is implemented behind `--convention-advisory`
(default off): `src/conventions/` runtime (sampling, three detectors,
support, projection/packer, advisory review engine), shared validation core
with transient handoff, and the live eval harness under
`tests/live/phase6-eval/` all exist. The labeled evaluation gate (§16.5) has
not passed yet, so the flag stays development/experiment-only and routine use
is not recommended. With the flag absent the runtime performs no convention
scan, persistent storage access, or additional LLM request. No persistent
convention cache exists in this implementation (§8).

---

## 0. Mission and completion definition

Phase 6 adds an **explicitly opt-in** inferred-convention advisory pass. It derives a small, deterministic convention set from the PR's merge-base repository snapshot, then asks the existing LLM provider to review a tightly bounded subset of changed review units in a separate advisory request. Findings are low-severity only and pass through the existing evidence-validation core.

Phase 6 is complete when an operator can pass `--convention-advisory` to enable the feature and the run can:

1. Discover conventions from a bounded merge-base snapshot that excludes every PR-touched path.
2. Use deterministic AST detectors and conservative support thresholds; no persistent cache is included in the first implementation.
3. Select no more than 15 lean-projected review units and issue no more than 5 advisory model requests in one run.
4. Start the primary review and (once conventions are ready) the advisory review independently, allowing their model work to overlap.
5. Enforce the advisory-only category/severity/rule boundary and reuse the Phase 5 per-finding validation core.
6. Merge advisories using a simple same-path verified-head-interval overlap rule; never alter, suppress, or evict primary findings.
7. Keep all transient handoff data out of `run.json` and retain the existing artifact schema.
8. Pass the real-PR labeled usefulness evaluation and the complete CodeBleach local/CI checks before routine use is recommended.

**Default behavior is primary review only.** When the flag is absent, Phase 6 is not initialized or run: no convention scan, persistent storage access, extra prompt, or advisory provider request. The flag is the only enablement control; do not add a config field. `--no-llm` and demo mode always bypass Phase 6, even when the flag is present.

The advisory provider receives additional reviewed-code context beyond the primary pass. CLI help must state this plainly. Advisory calls must also pass the existing `CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING` gate; `--convention-advisory` is not training consent. Do not make claims about provider retention or training; those depend on the configured provider's current terms and settings.

## 1. Non-negotiable authority and safety rules

These are invariants, not prompt suggestions.

### 1.1 Explicit rules remain authoritative

- `.reviewer.yml` `rules[]` remain the only explicit rule source.
- Explicit rule IDs, severity, and path scope are unchanged.
- Explicit rules are supplied to the primary review pass only.
- No inferred convention is added to `ReviewUnit.rules` or otherwise mixed into the primary prompt.
- The primary prompt, `CODE_REVIEW_PROMPT_VERSION`, primary categories, primary prompt hash, serialization, and output contract remain byte-identical with Phase 6 enabled or disabled.
- The primary prompt's existing convention suppression text remains verbatim.
- The primary pass must not receive inferred-convention data, including through a hidden field, shared prompt builder, or generic context list.

### 1.2 Inferred conventions are advisory-only

The advisory pass must be a separate model request using a separate template and output contract. Advisory findings must satisfy all of these conditions:

- `category === "convention"`.
- `severity === "low"` exactly. `info` is not eligible; severities above `low` are not eligible.
- `ruleId` is absent. Any present `ruleId` is rejected, including a real configured rule ID.
- `origin.pass` is stamped by trusted orchestration as `"convention-advisory"`; any model-supplied provenance is ignored or overwritten.
- Inferred convention IDs are not `ruleId` values and are never accepted as rule references.
- Advisory findings cannot alter, suppress, annotate, re-rank, or evict primary findings. Conflict resolution may discard an advisory; it never edits a primary record.
- Advisory findings cannot be the sole basis for severity above `low`.

Prompt text communicates these rules, but application code enforces them again after parsing and before validation.

### 1.3 Inferred convention data is not evidence

- Convention evidence references record deterministic support provenance for internal tests and bounded in-memory audit only; they are not supplied to the model and do not validate a model finding.
- An advisory finding must provide evidence from the actual reviewed snapshot under the existing Phase 5 finding contract.
- The Phase 5 evidence validator remains the authority for quotes, paths, actual matched lines, location, attribution, and policy.
- Never copy convention source excerpts, code snippets, secrets, or raw snapshot text into the advisory convention list or evidence records.
- Convention evidence paths and line references are never included in the advisory prompt. The prompt receives only bounded pattern statements and aggregate support counts.

### 1.4 Phase 5 and Phase 7 boundaries remain fixed

Do not change:

- `ValidatedFinding` fields or status values.
- `ValidationEngine.validate()` parameters, return type, primary stage order, primary dedupe comparator, or primary cap behavior.
- `VALIDATION_CHECK_CODES` or validation check semantics.
- `.reviewer.yml` schema or required config fields.
- `RunArtifact` or `RUN_ARTIFACT_SCHEMA_VERSION` (currently v2).
- `ValidationSummary` fields or aggregate-only meaning.
- The primary review prompt or primary prompt version/hash.
- GitHub publisher behavior, Octokit integration, workflow files, or Phase 7 stub.
- Provider choice, tool permissions, or network access policy.

No DB, embeddings, vector database, persistent source index, model-based detector, training, feedback learning, auto-fix, additional language, or new dependency is part of Phase 6.

---

## 2. Existing contracts to verify before implementation

At the latest `main`, inspect these contracts and reuse existing helpers:

| Existing contract | Primary source | Required Phase 6 behavior |
|---|---|---|
| Explicit rules | `src/context/rules.ts` | Keep `.reviewer.yml` rules in primary pass only. |
| Review units | `src/types/context.ts` | Build a minimal typed projection from changed-symbol metadata and unit-scoped diff hunks; never pass full `ReviewUnit` context or rules to the advisory engine. |
| Primary prompt | `src/review/prompt.ts` | No template, version, serialization, or hash change. |
| Provider | `src/core/contracts.ts`, `src/llm/` | Use an advisory-specific provider instance with retries set to zero, the run-scoped shared concurrency limiter (`src/providers/limiter.ts`), and the existing training-consent gate honored. |
| Public validation API | `src/core/contracts.ts` | `ValidationEngine.validate()` remains unchanged. |
| Validation core | `src/validate/engine.ts` | Share the same per-finding checks/order; use distinct pending/final result types. |
| Evidence actuals | `src/validate/evidence.ts` | Carry verified head locations transiently only. |
| Primary dedupe/cap | `src/validate/dedupe.ts` | Preserve the Phase 5 primary comparator and cap behavior. |
| Pipeline | `src/core/pipeline.ts`, `src/core/contracts.ts` | Orchestrate independent model passes, then validation/merge. |
| Artifact | `src/core/run-artifact.ts` | Keep schema v2 and current persisted result shapes. |
| Git snapshot | existing diff/Git readers | Sample the merge-base tree, not the PR head or working tree. |
| CLI | `src/cli/` | Add `--convention-advisory`, default false; flag must be explicit in help. |

Do not assume line numbers or signatures in this plan are stable. Re-check the current tree before implementing each ticket.

## 3. Phase 6 architecture and runtime flow

### 3.1 High-level flow

```text
load config + parse CLI flag (default false)
  -> resolve base/head and build DiffResult + ReviewUnit[]
  -> if flag is off: existing Phase 5/primary pipeline only
  -> if flag is on:
       start primary review immediately
       build conventions from merge-base snapshot (exclude every PR-touched path)
       after convention build: select bounded advisory units and start advisory requests
       await both model paths independently (all-settled; advisory failures are non-fatal)
       validate primary and advisory candidates through shared per-finding core
       finalize primary exactly as Phase 5
       suppress overlapping advisory candidates; advisory-only dedupe and cap
       append retained advisories after primary
  -> aggregate existing ValidationSummary and persist existing artifact-v2 fields
  -> existing dry-run/publisher behavior
```

The convention scan and primary model pass start independently after context is ready. The advisory pass starts as soon as the convention build is ready; it does not wait for the primary model pass. Use `Promise.allSettled`-style orchestration so an advisory failure cannot fail or erase a successful primary review. Primary review errors retain their existing behavior. Caller cancellation still follows the existing run cancellation contract.

### 3.2 Pass boundaries

**Primary pass:** existing `ReviewEngine.review(units, config, options)` with the exact existing `ReviewUnit[]`. It receives no inferred convention data.

**Advisory pass:** receives only a rule-free projection of selected review units and a bounded convention summary. It does not receive `.reviewer.yml` rule text, explicit rule IDs, evidence file paths, line references, raw detector matches, or scan metadata.

**Merge:** pipeline owns pass orchestration and final order. Detectors do not call the LLM. Prompt builders do not read Git. Validation does not discover conventions. No persistent cache component exists in the first cut.

### 3.3 Runtime mode behavior

| Mode | Flag | Convention scan/storage | Primary review | Advisory review | Result |
|---|---|---|---|---|---|
| Live | absent | No | Yes | No | Phase 5 behavior only |
| Live | `--convention-advisory` | Yes | Yes | Up to 5 requests when eligible | Primary + accepted advisories |
| Live dry-run | absent | No | Yes | No | Phase 5 dry-run |
| Live dry-run | `--convention-advisory` | Yes | Yes | Up to 5 requests when eligible | Full Phase 6 validation; no publish |
| `--no-llm` | either | No | Existing behavior | No | Existing no-LLM behavior |
| Demo | either | No | Existing demo | No | Existing demo behavior |
| No eligible baseline conventions | enabled | Bounded scan | Yes | No | Primary only |
| Snapshot/detector/advisory failure | enabled | Fail open | Yes | Skip or partial | Primary remains available |

The Phase 6 dependency bundle is optional in `PipelineDeps` and is required only when the explicit flag is enabled. An enabled run with missing Phase 6 dependencies is a CLI composition error detected before starting review; it must not silently downgrade to primary-only.

## 4. Data contracts and ownership

### 4.1 Convention types

Add pure Phase 6 data types under `src/types/` (recommended: `src/types/conventions.ts`) and export them through the existing type barrel. The module must import no runtime code.

```ts
export interface ConventionEvidence {
  kind: "source-span";
  file: string;       // repo-relative canonical POSIX path
  startLine: number;  // actual 1-based merge-base line
  endLine: number;    // >= startLine
}

export interface InferredConvention {
  id: string;              // stable `inf-` namespaced identifier; never used as ruleId
  detector: string;        // stable detector name
  detectorVersion: number;
  pattern: string;         // deterministic, bounded template text; no source excerpt
  evidence: ConventionEvidence[]; // deterministic order; capped
  matchingFiles: number;   // full number of matching files before evidence truncation
  eligibleFiles: number;   // per-detector denominator
  sampledFiles: number;    // global number of successfully sampled files
  supportRatio: number;    // matchingFiles / eligibleFiles, 0..1
}
```

The first-cut evidence type contains source spans only. Path-only and source-to-test pairing evidence are out of scope because those conventions are not checked by the advisory prompt.

Validation rules for the type at trusted boundaries:

- `id` matches the documented `inf-` format and is recomputable from detector/version/normalized pattern.
- Paths are canonical repo-relative POSIX paths; absolute paths, `..`, backslashes, empty segments, and every Unicode control character (`Cc`, including C0, DEL, and C1) are rejected.
- `source-span` line numbers are safe positive integers in the merge-base snapshot with `endLine >= startLine`.
- Counts are non-negative safe integers; `matchingFiles <= eligibleFiles`; `eligibleFiles <= sampledFiles` where applicable; no zero-denominator convention is emitted.
- `supportRatio` is finite and within `[0,1]` and agrees with the counts within the documented numeric precision.
- `pattern` is within `MAX_CONVENTION_PATTERN_CHARS`, contains no newline/control characters, and is produced from a deterministic template rather than raw source.
- Evidence is sorted and bounded by `MAX_EVIDENCE_PER_CONVENTION`.

### 4.2 Validation handoff and internal Phase 6 validation API

The conflict rule in §11 needs only verified head-side locations. Do not carry symbol, target, rename, base-to-head mapping, or other identity metadata.

```ts
export interface ValidationHandoffLocation {
  path: string;       // canonical repository-relative POSIX path
  startLine: number;  // actual verified 1-based head line
  endLine: number;
}

export interface ValidationHandoffEntry {
  findingId: string; // stable association key; never an array index
  headLocations: ValidationHandoffLocation[]; // empty is valid: verified evidence may be base-only
}

export interface PrimaryValidationResult {
  findings: ValidatedFinding[]; // final primary winners only
  handoff: ValidationHandoffEntry[]; // transient; retained primary winners only
}

export interface PendingAdvisoryCandidate {
  readonly phase: "pending-advisory-resolution";
  readonly findingId: string;
  // Same fields needed to build a final finding, but deliberately missing `status`.
  readonly pendingFields: Omit<ValidatedFinding, "status">;
  readonly handoff: ValidationHandoffEntry;
}
```

`PendingAdvisoryCandidate` is a distinct internal type, not a `ValidatedFinding`, and must not contain a nested `ValidatedFinding`. Its `pendingFields` projection omits the required `status` property, so TypeScript must reject assignment to `ValidatedFinding` or any artifact array. Add a compile-time `@ts-expect-error` test proving this. The finalizer adds `status: "accepted"` only after conflict suppression, advisory dedupe, and advisory cap have completed.

The internal Phase 6 engine interface lives in `src/core/contracts.ts`:

```ts
export interface Phase6ValidationEngine {
  validatePrimaryWithHandoff(
    findings: Finding[], diff: DiffResult, units: ReviewUnit[],
    config: ResolvedConfig, options?: ValidationOptions,
  ): Promise<PrimaryValidationResult>;

  validateAdvisoryCandidates(
    findings: Finding[], diff: DiffResult,
    units: ConventionAdvisoryUnit[], config: ResolvedConfig,
    options?: ValidationOptions,
  ): Promise<PendingAdvisoryCandidate[]>;

  finalizeAdvisoryCandidates(
    candidates: PendingAdvisoryCandidate[],
  ): ValidatedFinding[];
}
```

Contract semantics:

- Public `ValidationEngine.validate()` keeps its current signature and `Promise<ValidatedFinding[]>` return type. It delegates to the same shared per-finding core and existing primary batch policies.
- `validatePrimaryWithHandoff()` produces the same final primary findings as `validate()` and adds handoff only for retained accepted primary findings.
- `validateAdvisoryCandidates()` runs the shared per-finding core under the isolated advisory policy and returns pending candidate outcomes. It does not run dedupe, cap, conflict suppression, or materialize final `ValidatedFinding` objects.
- `finalizeAdvisoryCandidates()` converts only candidates that survived conflict suppression, advisory dedupe, and advisory cap into final `ValidatedFinding` records.
- Handoff is keyed by `findingId`. Never associate by array index. Every retained primary finding must have exactly one handoff entry, but `headLocations: []` is valid and means that the validator verified no head-side location (for example, a base-only/deletion finding). An empty list is never a malformed or missing handoff.
- Missing/duplicate associations or malformed location records in the retained primary handoff disable advisory conflict resolution for that run; all primary findings remain intact. A structurally valid empty `headLocations` list does not disable advisories. Malformed advisory associations drop only the affected advisory candidate.
- `headLocations` are copied only from verified actual head-side evidence locations. Base-side locations are omitted, not represented as invalid records. Cited ranges, quotes, excerpts, source text, and secrets are forbidden.
- Handoff is run-scoped and discarded after orchestration. No module-global map, disk file, artifact field, process cache, or cross-run state is allowed.
- Every validation invocation clears its snapshot reader in `finally`, including error and abort paths.

ADR 0043 records this internal seam (accepted P6-00). Do not rewrite ADRs 0041–0042; ADR 0044 records the hardening deltas.

### 4.3 Pipeline dependency-injection boundary

Keep `PipelineDeps.validation` typed as the public Phase 5 `ValidationEngine`. Add an optional Phase 6 bundle and an explicit runtime option:

```ts
export interface ConventionBuildDiagnostics {
  sampledFiles: number;
  skippedFiles: number;
  conventions: number;
  codes: string[]; // bounded stable codes only
}

export interface ConventionBuildResult {
  conventions: InferredConvention[];
  diagnostics: ConventionBuildDiagnostics;
}

export interface ConventionEngine {
  build(input: {
    repoDir: string;
    diff: DiffResult;
    config: ResolvedConfig;
    signal?: AbortSignal;
  }): Promise<ConventionBuildResult>;
}

export interface ConventionAdvisoryUnit {
  unitId: string;
  path: string; // canonical changed path from the active PR; reject control characters
  language: string;
  symbol: {
    name: string;
    kind: string;
    signature: string; // AST-derived declaration/signature only
    side: "head" | "base";
    startLine: number;
  };
  diffHunks: Array<{
    baseStartLine: number;
    headStartLine: number;
    // Unit-scoped diff lines only: all added/deleted lines plus bounded nearby context.
    lines: string[];
  }>;
  // Complete changed-symbol source only when it fits the symbol budget; otherwise null.
  // Changed lines remain present in diffHunks, so omitting this field never removes the change.
  changedSymbolSource: string | null;
}

export interface ConventionAdvisoryProjectionResult {
  units: ConventionAdvisoryUnit[];
  skippedUnits: number; // aggregate count for oversized/unprojectable units
}

export interface ConventionAdvisoryUnitProjector {
  project(input: {
    units: ReviewUnit[];
    diff: DiffResult;
    signal?: AbortSignal;
  }): Promise<ConventionAdvisoryProjectionResult>;
}

export interface AdvisoryConventionSummary {
  detector: string;
  pattern: string;
  matchingFiles: number;
  eligibleFiles: number;
  supportRatio: number;
}

export interface ConventionAdvisoryBatchInput {
  units: ConventionAdvisoryUnit[];
  conventions: AdvisoryConventionSummary[]; // sanitized summary; evidence paths are not representable
}

export interface ConventionAdvisoryCandidate {
  unitId: string; // validated association to one input unit in this request batch
  finding: Finding; // trusted-normalized pre-validation finding, not ValidatedFinding
}

export interface ConventionAdvisoryReviewResult {
  candidates: ConventionAdvisoryCandidate[]; // at most one per unit; bounded by batch size
  inputTokens: number;
  outputTokens: number;
  codes: string[]; // bounded transient diagnostics only
}

export interface ConventionAdvisoryReviewEngine {
  // Strict Zod output schema is internal to the engine; it requires unitId on each
  // raw result, then validates that association before returning normalized Finding values.
  // Exactly one provider invocation; one batch contains at most three units.
  reviewBatch(
    input: ConventionAdvisoryBatchInput,
    config: ResolvedConfig,
    options?: { signal?: AbortSignal; headSha?: string },
  ): Promise<ConventionAdvisoryReviewResult>;
}

export interface Phase6PipelineDeps {
  conventions: ConventionEngine;
  advisoryProjector: ConventionAdvisoryUnitProjector;
  advisoryReview: ConventionAdvisoryReviewEngine;
  validation: Phase6ValidationEngine;
}

export interface PipelineDeps {
  // Existing fields unchanged.
  validation: ValidationEngine;
  phase6?: Phase6PipelineDeps;
}

export interface PipelineOptions {
  conventionAdvisoryEnabled?: boolean; // default false; driven only by CLI flag
}
```

The actual names may follow existing project style, but preserve these semantics:

- `phase6` is constructed/injected only when `--convention-advisory` is enabled. Missing Phase 6 dependencies with the flag enabled is a preflight composition error; no partial run begins.
- `advisoryProjector` must use the existing pinned base/head snapshot reader from the pipeline composition; it must never read the working tree or independently resolve a moving Git ref. The exact existing reader type is confirmed in P6-00 and reused rather than introducing a second snapshot abstraction.
- The same concrete validator instance may implement both public and internal interfaces, but the public `ValidationEngine` interface is not widened.
- Stage interfaces live in `src/core/contracts.ts`; only pipeline and CLI wire them. Do not introduce circular imports.
- Demo and `--no-llm` bypass the Phase 6 bundle regardless of flag.
- The pipeline projects units through `advisoryProjector`, records `skippedUnits` as an aggregate, then selects at most 15 projected units and groups them into no more than five `reviewBatch()` calls of at most three units each. Each `ConventionAdvisoryBatchInput` carries the selected conventions once for the whole request. At most two advisory batches run concurrently; the engine method performs exactly one provider invocation and no retries.
- Each response `unitId` is checked against the exact input batch. Unknown or duplicate unit IDs, more than one candidate per unit, or malformed candidate payloads invalidate the affected batch; model-supplied unit IDs never become trusted provenance without this check.
- Advisory requests are made only when the existing `CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING` consent gate permits the configured provider request. The feature flag is not consent to provider training; never bypass or weaken this existing gate.

`ConventionEngine.build()` reads the pinned merge-base tree and receives the current `DiffResult` so it can exclude touched paths. There is no persistent cache read or write. The projector extracts changed symbols and unit-scoped diff hunks from the existing pinned base/head snapshot reader. `ConventionAdvisoryReviewEngine.reviewBatch()` receives only minimal unit projections plus sanitized convention summaries and is responsible for exactly one provider invocation per call (see §9).

### 4.4 Advisory execution result and diagnostics

The final orchestration result retains the ADR 0041 shape:

```ts
export interface AdvisoryExecutionResult {
  findings: ValidatedFinding[]; // primary winners first, retained advisories second
  conflictMetadata: {
    suppressed: number;
    advisoryDuplicates: number;
    unmappableExcluded: number;
    codes: string[]; // bounded stable diagnostic codes; no prose
  };
}
```

`conflictMetadata` is transient only. Do not add per-finding details, cap-rank records, or per-domain `ValidationSummary` fields. Any additional counts needed for boundary drops, projection skips, or cap overflow may be emitted as bounded logger aggregates; they do not extend `run.json` or the closed validation check-code set.

---

## 5. Sampling and merge-base snapshot discovery

### 5.1 Snapshot authority

- Infer conventions from the exact merge-base tree used to construct the current diff (`diff.mergeBase` or the equivalent authoritative base SHA in the actual contract), not from the PR head.
- Exclude every path touched by the PR from the convention population, including modified, added, deleted, renamed old paths, and renamed new paths. This prevents the PR from rewriting the baseline used to judge itself.
- Reuse existing local Git object enumeration and bounded `cat-file --batch` infrastructure. Read blobs by object ID; never resolve sampled paths against the working tree.
- Do not fetch a moving remote branch or use a REST source read. Pin the full merge-base SHA used for the run.
- The reviewed PR head remains the authority for finding validation; only convention inference uses the merge-base snapshot.

### 5.2 Eligible population

Use only the already-supported JavaScript/TypeScript extensions `.js`, `.jsx`, `.ts`, `.tsx`, subject to the actual parser adapters. Exclude unsupported modes, symlinks, gitlinks, deleted paths, binary/empty blobs, oversize blobs, generated/vendor/dependency/build/build output, ignored paths, and all PR-touched paths.

Exclude any path containing a Unicode control character (including LF, CR, TAB, NUL, DEL, and C1 controls). Keep ordinary spaces and valid Unicode path characters. This is enforced during Git-tree enumeration and again before constructing the advisory projection.

Test-layout detection is excluded from the first cut. Each remaining detector owns its own eligibility predicate and denominator.

### 5.3 Deterministic sampling order

Initial bounds to lock in P6-00:

| Constant | Value | Purpose |
|---|---:|---|
| `MAX_SAMPLED_FILES` | 200 | Maximum files across one run |
| `MAX_SAMPLED_FILE_BYTES` | 131072 | Maximum bytes per blob |
| `MAX_SAMPLED_TOTAL_BYTES` | 8388608 | Maximum sampled bytes |
| `SAMPLING_POLICY_VERSION` | 2 | Bump when population, exclusion, eligibility, ordering, or caps change |

Rank canonical paths by `sha256("codebleach-phase6-base-sampling-v2\0" + canonicalPath)` ascending, then canonical path by code-unit order. Take the first paths that fit both caps. Enumeration order, OS, and process timing must not affect the sample. As implemented, sizing is rank-first: eligible paths rank before any size lookup, and blob sizes resolve in rank order through successive bounded `cat-file --batch-check` rounds of at most `SAMPLING_SIZE_BATCH_OIDS = 200` OIDs, stopping early once the file or byte budget is unfillable (ADR 0044).

### 5.4 Detector denominators

Each detector defines its own eligibility predicate. PR-touched paths are excluded before detector eligibility is evaluated; ineligible files are not misses. Test-layout and filename-only populations are not analyzed in the first cut. A detector with no eligible files emits no convention.

### 5.5 Sampling tests

Test merge-base pinning, touched-path exclusion for every diff status and rename side, dirty-working-tree independence, deterministic hash ordering, exact file/byte caps, malformed/control-character path exclusion, unsupported/binary/generated/ignored file exclusion, and exclusion of test-layout-only evidence.

## 6. Deterministic convention detectors

### 6.1 General detector contract

Detectors live under a new `src/conventions/` directory. They are pure functions over already-sampled data. They must not read files, invoke Git, access the network, use wall-clock time, use randomness, use the LLM, or mutate input.

Each detector has:

- Stable `name` and integer `version`.
- A pure eligibility predicate.
- A deterministic analyzer that emits zero or more candidate patterns with matching evidence records.
- A bounded output shape; no raw source excerpts.

Prefer the existing TypeScript/JavaScript parser or language adapter for syntax-sensitive observations. Do not make broad semantic claims from a fragile regex. If the syntax is ambiguous, emit nothing. The three detector families below are required; each can return no candidates for a given repository.

### 6.2 Naming and export style

Detect only mechanically verifiable patterns, for example:

- Dominant named-export versus default-export style among eligible modules.
- A consistent exported identifier style where the current syntax parser can identify the exported declarations reliably.

Do not infer architecture or semantic design intent from names. Naming/export conventions are limited to AST-observable exported identifiers and declarations that can be backed by quotable source spans. Filename-only patterns are out of scope for the first cut because they cannot be checked from one changed code unit.

### 6.3 Error-handling idioms

Use mutually exclusive per-file classification; never emit simultaneous `Result`-style and throw-based conventions.

1. A file is eligible only if the parser finds a recognized error surface: a function return annotation resolving to the unqualified `Result`/`Either` type (including `Promise<Result<...>>`), an explicit `throw` statement, or a recognized `Promise.reject(...)` call. Files with no recognized error surface are outside the denominator.
2. Classify a file as `result-style` when it has a recognized Result/Either return contract and no throw/Promise.reject signal; classify it as `throw-style` when it has a throw/Promise.reject signal and no Result/Either return contract.
3. Files containing both signals are `mixed`; they remain in the eligible denominator but support neither style. Do not infer a style from absence of syntax.
4. Count at most one match per file. Emit at most one error-handling convention: the leading style must meet the global support/evidence thresholds and exceed the runner-up by `MIN_DOMINANCE_MARGIN = 0.20` of eligible files. A tie or insufficient margin emits nothing.

Do not use regex-only matching, type-name substring matching, or a repository-wide assumption that every `Result` identifier has the same semantics.

### 6.4 Common wrappers

Implement one narrow AST-based algorithm; do not attempt broad semantic wrapper inference:

1. Parse static relative imports in sampled non-test source modules.
2. Resolve only unambiguous relative imports to another file in the sampled merge-base inventory. Do not resolve package imports, tsconfig aliases, computed paths, unresolved imports, or re-export chains.
3. Track each imported binding (including local aliases) to its resolved repository file and exported symbol.
4. Find `CallExpression` nodes whose callee is that imported binding and whose first argument is an inline arrow/function expression. Identifier text alone never matches: calls resolve only through unambiguous local bindings, and any shadowing binding (parameters, locals, destructured names, catch params, hoisted declarations) or dynamic `with` scope over the call disqualifies it. Count at most one match per importing file for a given resolved (helper, symbol) group.
5. Group by `(resolved helper path, exported symbol)`, each with its own denominator counting sampled non-test files that import the group (even when they never call). A candidate matches only when at least five distinct eligible files use that helper. The emitted template may contain the AST identifier only after it passes an identifier-token allowlist; never copy comments, string literals, source text, or arbitrary expressions.
6. If import resolution or AST shape is ambiguous, emit nothing. Do not substitute regular expressions or guess that any frequently called function is a wrapper.

The pattern template is `Modules importing the repository helper <identifier> repeatedly wrap callbacks with it.` The identifier must match `^[A-Za-z_$][A-Za-z0-9_$]*$` before interpolation. Evidence is source spans at call sites, but paths/lines are not sent to the advisory prompt (see §9.2).

### 6.5 Candidate and pattern output

The pattern statement is generated from a finite deterministic template catalog, for example:

- `Modules predominantly use named exports.`
- `The repository predominantly uses typed Result-style error returns.`
- `Modules importing the repository helper <identifier> repeatedly wrap callbacks with it.` (the sole allowed identifier interpolation is validated by the allowlist in §6.4).

The detector must never copy arbitrary code or comments into `pattern`. Keep the statement short, factual, and limited to what the detector measured.

### 6.6 Detector tests

For each of the three first-cut detectors, test:

- Positive, negative, mixed, empty, malformed, and ambiguous inputs; specifically, error-style files classified result-only, throw-only, mixed, and no-signal.
- Eligibility and ineligible-file denominator behavior.
- Multiple patterns in one file; mutually exclusive error-style output and common-wrapper import alias/resolution cases.
- Multiple files with deterministic evidence selection.
- No filename-only or test-layout convention is emitted in the first cut.
- Binary and unsupported-file guard behavior.
- Output invariance under file order and repeated invocation.
- No raw source excerpt appears in the detector result or serialized convention object.

---

## 7. Support filtering, stable IDs, and evidence records

### 7.1 Support calculation

For each detector candidate:

- `eligibleFiles` is the number of sampled files for which that detector's eligibility predicate is true — except the common-wrappers detector, which uses per-group denominators: one denominator per resolved (helper path, exported symbol) group counting only the sampled non-test files that import that group. Files that never import the helper, test files, and unresolvable imports belong to no group.
- `matchingFiles` is the number of eligible files exhibiting the candidate pattern.
- `supportRatio = matchingFiles / eligibleFiles`.
- Zero eligible files yields no convention and a bounded diagnostic; never divide by zero.
- `sampledFiles` is the total sampled file count and is audit metadata only; it is not the support denominator.

Initial thresholds to justify and freeze in P6-00:

| Constant | Initial value |
|---|---:|
| `MIN_SUPPORT_RATIO` | 0.75 |
| `MIN_EVIDENCE_FILES` | 5 |
| `MIN_DOMINANCE_MARGIN` | 0.20 |
| `MAX_CONVENTIONS_PER_RUN` | 20 |
| `MAX_EVIDENCE_PER_CONVENTION` | 8 |
| `MAX_CONVENTION_PATTERN_CHARS` | 240 |

A candidate is retained only if it meets both the support ratio and minimum of five distinct matching paths. Thus `3 of 5` is rejected (60% and fewer than five matching files). For mutually exclusive classifications such as error-handling style, also require the leading candidate to exceed the runner-up by at least `MIN_DOMINANCE_MARGIN`; otherwise emit no convention.

### 7.2 Evidence retention

- Store exactly one evidence record per matching file: the earliest qualifying source span by start line, then end line.
- Sort records by canonical path, then start line and end line.
- Truncate to `MAX_EVIDENCE_PER_CONVENTION` only after calculating the full `matchingFiles` count.
- Evidence may contain repository-relative paths and actual line references only; no quote, excerpt, AST node text, or raw source.
- Evidence remains in memory for deterministic support provenance and tests only. It is not sent to the model, persisted, or logged.

### 7.3 Stable convention IDs

Create IDs from a canonical serialization of detector name, detector version, and normalized pattern using the repository's approved hash helper (prefer SHA-256; if an existing project-wide stable hash convention must be reused, document why). Prefix with `inf-`. Never use the ID as a `ruleId`; the advisory boundary rejects every `ruleId` regardless of value.

### 7.4 Deterministic selection and ordering

Sort retained candidates by:

1. Higher support ratio (compare integer cross-products where practical to avoid floating-point tie drift).
2. Higher matching-file count.
3. Detector name ascending by code-unit order.
4. Stable convention ID ascending.

Apply `MAX_CONVENTIONS_PER_RUN` after sorting. Do not use locale-aware comparison, map iteration order, async completion order, or input ordering as a tie-breaker.

### 7.5 Support tests

- Values immediately below, equal to, and above `MIN_SUPPORT_RATIO`.
- Evidence minimum just below and at threshold.
- Zero eligible and empty sample.
- Per-detector denominators differ correctly.
- `matchingFiles` remains the full count after evidence truncation.
- Stable IDs on repeated runs and across input permutations.
- Stable cap selection and evidence ordering.
- Counts are valid safe integers and ratios are finite.

---

## 8. Cache explicitly deferred from the first implementation

Do not implement a persistent convention cache in Phase 6. The cache adds filesystem trust-boundary, symlink, containment, and cross-platform atomic-write complexity while the bounded merge-base scan is capped at 200 files and 8 MiB. The PR-touched-path exclusion set also makes cache reuse unlikely across materially different pull requests.

First-cut requirements:

- No `.reviewer-cache/` directory, cache file, cache key, cache parser, cache write, or persistent-storage dependency.
- Every enabled run performs the deterministic bounded scan in memory and discards sampled blobs, detector intermediates, and convention evidence after orchestration.
- Scan limits and advisory work overlap with the primary model call; record aggregate scan duration and sampled-file counts only, without logging paths or source content.
- Reconsider caching only after real runs show that scan latency is material. A later proposal must include measured hit-rate evidence and a separate security/portability review; it is not part of P6-00 through P6-05.

This section is a scope exclusion, not a future implementation ticket. No tests should be added for a cache that does not exist.

---

## 9. Advisory prompt and model pass

### 9.1 Separate files and contracts

Create a separate advisory prompt builder/template under `src/review/`, recommended names:

- `src/review/convention-prompt.ts`
- `src/review/convention-engine.ts` (or a clearly named advisory pass module)
- A distinct `CONVENTION_ADVISORY_PROMPT_VERSION`, initially `convention-advisory-v1`.

The advisory template has its own hash pin, version pin, schema, normalization path, and tests. It must not share a template string or output schema that could accidentally add inferred content to the primary pass.

### 9.2 Lean advisory projection

Do not pass `ReviewUnit` directly, even after removing `rules`. Its full context is too large: prior runs showed roughly 5.7k–8.9k tokens per ordinary unit before the Phase 6 wrapper. Build a dedicated `ConventionAdvisoryUnit` projection containing only:

- The changed unit's canonical path, language, stable unit ID, and AST-derived changed-symbol name/kind/signature.
- The complete changed-symbol source text from the correct snapshot side only when it fits `MAX_ADVISORY_SYMBOL_SOURCE_TOKENS = 800`; otherwise set `changedSymbolSource` to `null`. Never take a partial substring of a symbol body.
- The unit-scoped diff hunks: retain every added/deleted line belonging to the unit, plus at most two unchanged context lines on either side, with a 500-token context-plus-hunk target. Remove unrelated hunks and unrelated review context. If unchanged context alone exceeds its budget, remove context before removing any changed line. If the changed lines plus symbol signature cannot fit the per-unit budget, skip that unit and increment `skippedUnits`; never truncate or silently omit changed lines.
- Relevant convention pattern statements and aggregate support counts only. Convert internal `InferredConvention` values to the explicit `AdvisoryConventionSummary` allowlist before request construction. No evidence paths, evidence line numbers, scan metadata, sample OIDs, or sampled source excerpts.

If the AST adapter cannot identify a changed symbol, the projection may contain the unit-scoped diff hunks with a stable `unknown` symbol kind/name marker; it must not fall back to the full `ReviewUnit` context. For a deleted symbol, take the symbol signature/source from the base side and use the base/head diff hunk coordinates. Unit IDs are trusted only after matching against the exact request batch.

The request must exclude `.reviewer.yml` rules, explicit rule IDs/severities, full files outside the changed symbol, complete repository context, raw detector matches, model/provider credentials, and conflict metadata. The batch input uses `AdvisoryConventionSummary`, not `InferredConvention`, so evidence arrays and source paths cannot cross the prompt boundary by type.

Projection construction and token measurement are deterministic. Deduplicate overlapping text between changed-symbol source and diff hunks by line identity before serialization. The prompt can refer to the changed symbol and the inline diff only; it cannot ask the model to check filename-only or test-layout rules, which are excluded from the first-cut detectors.

### 9.3 Hard per-run budget and concurrency

Freeze these exact bounds in P6-00:

| Constant | Value | Hard guarantee |
|---|---:|---|
| `MAX_ADVISORY_REQUESTS_PER_RUN` | 5 | At most five actual provider invocations total |
| `MAX_ADVISORY_UNITS_PER_REQUEST` | 3 | At most three lean projected units in one request |
| `MAX_ADVISORY_UNITS_PER_RUN` | 15 | At most 15 projected units receive advisory review |
| `MAX_ADVISORY_UNIT_TOKENS` | 1500 | Per-unit serialized projection ceiling, including symbol metadata, symbol source, and diff hunks |
| `MAX_ADVISORY_FIXED_INPUT_TOKENS` | 900 | Prompt, schema, framing, and provider request overhead reserved per request |
| `MAX_CONVENTION_SUMMARY_TOKENS_PER_REQUEST` | 600 | Pattern statements and aggregate support metadata |
| `MAX_ADVISORY_INPUT_TOKENS_PER_REQUEST` | 6000 | Total serialized model input, including all instructions, schema/tool definitions, conventions, and units |
| `MAX_ADVISORY_OUTPUT_TOKENS_PER_REQUEST` | 1200 | Provider output ceiling per request |
| `MAX_ADVISORY_FINDINGS_PER_UNIT` | 1 | At most one raw advisory finding associated with each unit |
| `MAX_ADVISORY_FINDINGS_PER_RUN` | 5 | Final advisory cap after conflict/dedupe |
| `MAX_ADVISORY_CONCURRENCY` | 2 | Advisory requests in flight concurrently |

A request's maximum planned budget is 900 fixed + 600 convention-summary + 3 × 1500 unit tokens = 6000 input tokens. `AdvisoryConventionSummary` is sent once per request, never duplicated for each unit. The packer must still measure the complete final serialized request immediately before dispatch; it must not assume the component maxima will sum exactly after serialization. If the request exceeds 6000, remove lowest-ranked convention statements first, then reduce unchanged diff context, then move a whole unit to a later request. Never remove changed lines to force a request under budget. If a single unit still exceeds 1500 after projection rules, skip that unit and increment the aggregate skip count.

P6-00 confirmed the configured provider (`OpenCodeProvider`) exposes no
tokenizer or token-count facility, so advisory budgets are measured with the
documented conservative UTF-8-byte upper-bound counter (`estimateTokens`:
ceiling of UTF-8 bytes times 23/80) via `src/conventions/token-budget.ts`.
The mode is pinned as `ADVISORY_TOKEN_COUNTER_MODE =
"utf8-byte-upper-bound"` and recorded by golden token-count tests for
projection fixtures (ADR 0043 D3, ADR 0044). Never dispatch a request whose
measured upper bound exceeds 6000.

Unit selection is deterministic and spread across changed paths: sort units within each path by actual start line, symbol, and unit ID; visit paths in stable hash order; build the lean projection; then pack whole projections into at most five requests with at most three units each. Each selected unit appears once. A unit that is too large or cannot fit within the remaining five-request budget is skipped with a bounded aggregate diagnostic, not silently discarded. No more than 15 units may be submitted, even if more would fit.

Each advisory request is attempted at most once. Disable automatic repair/retry for advisory schema failures. Construct an advisory-specific provider instance with `maxRetries: 0`;
wrap both the primary and advisory providers in the same run-scoped
`RunConcurrencyLimiter` (`src/providers/limiter.ts`, one instance per live
run, no global state), so advisory calls contend for the same
`max_concurrent_requests` permits as primary calls rather than creating a
second independent pool (ADR 0044). Reuse the existing deadline and cancellation controls. Count actual provider invocations, not logical batches.

All advisory requests go through the existing `CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING` gate. The `--convention-advisory` CLI flag is not a substitute for that consent. If the existing gate does not permit the configured provider request, skip advisory calls and preserve primary results; never instantiate an unguarded provider path to bypass the gate.

Once conventions are ready, launch advisory requests without waiting for primary review completion. Primary review and advisory review must overlap whenever the run-scoped shared concurrency budget allows. Primary calls retain their existing priority and retry behavior.

The convention summary is selected deterministically by supported language/kind, support ratio, detector name, and stable ID, then projected to at most eight `AdvisoryConventionSummary` records and 600 tokens. The advisory pass must not trigger a request when the feature flag is off, no convention survives, no eligible projection is selected, or the training-consent gate denies the request.

### 9.4 Advisory output schema

Use a dedicated strict Zod schema at the LLM trust boundary. Required invariants:

- Output is a strict object with a `findings` array of at most five `{ unitId, finding }` entries; this is the raw model schema, before normalization to `ConventionAdvisoryCandidate[]`.
- Each `unitId` must be unique and must match one of the five-or-fewer units in the current request batch.
- At most one advisory finding is allowed per input unit.
- Finding category is a literal `convention` and severity is a literal `low`.
- `ruleId` is not part of the schema; strict parsing rejects its presence.
- Fields otherwise match the established raw finding contract needed by normalization and Phase 5 validation.
- Model-provided `origin`, pass, IDs, fingerprints, or trusted provenance are not accepted as authority.
- A unit ID not present in the batch, duplicate unit ID, or malformed output causes the batch to be dropped; do not repair/retry it. This is required to preserve the hard request budget in §9.3. Never coerce an invalid category/severity into a valid advisory.

The advisory prompt must request evidence quotes from the reviewed head/base snapshot in the same way as normal findings. The Phase 5 validator remains the final evidence gate.

### 9.5 Trusted normalization and provenance

Normalize advisory outputs through the existing finding normalization/fingerprint machinery wherever possible. Trusted code must set:

- `origin.pass = "convention-advisory"`.
- The originating `unitId` from the validated input-to-output association.
- `headSha` from the active run.
- The stable finding ID and fingerprint through existing code paths.

Do not trust any model-supplied provenance or pass identifier.

### 9.6 Advisory model failure behavior

- No convention input: do not call the model.
- One request batch fails: keep primary results and valid advisory results from other completed batches; record a bounded diagnostic.
- Whole advisory pass fails: keep primary results; do not fail the entire review solely because inferred advice failed.
- Never exceed the five-request run budget to recover from malformed output or provider errors.
- Caller cancellation: honor the caller signal through existing provider and pipeline cancellation semantics.
- Completion order must not affect output order. Sort normalized advisory findings deterministically before validation/merge.

### 9.7 Prompt tests

- Primary prompt bytes, version, categories, hash, serialized input, and output contract are byte-identical with Phase 6 on/off.
- Primary prompt contains no inferred convention data in any path.
- The existing primary convention suppression text remains verbatim.
- Advisory prompt has a distinct version/hash/schema and contains convention advice only.
- Advisory prompt has no explicit rules, rule IDs, or raw sample excerpts.
- Prompt-injection-like strings inside repository comments/pattern-like source do not change system instructions or schema.
- Whole-convention token truncation is deterministic.
- No advisory request occurs when there are no eligible conventions or in demo/`--no-llm` modes.
- Model-forged provenance is overwritten.
- Invalid category, severity, `ruleId`, or malformed result is rejected before validation.

---

## 10. Validation policy and internal shared-core implementation

### 10.1 Shared per-finding core

Refactor `src/validate/engine.ts` so provenance, location, evidence, attribution, and policy remain one shared per-finding core, in the existing order and with identical semantics.

- Public `ValidationEngine.validate()` continues to finalize through existing primary dedupe and cap policies.
- `validatePrimaryWithHandoff()` produces exactly the same final primary `ValidatedFinding[]` as `validate()` plus transient head-location handoff for retained accepted findings.
- `validateAdvisoryCandidates()` returns `PendingAdvisoryCandidate[]`, not `ValidatedFinding[]`. The pending type contains the original `Finding`, per-finding validation metadata, and handoff, and cannot be persisted or passed to `RunArtifact` APIs.
- Only after conflict suppression, advisory-only dedupe, and advisory cap may `finalizeAdvisoryCandidates()` create `ValidatedFinding` objects.

Do not introduce a second validation implementation. The pending/final type split is a compile-time boundary, not a runtime status convention.

### 10.2 Isolated advisory policy projection

Current Phase 5 defaults to a `medium` severity threshold. Advisory policy projection must:

- Set advisory severity threshold to exactly `low`.
- Ignore path/category severity overrides for advisory findings.
- Preserve path-level confidence overrides and global confidence fallback.
- Keep the existing convention category gate unchanged.
- Require no `ruleId` before validation.

Primary validation receives the original unmodified `ResolvedConfig`. Do not add a validator flag, new config field, fake rule, category toggle, or validation check code.

### 10.3 Reader lifecycle and verified head locations

- Validation readers remain pinned to the reviewed head snapshot.
- Handoff contains only `EvidenceSuccess.locations` whose side is `head`, canonicalized to repo-relative POSIX paths with actual 1-based line intervals.
- Do not carry base-side locations, model-cited ranges, symbol names, derived targets, rename maps, or quotes into handoff. An accepted finding supported only by base-side evidence still receives a handoff entry with an empty `headLocations` array.
- Build exactly one primary handoff entry for every retained primary winner and one advisory handoff entry for every per-finding-validated advisory candidate. `headLocations: []` is valid for base-only or otherwise head-unlocated findings and means there is no possible head-side overlap.
- Handoff association uses `findingId`, never array position.
- Reader cleanup runs in `finally` on success, failure, and cancellation.

### 10.4 Validation tests

Test public `validate()` parity with `validatePrimaryWithHandoff().findings`, unchanged primary check order/codes/dedupe/cap, advisory `low` policy projection, preserved confidence overrides, ignored severity overrides, pending type non-assignability to `ValidatedFinding`, finalization only after advisory policies, verified head-location-only handoff, and cleanup on error/abort.

## 11. Simple verified-location overlap rule

### 11.1 Rule

Primary findings always win. Suppress an advisory when at least one of its verified head-side evidence intervals overlaps at least one verified head-side evidence interval from a retained primary finding on the same canonical path:

```text
same canonical path AND max(startA, startB) <= min(endA, endB)
```

This is intentionally a conservative location-overlap rule, not a claim that two findings describe the same semantic issue. Do not add symbol matching, target matching, title similarity, fingerprint matching, rename mapping, base-to-head mapping, interval extrapolation, or diff-context mapping. Adjacent but non-overlapping intervals do not conflict. Cited ranges never participate.

### 11.2 Missing or malformed handoff: fail open to primary-only without failing review

- Every retained primary finding must have exactly one handoff entry keyed by its `findingId`. An entry with `headLocations: []` is valid, including when the primary finding was verified only against the base side or has no verified head-side actuals. It means that primary finding cannot overlap any advisory on head-side intervals; it does not invalidate the run.
- If a primary finding has no handoff entry, multiple entries share its ID, an unknown extra primary ID is present, or a non-empty location list contains a malformed path/line interval, treat the primary handoff structure as invalid. Discard all advisories for that run and keep every primary finding unchanged.
- For an advisory candidate, an existing valid handoff entry with `headLocations: []` is also valid and creates no primary conflict by itself. A missing/duplicate association or malformed non-empty location list drops only that advisory candidate; other valid advisory candidates can continue.
- If the conflict resolver throws or receives an invalid global association structure, discard all advisories and return the already-finalized primary results.
- Log only a bounded code/count. No mismatch may reject, alter, or abort the primary review.
- Caller cancellation is still honored as run cancellation; ordinary advisory/handoff failures are fail-open to primary-only or partial-advisory results.

### 11.3 Advisory-advisory dedupe

After primary conflict suppression, deduplicate advisories using the same path+verified-head-interval overlap rule within the advisory domain only. Winner order is deterministic: confidence descending, canonical path, earliest verified start line, fingerprint, then finding ID. The primary `resolveDuplicates()` implementation is untouched.

### 11.4 Minimal conflict tests: C1–C7

- **C1:** same path and overlapping verified head intervals ⇒ advisory suppressed; primary unchanged.
- **C2:** same path but adjacent/non-overlapping intervals ⇒ both retained.
- **C3:** cited ranges overlap but verified actuals do not ⇒ both retained; actuals overlap despite cited ranges differing ⇒ advisory suppressed.
- **C4:** a Phase 5-accepted base-only finding (verified end-to-end where supported by the current validator) receives a valid handoff with `headLocations: []` and does not disable advisories; that primary finding simply cannot conflict by head interval. Also test an accepted finding whose verified locations contain no head-side actuals.
- **C5:** a missing/duplicate primary handoff association or malformed primary location ⇒ all advisories dropped, all primary findings retained.
- **C6:** a valid advisory handoff with `headLocations: []` is retained unless another policy rejects it; it does not create an overlap.
- **C7:** one malformed/missing advisory handoff drops only that advisory; valid advisory candidates and all primary findings remain unchanged.

No rename or base-to-head coordinate mapping tests are required because those mechanisms are deliberately out of scope.

## 12. Parallel model execution and separate merge domains

### 12.1 Model scheduling

After the context stage, start the primary model pass immediately. When the merge-base convention build finishes, start the advisory pass without waiting for primary completion. Await both independently. The advisory pass may finish first or fail; neither event changes the primary result. Respect the shared provider concurrency cap and run cancellation.

### 12.2 Finalization order

1. Finalize primary findings with existing primary validation, dedupe, and cap. This output is immutable for the remainder of the run.
2. Boundary-gate advisory model output (`category`, exact `low` severity, absent `ruleId`, trusted provenance).
3. Convert advisory outputs to `PendingAdvisoryCandidate` through the shared per-finding validation core.
4. If handoff associations or non-empty locations are structurally malformed, use the fail-open-to-primary behavior in §11.2; an empty `headLocations` array is valid.
5. Suppress pending advisories whose verified head intervals overlap retained primary intervals.
6. Deduplicate surviving advisories within the advisory domain using §11.3.
7. Apply the advisory-only cap of five.
8. Materialize final `ValidatedFinding` values from surviving pending candidates.
9. Append advisory findings after primary findings; compute the existing aggregate `ValidationSummary` over the final array.

There is no combined primary/advisory dedupe set or combined cap. No Phase 6 step can mutate primary findings, ordering, dedupe winners, or cap winners.

## 13. Artifact, logging, and diagnostics policy

### 13.1 `run.json` remains schema v2

Do not change:

- `RUN_ARTIFACT_SCHEMA_VERSION`.
- `RunArtifact` interface or field names.
- `ValidatedFinding` fields.
- `ValidationSummary` fields.
- `ReviewDiagnostic` stage/code union.

The artifact may contain the final combined primary + retained advisory `findings`/`validated` arrays using the existing array element types. `ValidationSummary` remains a single aggregate summary over the final validated array; it must not add primary/advisory counters.

Do not persist:

- `ValidationHandoffEntry` or verified evidence locations used only by conflict resolution.
- `AdvisoryExecutionResult.conflictMetadata`.
- Per-finding conflict suppression records, IDs, paths, symbols, or intervals.
- Sampled blob IDs or convention detector diagnostics.
- Advisory prompt raw internals, source excerpts, or secrets.

Existing review artifact metadata fields continue to represent the existing primary review contract. Advisory prompt version/hash and advisory operational diagnostics may be emitted through bounded logger aggregates; do not add artifact fields to represent them.

### 13.2 Logging

- Use the actual `Logger` interface.
- Log to stderr only.
- Log stable codes and bounded counts only.
- Never log quotes, excerpts, snapshot text, prompts, secret values, or raw model output.
- Do not emit a per-finding conflict log.
- Keep arrays bounded and de-duplicated; cap diagnostic code lists.

Suggested non-validation diagnostics include sample empty/limit, projection skipped/budget-exceeded, detector skipped/failed, advisory skipped/failed, training gate denied, boundary rejected, conflict suppressed, advisory duplicate, and advisory cap overflow. These are orchestration diagnostics, not `VALIDATION_CHECK_CODES`.

---

## 14. Suggested source layout

Adapt names to current project conventions, but keep ownership boundaries:

```text
src/
  types/
    conventions.ts                 # pure convention/evidence data types
    validation.ts                  # existing validation types + pure handoff type if appropriate
  conventions/
    constants.ts                   # named bounds and policy versions
    sampling.ts                    # merge-base tree enumeration and deterministic sample selection
    detectors/
      index.ts
      naming.ts
      errors.ts
      wrappers.ts
    support.ts                     # ratios, evidence retention, stable ordering and IDs
    engine.ts                      # sample -> read -> detect -> support orchestration
  review/
    convention-prompt.ts           # separate advisory prompt/version/hash
    convention-engine.ts           # separate advisory review pass using LlmProvider
  validate/
    engine.ts                      # shared per-finding core and Phase6 internal entry points
    conflict.ts                    # same-path verified-head-interval overlap; pure after inputs
  core/
    contracts.ts                   # stage interfaces and Phase6 dependency bundle
    pipeline.ts                    # normative pass and merge order
    logger.ts                      # existing logger; only bounded aggregate calls
  cli/
    commands/review.ts             # composition root wiring for live mode

tests/
  unit/conventions/                 # sampling, detectors, support
  unit/review/                      # advisory schema and prompt
  unit/validate/                    # shared-core/handoff/conflict/policy
  integration/                      # full fixture pipeline, primary invariance, offline behavior
```

No new third-party package is expected. Do not add a dependency for AST parsing, hashing, validation, concurrency, or token counting if current repository utilities can provide it.

---

## 15. Ticket sequence and PR boundaries

Each ticket is independently reviewable. Do not combine all Phase 6 work into one large PR.

### P6-00 — Contracts, opt-in, and architecture lock

**Purpose:** eliminate ambiguity and lock resource/safety contracts before runtime work.

**Work:**

1. Fetch latest `main`; read `AGENTS.md`, `systemdesign.md`, ADRs 0039–0042, and current source contracts.
2. Add `--convention-advisory`, default false; update CLI help to disclose the extra advisory model requests. With flag absent, Phase 6 must perform no scan, persistent storage access, or provider work.
3. Lock optional `PipelineDeps.phase6` plus the explicit pipeline option; keep `ValidationEngine.validate()` unchanged.
4. ADR 0043 records the internal primary-handoff/pending-advisory type boundary and Phase 6 DI seam (done P6-00).
5. Lock `PendingAdvisoryCandidate` so no intermediate advisory result is a `ValidatedFinding` or can be persisted before finalization.
6. Freeze the merge-base source, exclusion of every PR-touched path, and path control-character policy.
7. Freeze the 75% support ratio, five distinct matching files, 20% dominance margin for competing error styles, and the precise detector algorithms in §6.
8. Freeze the lean `ConventionAdvisoryUnit` projection, `AdvisoryConventionSummary` prompt allowlist, 800-token symbol-source ceiling, 1500-token unit ceiling, 900-token fixed request reserve, 600-token convention sub-budget, 6000-token full-request ceiling, three units/request, 15 units/run, five requests/run, and 1200 output-token ceiling.
9. Verify the model-specific token counter or select the documented conservative UTF-8-byte upper-bound counter; add golden tests proving the complete serialized request stays within budget.
10. Require an advisory-specific provider instance with `maxRetries: 0`, the run-scoped shared concurrency limiter, and the existing `CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING` gate.
11. Define empty `headLocations` as a valid no-overlap handoff and distinguish it from missing/duplicate/malformed associations; add an end-to-end base-only validation test if Phase 5 accepts such findings.
12. Lock concurrent model scheduling and primary-only fallback for actual handoff integrity failures.
13. Explicitly defer persistent cache and exclude filename/test-layout detectors from the first cut; freeze one earliest evidence span per matching file and the eight-record cap.
14. Update `systemdesign.md` and `docs/validation.md` once for these decisions; do not restate their full rationale across multiple docs.

**Acceptance:** flag-off tests prove no scan/extra request; enabled composition is explicit; projection, token measurement, handoff semantics, provider retry/training gates, and all bounds are named; no runtime detector/prompt behavior beyond minimal contract tests.

### P6-01 — Merge-base sampling and deterministic detectors

**Purpose:** build a bounded baseline from code the PR did not change.

**Work:**

1. Enumerate the exact merge-base tree used by the diff.
2. Exclude all PR-touched paths (including old/new rename paths) before sampling.
3. Reject paths containing control characters and apply language, ignore, generated, binary, and byte limits.
4. Apply deterministic hash sampling and the global file/byte caps.
5. Implement the three pure AST detector families; filename-only and test-layout detectors are excluded from the first cut. The wrappers algorithm and mutually exclusive error-style classifier are specified in §6.
6. Do not add model calls or persistent storage in this ticket.

**Acceptance:** a PR that rewrites most of the repository cannot change the baseline through touched files; sampling is deterministic and every detector has positive/negative/mixed/ambiguous coverage.

### P6-02 — Support filtering and stable convention records

**Purpose:** retain only high-support patterns.

**Work:** calculate per-detector denominators, apply 75% support and five-distinct-file minimums, apply the 20% dominance margin to mutually exclusive error styles, generate stable IDs, and cap/sort evidence deterministically.

**Acceptance:** include an explicit regression proving `3 of 5` is rejected; error-style results are mutually exclusive; zero denominators and ambiguous dominance emit nothing.

### P6-03 — Lean advisory projection and token-budget packer

**Purpose:** ensure ordinary changed units fit the advisory budget without silently dropping useful context.

**Work:**

1. Define the dedicated `ConventionAdvisoryUnit`, `ConventionAdvisoryUnitProjector`, and batch-input types; do not derive the projection from `Omit<ReviewUnit, "rules">`.
2. Project unit-scoped diff hunks plus AST-derived changed-symbol name/kind/signature and complete symbol source only when it fits the 800-token symbol-source ceiling.
3. Remove duplicate line content between symbol source and hunks; preserve every changed line, dropping unchanged context before any other content.
4. Carry a sanitized `AdvisoryConventionSummary[]` once per request (not `InferredConvention[]` and not once per unit). Add model-aware input-token counting for the complete serialized request and enforce the 1500-token unit ceiling and 6000-token request ceiling.
5. Pack at most three units per request and 15 units/five requests per run; record aggregate skips for unprojectable/oversized units.
6. Add golden projection/token-count tests for small, typical, oversized, deleted-symbol, missing-AST, and multi-hunk units.

**Acceptance:** representative real changed units no longer inherit the 5.7k–8.9k full-context payload; all dispatched requests are measured under 6000 input tokens; no changed diff line is silently removed to meet the budget.

### P6-04 — Bounded advisory model pass and typed validation outcomes

**Purpose:** implement an opt-in, hard-budgeted model pass and ensure pending results cannot be persisted.

**Work:**

1. Build the separate prompt/schema and exclude evidence paths/line references from prompt input.
2. Use the P6-03 projection and pack at most 15 units into five requests of at most three units each.
3. Enforce complete serialized input/output token limits, zero retries on an advisory-specific provider instance, the run-scoped shared concurrency limiter, max two advisory requests in flight, and five total provider invocations.
4. Apply the existing `CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING` gate before every advisory provider invocation.
5. Start advisory model work as soon as conventions are ready; do not wait for the primary model pass.
6. Enforce strict output parsing and trusted provenance.
7. Implement the shared validation core with `PendingAdvisoryCandidate`; materialize `ValidatedFinding` only after all advisory filters.

**Acceptance:** count actual provider invocations (including retries) in tests and prove the hard limit; prove advisory runs concurrently with primary; prove pending candidates are not assignable to persisted result types.

### P6-05 — Merge, failure isolation, and usefulness evaluation

**Purpose:** integrate Phase 6 without risking primary reviews and determine whether its output is useful.

**Work:**

1. Wire the flag-gated optional dependency bundle in the CLI/pipeline.
2. Start primary review immediately and advisory review after convention build, independently.
3. Implement the simple same-path verified-head-interval overlap rule and C1–C7 tests.
4. Apply advisory-only dedupe/cap, then materialize and append final advisory records.
5. Add explicit failure-injection tests for malformed/missing handoff, provider timeout, malformed schema, detector/snapshot failure; every ordinary advisory failure returns primary-only or partial advisories without changing primary data.
6. Add a manual live-evaluation harness under `tests/live/phase6-eval/`; it is not part of the offline `bun run check` suite and must require explicit operator invocation and provider credentials.
7. Build the evaluation corpus from at least 30 real, publicly available merged PRs across at least five independent repositories, pinned by repository URL, base SHA, head SHA, and PR URL. Seeded fixtures may test correctness but must never count toward evaluation precision or candidate minimums.
8. Run primary-only and Phase 6-enabled evaluations on the same pinned PRs. Independently label every emitted advisory candidate as `useful`, `technically-correct-but-not-actionable`, or `incorrect/unsupported`; resolve label disagreements through a documented adjudication pass. Require at least 30 emitted real-PR candidates and at least 80% `useful` precision, zero non-low/authority violations, and report request count, input/output tokens, projection skips, and added median/p95 wall-clock latency.
9. If the evaluation does not pass, keep the flag available only for development/experiments and do not recommend routine use; do not weaken thresholds to pass.
10. Update docs once per implementation milestone; consolidate invariants in this plan and link back rather than copying full lists across documents.

**Acceptance:** primary output is byte-identical with flag off/on; advisory provider calls never exceed five; the eval gate passes; CodeBleach `bun run check` and all three-platform CI jobs pass.

## 16. Focused acceptance matrix

### 16.1 Opt-in, scheduling, and budgets

- Flag absent: byte-identical Phase 5 behavior and zero convention-scan/advisory activity.
- Flag enabled: primary request payload remains byte-identical to flag-off; advisory receives no explicit rules or evidence paths.
- Primary model call starts before convention build completes; advisory starts as soon as the build completes, without awaiting primary completion.
- At most five actual advisory provider invocations, 15 units/run, three units/request, 1500 tokens/unit, 900 fixed tokens/request, 600 convention tokens/request, 6000 total input tokens/request, 1200 output tokens/request, and two concurrent advisory requests. The advisory-specific provider has retries set to zero and shares the run-scoped primary concurrency limiter (one `RunConcurrencyLimiter` per live run).
- Demo and `--no-llm` perform no Phase 6 work regardless of flag.
- A denied `CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING` gate results in zero advisory provider calls and unchanged primary results.

### 16.2 Baseline and detector correctness

- Convention sample uses merge-base and excludes modified/added/deleted/renamed old+new paths.
- Dirty working tree and PR head rewrites do not affect the convention baseline.
- Paths containing control characters are excluded from discovery and prompt projections.
- Error detector emits at most one dominant style per repository; mixed files support neither; insufficient 20% margin emits none.
- Wrapper detector resolves only unambiguous repository-relative imports and structurally verified callback calls; ambiguous/import-alias edge cases are tested.
- Filename-only and test-layout conventions are not emitted in the first cut.
- `3 of 5` fails support; 75% plus five distinct matching files is required.

### 16.3 Validation and failure isolation

- Public `validate()` and primary Phase 6 validation produce byte-identical primary findings.
- Pending advisory type is distinct from `ValidatedFinding`, contains no nested final result, and can only be materialized after conflict/dedupe/cap.
- Advisory severity projection admits exact `low`, strips severity overrides, and preserves confidence overrides.
- Verified head actuals only; handoff associations use finding IDs.
- Empty `headLocations` is valid for primary or advisory findings and means no head-side conflict is possible; include a validator-accepted base-only case if current Phase 5 evidence rules permit one.
- Missing/duplicate primary association or malformed primary locations drop all advisories but preserve primary; a malformed/missing advisory handoff drops only that candidate.
- Advisory provider/parse/detector/merge failure never fails the review or changes primary data; caller cancellation still cancels the run.

### 16.4 Conflict and artifact

- Same-path overlapping verified head intervals suppress advisory; adjacent/non-overlapping intervals do not.
- Cited ranges never determine conflicts.
- Advisory dedupe/cap operate only inside advisory domain; primary findings cannot be evicted.
- Artifact schema v2, `ValidatedFinding`, `ValidationSummary`, and `ReviewDiagnostic` shapes remain unchanged; no handoff or conflict metadata persists.
- Logs contain bounded aggregate counts/codes only.

### 16.5 Real-PR labeled usefulness evaluation

- The live harness is `tests/live/phase6-eval/` and is invoked manually; it is not part of offline unit/integration checks.
- Corpus contains at least 30 real, publicly available merged PRs across at least five independent repositories. Each entry pins repository URL, PR URL, base SHA, and head SHA.
- Seeded fixtures and synthetic repositories are excluded from both the 30-candidate minimum and useful-precision denominator.
- Run primary-only and Phase 6-enabled variants on the same pinned PRs; label all emitted advisory candidates independently, then adjudicate disagreements.
- Labels are `useful`, `technically-correct-but-not-actionable`, and `incorrect/unsupported`.
- At least 30 real-PR candidates must be emitted; fewer means insufficient evaluation, not a pass.
- Useful precision must be at least 80%, with zero authority/severity violations.
- Report per-run provider calls, input/output tokens, projection skips, and added median/p95 latency.
- Evaluation failures block routine enablement; the default remains off.

---

## 17. Performance, failure, and security limits

### 17.1 Hard bounds

The enforceable advisory limits are defined once in §9.3: five provider invocations, 15 units/run, three units/request, 1500 tokens/unit, 900 fixed tokens/request, 600 convention tokens/request, 6000 total input tokens/request, 1200 output tokens/request, two concurrent advisory requests, and five final advisory findings. Detector/snapshot bounds are defined in §§5 and 7. No cache exists in the first cut. Do not add unbounded retries or hidden provider repair calls.

### 17.2 Failure policy

- Detector/snapshot failure: use no conventions or the remaining independently valid detector outputs; continue primary.
- Advisory request failure: drop that request batch; retain other successful batches and primary.
- Advisory validation or conflict failure: discard all advisories if global association safety is uncertain; preserve primary unchanged.
- Candidate-local bad handoff: drop only that candidate.
- Missing/duplicate primary handoff: drop all advisories for the run.
- Ordinary advisory failures are non-fatal. Caller cancellation remains run cancellation.

### 17.3 Security

- Convention discovery reads only the merge-base Git object database and never executes target-repository code. No cache filesystem surface is introduced in the first cut.
- Do not send convention evidence paths/line references or sampled source excerpts to the advisory prompt. For changed-unit paths, skip an advisory unit if its path contains a control character; do not rewrite the primary prompt or primary payload.
- Reject all control characters in paths before they enter prompt-adjacent structures.
- No network or model tools from detector/conflict code.
- Treat repository text and advisory model output as untrusted; strictly parse schemas and recompute convention IDs.
- Keep secrets, excerpts, raw prompts/responses, and transient handoff out of logs/artifacts.

## 18. Documentation and ADR updates

ADR 0043 (accepted P6-00) records the Phase 6 pipeline dependency and
primary handoff method. It supplements ADRs 0041–0042; it does not rewrite
them. ADR 0044 records the implementation hardening deltas (shared limiter,
rank-first bounded sizing, wrapper denominators, eval-gate integrity).

Update `systemdesign.md`, `docs/validation.md`, and this plan only when a decision or implementation status changes. Keep the detailed invariants in this plan and use concise references from other documents; do not copy the same rule lists into multiple files. Add a README/docs-index pointer only if repository conventions require it.

Correct systemdesign principle wording from "all intermediate data is written to run.json" to a precise statement such as: **"Artifact-safe run outputs are persisted in `run.json`; sensitive or run-scoped internal metadata (including verified validation handoff and conflict diagnostics) remains transient and is deliberately excluded."**

Never rewrite ADRs 0039–0042. ADR 0043 records the internal handoff/pipeline seam. If implementation needs another architecture decision, record a new ADR before changing the contract.

---

## 19. Explicit non-goals and forbidden diffs

Phase 6 does not include GitHub publishing changes, Phase 7 behavior, new languages, database/vector/embedding infrastructure, persistent convention cache, filename/test-layout detectors, LLM-based detectors, learning/feedback storage, autofix, repository execution, or new third-party dependencies.

The detailed authority, contract, and persistence boundaries are defined in §§1, 4, 10, and 13. In particular, do not change the primary prompt, public `ValidationEngine.validate()`, `.reviewer.yml`, `ValidatedFinding`, validation check codes, artifact schema v2, or primary dedupe semantics. Expected `src/github/` and workflow diffs are empty.

## 20. PR and release discipline

Submit one PR per ticket in sequence. Each PR must:

1. Target the latest `main` and identify the exact base SHA.
2. State the P6 ticket and list changed files.
3. Explain any deviation from this plan before introducing it.
4. Confirm no unrelated Phase 5 or Phase 7 changes.
5. Include CI links and results. CI must pass on Ubuntu, macOS, and Windows.
6. Confirm no new dependencies or network calls.
7. Confirm `bun run check` passed locally for CodeBleach before the commit, as required by `AGENTS.md`. Confirm no code/tests/builds from the reviewed target repository were executed locally.
8. Include a concise test matrix, the advisory provider-call/token budget results, and any skipped mode/failure cases.
9. Remain open for review; do not merge automatically.

Before the final Phase 6 PR is considered complete, perform a repository-wide search for the forbidden claims/fields in §19 and verify all docs/ADRs agree. Check the full diff against the last runtime baseline and confirm the only runtime changes are within the approved Phase 6 modules and integration seams.

## 21. Phase 6 final acceptance gate

Status: implementation items are built on `fix/phase6-final-hardening`
(§22); the real-PR labeled evaluation gate (§16.5) has not passed yet, so
the feature stays opt-in and Phase 7 must not assume Phase 6 is cleared.

Phase 6 is complete only when:

- [ ] P6-00 through P6-05 are merged in sequence on current `main`.
- [ ] ADR 0043 records the internal Phase 6 handoff and DI seam.
- [ ] `--convention-advisory` is explicit opt-in; flag-off produces no Phase 6 work.
- [ ] Conventions derive from merge-base and exclude all PR-touched paths.
- [ ] The three first-cut detector algorithms, high-support thresholds, and path-control filtering pass the tests in §16.2.
- [ ] Advisory provider usage obeys every hard bound in §9.3, uses the lean projection/token counter, honors the training gate, and overlaps primary model work.
- [ ] Advisory model/provider/validation failures preserve primary findings; empty head locations are valid and malformed/missing handoff behavior follows §11.2.
- [ ] Pending advisory candidates cannot be persisted before finalization.
- [ ] Conflict suppression uses only same-path verified head-interval overlap.
- [ ] Primary behavior and all public Phase 5/artifact contracts remain unchanged.
- [ ] The real-PR labeled usefulness evaluation in §16.5 meets its gates before routine enablement is recommended.
- [ ] CodeBleach `bun run check` and Ubuntu/macOS/Windows CI all pass.
- [ ] Documentation references this plan rather than duplicating its invariants.

Until every gate passes, the feature remains opt-in and Phase 7 must not assume Phase 6 is implemented.

---

## 22. Implementation record (P6-00..P6-05 as built)

This section records what actually landed, ticket by ticket. Normative
bounds above are unchanged; deltas from the pre-implementation draft are
called out and decided in ADR 0044.

### P6-00 — contracts, opt-in, architecture lock

- Flag `--convention-advisory` (default false), help text states the extra
  advisory model requests over repository code (`src/cli/index.ts`).
  Demo and `--no-llm` bypass Phase 6 regardless of the flag
  (`pipelineConventionAdvisoryEnabled`).
- `PipelineDeps.phase6` optional bundle plus
  `PipelineOptions.conventionAdvisoryEnabled`; enabled-without-bundle is a
  preflight composition error, never a silent downgrade
  (`src/core/pipeline.ts`).
- `PendingAdvisoryCandidate` omits `status`; `@ts-expect-error`
  non-assignability test proves it cannot persist as `ValidatedFinding`.
- Token counter confirmed: the provider exposes no tokenizer, so
  `ADVISORY_TOKEN_COUNTER_MODE = "utf8-byte-upper-bound"` via
  `estimateTokens` (`src/conventions/token-budget.ts`).
- ADR 0043 accepted (contracts-only).

### P6-01 — merge-base sampling and deterministic detectors

- `sampleMergeBase` (`src/conventions/sampling.ts`): pinned merge-base
  tree via `ls-tree -r -z`; both rename sides excluded before ranking;
  control-character paths, unsupported extensions, lockfiles, ignored
  paths, binary/empty/oversized/generated blobs excluded; rank-first
  bounded sizing in ≤200-OID `--batch-check` batches
  (`SAMPLING_SIZE_BATCH_OIDS = 200`); caps 200 files / 128 KiB per blob /
  8 MiB total; policy version 2.
- Three pure detectors, each `(files) -> DetectorCandidate[]`:
  `detectNamingExports` (`naming-exports` v1, named-vs-default plurality,
  mixed modules eligible but supporting neither), `detectErrorHandling`
  (`error-handling` v1, result-vs-throw plurality with per-file mutual
  exclusion and runner-up count), `detectCommonWrappers`
  (`common-wrappers` v2, per-(helper, symbol) groups with
  lexical-scope-aware call resolution).
- `ConventionEngineImpl.build` (`src/conventions/engine.ts`): sample →
  parse → detect → support, fully in memory; per-detector failure
  isolation; any ordinary failure returns zero conventions (fail open).

### P6-02 — support filtering and stable records

- `filterConventions` (`src/conventions/support.ts`): 0.75 ratio by exact
  integer cross-product (`matching*4 >= eligible*3`), five-file minimum,
  20% dominance margin (`(lead-runnerUp)*5 >= eligible`) applied only when
  a runner-up is reported (error-handling), stable `inf-` ids from
  SHA-256 over detector/version/normalized-pattern, evidence truncated to
  8 after the full count is kept, deterministic order, cap 20.

### P6-03 — lean projection and token-budget packer

- `createPinnedAdvisoryProjector` (`src/conventions/projection.ts`):
  pinned snapshot texts, unit-scoped hunks (≤2 context lines, 500-token
  hunk target, changed lines never dropped), complete symbol source only
  under 800 tokens, `unknown` marker when no AST symbol, oversized units
  skipped with aggregate count.
- `packAdvisoryBatches` (`src/conventions/packer.ts`): ≤3 units per
  request, ≤5 requests / 15 units per run, ≤8 convention summaries (once
  per request) under 600 summary tokens, full-request measurement under
  6000 tokens; overflow sheds summaries first, then context, then whole
  units.

### P6-04 — bounded advisory pass and typed validation outcomes

- `ConventionAdvisoryReviewEngineImpl.reviewBatch`
  (`src/review/convention-engine.ts`): exactly one provider invocation, no
  repair/escalation retry; strict Zod schema (literal `convention` /
  `low`, no `ruleId` member, ≤5 entries); unknown/duplicate unitId or
  >1 finding per unit drops the whole batch; trusted provenance stamped
  by orchestration; training-consent gate before any network call.
- Shared per-finding core with isolated advisory policy
  (`src/validate/engine.ts` `ValidationEngineImpl implements
  ValidationEngine, Phase6ValidationEngine`; advisory views/policy in
  `src/validate/advisory.ts`): advisory severity pinned to `low`, path
  severity overrides ignored, confidence overrides preserved.
- Prompt `convention-advisory-v1` (`src/review/convention-prompt.ts` +
  `prompts/review/convention-advisory-v1.md`): separate template, version,
  and hash; convention summaries only, no evidence paths/lines.

### P6-05 — merge, failure isolation, usefulness evaluation

- Orchestration (`src/core/phase6.ts`, `src/core/pipeline.ts`): primary
  starts immediately; advisory starts once conventions are ready;
  `Promise.allSettled` join; advisory capped at 2 in flight under the
  run-scoped shared limiter; merge order validate → boundary gate →
  suppress → advisory dedupe → cap 5 → finalize → append.
- Conflict (`src/validate/conflict.ts`): same-path verified-head-interval
  overlap only; `gateAdvisoryBoundary`, `validatePrimaryHandoffStructure`,
  `validateAdvisoryHandoffEntry`, `suppressOverlappingAdvisory`,
  `dedupeAdvisoryCandidates`, `capAdvisoryCandidates`,
  `resolveAdvisoryMerge`; every ordinary failure is fail-open to
  primary-only or partial advisories; caller abort still cancels.
- Live eval harness (`tests/live/phase6-eval/`, manual-only,
  `CODEBLEACH_PHASE6_EVAL=1`, never under `bun run check`/CI): pinned
  30-PR corpus across 6 repositories (`corpus.json`); per-PR primary-only
  vs advisory pair at info level; stderr metrics parsed by exact `msg`
  match (`eval-metrics.ts`, missing telemetry fails instead of zero);
  emitted-counted gate (`eval-gate.ts`: ≥30 emitted real-PR candidates,
  ≥80% `useful`, zero authority violations); labels
  `useful`/`technically-correct-but-not-actionable`/`incorrect/unsupported`
  with adjudication.
- **Status:** the harness is built; the gate has not been run to pass.
  `--convention-advisory` stays a development/experiment flag (default
  off). A failing gate never weakens thresholds.

### Hardening A–D (on this branch, after P6-05)

- **A — run-scoped shared limiter** (`src/providers/limiter.ts`,
  `RunConcurrencyLimiter`): one instance per live run wraps both
  providers at the `complete()` boundary (retries and JSON-repair funnel
  through it), capping combined in-flight calls at
  `max_concurrent_requests`; no global state.
- **B — eval metrics integrity + emitted-validated gate**: advisory
  telemetry via machine-readable info events on every exit path
  (`advisory pass completed/skipped`, `advisory merge completed/skipped`);
  gate counts emitted records, never labels; missing/malformed telemetry
  fails the gate; labels carrying category/severity/ruleId are rejected.
- **C — rank-first bounded sizing**: sizes resolve in rank order through
  successive ≤200-OID batches with early stop; enumeration order never
  affects the sample.
- **D — per-helper wrapper denominators + scope-aware calls**: each
  (helper, symbol) group carries its own importing-file denominator
  (importers count even without calls); bare-identifier calls resolve
  only through unambiguous local bindings with shadowing
  (params/locals/destructured/catch/hoisted), ambiguous bindings and
  dynamic `with` scopes skipped; pattern template is `Modules importing
  the repository helper <identifier> repeatedly wrap callbacks with it.`

### Explicitly not in this implementation

No persistent convention cache: no `.reviewer-cache/` convention
directory, cache file, key, parser, or write. Every enabled run scans in
memory and discards blobs, trees, intermediates, evidence, and handoff
after orchestration. (The `.reviewer-cache/` row in the systemdesign
Phase 8 table refers to future LLM-response caching, not conventions.)
