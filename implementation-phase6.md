# CodeBleach — Phase 6: Inferred Repository Conventions (plan only, no implementation)

**Baseline:** `main` at or after Phase 5 hardening (PRs #52–#66; deterministic-only validation, artifact v2).
**Audience:** implementing agent (future Phase 6 workstream).
**Scope:** deterministic inferred-convention discovery, file cache, and advisory prompt injection.
**Out of scope:** Phase 7 GitHub publishing/integration, Phase 8 evaluation/optimization, any change to Phase 5 validation semantics.

> **STATUS: PLAN ONLY.** This document proposes tickets, modules, contracts, and
> acceptance criteria. It implements nothing: no `src/` changes, no test changes,
> no publisher changes. The suppression at `src/review/prompt.ts:17,177`
> ("`convention` is Phase 6", "Never report convention findings") stays in force
> until a Phase 6 implementation ticket lands.

---

## 0. Mission and non-negotiable authority constraints

Give each review unit repo-aware context it does not have today (naming/export
patterns, error-handling idioms, test layout, common wrappers) without letting
guessed knowledge outrank verified knowledge.

These constraints are fixed for Phase 6 v1 (from `systemdesign.md` §6). Do not reopen:

1. **Explicit rules are authoritative.** `.reviewer.yml` `rules[]` keep their ids,
   severity, and path scoping. Injected first, numbered (`rule:arch-001`).
2. **Inferred is advisory only**, injected in a separately labeled section.
3. Inferred knowledge can **never raise severity**, **never be the sole basis for
   a finding above `low`**, and **never override an explicit rule**.
4. **Discard weak patterns.** Only high-support conventions survive (thresholds
   locked in P6-00, §4).
5. **No DB, embeddings, vector search, or LLM-learner.** Detectors are
   deterministic scans over head-snapshot source. No model calls, no training,
   no learning from reactions (see §6 non-goals).
6. The cache (`.reviewer-cache/inferred.json`) is **a cache, not learning**:
   content-keyed, invalidated on drift, fail-open to empty.

---

## 1. Current repository contracts to preserve

The implementing agent must verify these against the current tree before editing
(names reflect the tree inspected for this plan; follow moved files, do not
duplicate modules):

- **Explicit-only rules today.** `src/context/rules.ts:4-10` — "No inference:
  output is always a filtered view of the validated config, in configuration
  order." `selectRulesForFile` + `matchGlob` are reused, not forked.
- **Prompt suppression to lift deliberately.** `src/review/prompt.ts:17`
  ("`convention` is Phase 6 and is never requested here"), `CATEGORY_ORDER`
  excludes `convention`, and `buildReviewPrompt` appends "Never report
  convention findings" (`:177`). Phase 6 replaces this line with the advisory
  authority text (§5), never by deleting the guard silently.
- **Policy plumbing already convention-safe.** `src/validate/policy.ts:9-10`
  (`convention` has no toggle, always passes the category gate),
  `CATEGORY_POLICY_GROUP` maps `convention → "convention"`, and unknown
  `ruleId` already fails (`rule_id_unknown`). Inferred patterns must never be
  citable as `ruleId` — no validator change expected (P6-05 confirms).
- **ReviewUnit carries explicit rules.** `src/types/context.ts:22` declares
  `rules: Rule[]` — explicit only today. P6-00 decides the carrier for
  inferred items: preferred is an additive flagged field (e.g.
  `inferredConventions?: InferredConvention[]` on the unit or a flagged rule
  wrapper), ordered after explicit rules and flagged — never silently mixed
  into `rules[]` unflagged.
- **No inferred module exists.** Grep-confirmed: only `convention` category
  plumbing, the prompt suppression above, and unrelated `z.infer`. New code
  lives in a new `src/conventions/` directory (§3), not scattered across
  `context/` and `review/`.
- **Snapshot reads are head-pinned and read-only.** Reuse the Phase 4/5
  `git cat-file --batch` infrastructure and provenance rules (repo-relative
  POSIX paths, allowlisted sampled files only, byte caps, no working-tree
  reads). No new Git/network access patterns.
- **No cache directory today.** `.reviewer-cache/` does not exist; CI
  (`.github/workflows/ci.yml`) has no cache step. Local cache works in Phase 6;
  `actions/cache` restore wiring lands with the Phase 7 workflow (which does
  not exist yet) — plan the key format now so Phase 7 only adds the restore
  step (§4).

---

## 2. Goals and non-goals

### Goals

1. Deterministic detectors produce candidate conventions from the head snapshot.
2. Support-ratio + evidence-count filtering keeps only high-support patterns.
3. One content-keyed cache file with defined invalidation (§4).
4. Advisory injection into the review prompt, explicitly labeled and ordered
   after explicit rules, with authority guardrails in the template text (§5).
5. Explicit-over-inferred precedence proven by tests; inferred-only findings
   capped per the authority constraints.
6. Fully offline, deterministic, bounded (file/sample/byte/token caps).

### Non-goals (explicit)

- No database, embeddings, vector search/index, or persistent source index.
- No LLM-based detection, ranking, summarization, or "learner".
- No learning from 👍/👎, comments, or post history.
- No auto-fix, no cross-repo context, no new languages.
- No severity/toggle/config-schema changes; no new `.reviewer.yml` top-level
  required fields (any tuning knobs are additive + defaulted, or constants).
- No publisher changes: `src/github/` stays absent, the Phase 7 stub stays a
  stub, no workflow files.
- No validation check-code changes: the closed `VALIDATION_CHECK_CODES` set is
  untouched; no new codes without a new ADR.
- No `convention`-category findings above `low` on an inferred-only basis.

---

## 3. Ticket plan (P6-00 … P6-05)

Keep tickets independently reviewable. Proposed modules live under a new
`src/conventions/` directory; adapt names to the tree at implementation time.

### P6-00 — Convention contract, authority audit, and thresholds lock

**Work:**

1. Verify §1 contracts against the current tree; record drift in the
   implementation PR (never rewrite history).
2. Define the carrier decision: additive `InferredConvention` type
   (`src/types/` additions, pure data, no `src/` imports) —
   suggested shape:
   ```ts
   export interface InferredConvention {
     id: string;              // stable: sha1(detector name+version + normalized pattern)
     detector: string;        // e.g. "naming/export-patterns"
     detectorVersion: number; // bump resets cache (§4)
     pattern: string;         // one-sentence human-readable statement, bounded length
     evidenceFiles: string[]; // repo-relative, capped (§4), deterministic order
     supportRatio: number;    // matching / sampled, 0..1
     sampledFiles: number;    // denominator, for audit
   }
   ```
3. Lock thresholds as named constants (initial suggestions; P6-00 justifies and
   freezes): `MIN_SUPPORT_RATIO` (e.g. 0.6), `MIN_EVIDENCE_FILES` (e.g. 3),
   `MAX_CONVENTIONS_PER_RUN` (e.g. 20), `MAX_EVIDENCE_FILES_PER_CONVENTION`
   (e.g. 8), `MAX_SAMPLED_FILES` (e.g. 200, deterministic order), advisory
   token budget share (e.g. ≤ 800 tokens, truncated by whole conventions,
   never mid-pattern).
4. Decide `--no-llm` behavior (proposed: skip convention building entirely —
   preview stays fast and no prompt consumes it) and demo behavior (proposed:
   demo carries zero inferred conventions).
5. Record decisions in a new ADR (next free number; never rewrite ADRs
   0028–0037).

**Tests:** type-shape tests for `InferredConvention`; threshold-boundary tests
against the locked constants; a test pinning the §1 contract list (rules-only
`rules.ts`, prompt suppression text hash, convention gate-pass).

**Accept:** thresholds are named constants with tests; carrier decision
documented; no code beyond types/constants.

### P6-01 — Deterministic detectors (naming, exports, errors, tests, wrappers)

**Modules:** `src/conventions/detectors.ts` (+ per-detector files if justified).

**Work:** implement the four `systemdesign.md` §6 detector families as pure
functions over supplied head-snapshot text (no I/O inside detectors):

1. naming/export patterns (e.g. dominant export style, filename conventions);
2. error-handling idioms (e.g. `Result<T,E>` vs throw, pervasiveness measured,
   not asserted);
3. test layout (co-located vs `tests/` mirroring, per-symbol evidence reuse
   from existing test discovery — read, don't rerun it);
4. common wrappers (repeated construction/cleanup helpers).

Each detector returns candidates `{ pattern, matchingFiles }` with zero
thresholding (P6-02 owns filtering). Detector names + versions are part of the
cache key (§4). Deterministic: sorted inputs, no wall-clock, no randomness.

**Tests:** per-detector unit tests on synthetic sources (positive, negative,
mixed, empty file, binary guard); detector output is byte-identical across
runs and input permutations.

**Accept:** all detectors pure + tested; no I/O, no model calls, no new
dependencies.

### P6-02 — Support filtering and evidence records

**Modules:** `src/conventions/support.ts`.

**Work:** join detector candidates with the sampled file list; compute
`supportRatio = matching / sampled`; drop everything below `MIN_SUPPORT_RATIO`
or `MIN_EVIDENCE_FILES`; cap to `MAX_CONVENTIONS_PER_RUN` by deterministic
order (higher support first, then detector name, then pattern hash — never
completion order); truncate `evidenceFiles` to the cap in sorted order and
record the full count separately for audit.

**Tests:** ratio boundaries (just below / at / above), evidence-count floor,
cap ordering stability under input permutation, denominator recorded
correctly, empty-sample → empty result (never divide by zero).

**Accept:** weak patterns discarded with tests proving the boundary; ordering
deterministic.

### P6-03 — Cache: content-keyed `inferred.json` with invalidation

**Modules:** `src/conventions/cache.ts`. **File:**
`.reviewer-cache/inferred.json`.

**Key design** (filenames alone are insufficient — they miss content and
detector drift). Cache key = `sha1` over the concatenation of:

1. sorted `${blobOid}:${path}` lines for every sampled file (OIDs from the
   head commit via existing batch infrastructure — content change ⇒ key change;
   rename ⇒ path change ⇒ key change);
2. sorted `detector:${name}:${version}` lines (detector change ⇒ key change);
3. `schema:${INFERRED_CACHE_SCHEMA_VERSION}` (shape change ⇒ key change);
4. `config:${hash}` of the explicit-rules-relevant config slice only if P6-00
   finds inferred output depends on config (default: exclude; document either way).

Cache body: `{ version, key, generatedAt, headSha, sampledFiles, conventions[] }`.
On load: missing file, corrupt JSON, version mismatch, or key mismatch ⇒
rebuild (fail-open to empty on read errors that are not the engine's fault;
never fail the run for a cache problem). Write atomically (temp-file-and-rename,
same as `run.json`). No TTL (content key subsumes it). No global state — cache
path resolved from `repoDir`, cleared per run.

Phase 7 note (no implementation): `actions/cache` restore with the computed key
plus a `restore-keys` prefix fallback; Phase 7 only adds the workflow step.

**Tests:** key stability on identical tree; key change on content edit (same
filenames), on detector version bump, on schema bump; stale-key rebuild;
corrupt-cache fail-open; atomic write; no cache read/write outside `repoDir`.

**Accept:** filename-only staleness proven impossible by test (content edit
with identical file list changes the key).

### P6-04 — Advisory prompt injection (lift the suppression deliberately)

**Modules:** `src/review/prompt.ts` (+ template), prompt version bump.

**Work:**

1. Add a separate advisory section after explicit rules in the unit payload
   (flagged items only, P6-00 carrier), labeled e.g.
   `"inferredConventions (advisory — see authority rules)"`.
2. Replace the "Never report convention findings" line with the authority text
   (§5) in the template; bump `CODE_REVIEW_PROMPT_VERSION` (`code-review-v2`)
   so the existing prompt-hash machinery records the change.
3. Advisory section obeys the token budget share from P6-00 (whole-convention
   truncation, explicit rules never truncated for inferred).
4. `convention` category stays out of the requested in-scope categories
   (`CATEGORY_ORDER` unchanged); findings may reference inferred patterns as
   context but never as `ruleId`.

**Tests:** advisory section present/labeled/ordered-after-explicit; authority
text present verbatim; explicit rules byte-identical with conventions on/off;
budget truncation drops whole conventions; prompt version + hash update;
`--no-llm`/demo carry no advisory section.

**Accept:** suppression lifted only via the labeled advisory path; no silent
guard deletion (test asserts the old bare line is gone AND the authority text
is present).

### P6-05 — Policy/validation guards and docs hardening

**Work:**

1. Confirm no validator change: inferred ids are not valid `ruleId`
   (`rule_id_unknown` already rejects them — add a regression test proving an
   inferred-style id is rejected, without touching the closed code set).
2. Confirm `convention` gate behavior unchanged (always passes; no toggle).
3. Document the severity cap operationally: prompt authority text + review-stage
   tests asserting inferred-only context cannot mint `ruleId` citations; any
   finding above `low` must stand on non-inferred evidence (enforced by prompt
   contract and eval, not by new validator codes).
4. Sync `systemdesign.md` §6/§13 rows, `docs/validation.md` (one line: inferred
   is advisory, never validation evidence), and README docs index if a new doc
   is added. No ADR rewrites.
5. Assemble the Phase 6 matrix: explicit-beats-inferred precedence,
   advisory-label presence, cache round-trip, cap behavior, offline determinism
   (zero provider/GitHub calls — reuse the Phase 5 fetch-guard pattern).

**Accept:** validator + publisher diffs are empty by construction (assert via
review of the Phase 6 diff); docs agree; matrix green.

---

## 4. Cache key design (authoritative summary)

```
key = sha1(
  sort(sampledFiles.map(f => `${headBlobOid(f)}:${f.path}`)).join("\n")
  + "\n" + sort(detectors.map(d => `detector:${d.name}:${d.version}`)).join("\n")
  + `\nschema:${INFERRED_CACHE_SCHEMA_VERSION}`
)
```

- **Why not filenames:** identical file lists with edited contents (or a
  detector upgrade) must invalidate; filename hashing misses both. Test in
  P6-03 proves it.
- **Invalidation triggers:** key mismatch, schema version mismatch, corrupt or
  missing file, sampled-set change (different OIDs/paths ⇒ different key).
- **Refresh:** rebuild synchronously in-run, bounded by the same run deadline
  family as context (P6-00 sets the bound; over-budget ⇒ empty conventions +
  diagnostic, never a failed run).
- **Eviction:** none beyond rebuild (single file, bounded by
  `MAX_CONVENTIONS_PER_RUN × (pattern + capped evidence)`).
- **CI:** local file works now; `actions/cache` keyed on this key in Phase 7.

---

## 5. Authority enforcement (how, without touching the validator)

1. **Prompt text** (normative, tested verbatim): explicit rules numbered and
   authoritative; inferred section labeled advisory with the three
   never-rules (raise severity / sole-basis-above-low / override explicit).
2. **No citable ids:** inferred items carry `id` namespaced (e.g. `inf-*`)
   that can never match a `.reviewer.yml` rule id; `rule_policy` rejects them
   as unknown by existing logic.
3. **Ordering:** explicit first, inferred second, flagged — in payload,
   template, and tests.
4. **Severity:** no code raises severity from inferred; the cap is a prompt
   contract verified by the Phase 6 matrix and later by Phase 8 evals, not by
   a new validator gate (closed code set stays closed).

---

## 6. Test coverage and acceptance

| Area | Tests |
|---|---|
| Types/thresholds (P6-00) | shape, boundary constants, §1 contract pins |
| Detectors (P6-01) | positive/negative/mixed/empty per family, determinism under permutation |
| Support (P6-02) | ratio + count boundaries, cap order stability, zero-sample safety |
| Cache (P6-03) | key stability/drift (content, detector, schema), stale rebuild, corrupt fail-open, atomic write, path containment |
| Prompt (P6-04) | advisory label/order, authority text, explicit-unchanged, budget truncation, version/hash, no-llm/demo exclusion |
| Guards (P6-05) | inferred-id rejected as `ruleId`, convention gate unchanged, zero provider/GitHub calls, validator+publisher diff empty |
| Integration | fixture repo end-to-end (conventions appear advisory; explicit rule wins on conflict); clean repo (no conventions, no findings change) |

**Global accept:** `bun run check` green; deterministic (two runs, byte-identical
conventions); offline (no network); bounded (caps hit without failure);
`src/validate/`, `src/github/`, and workflow diffs empty.

---

## 7. Risks

Detector noise (→ high thresholds + eval review in Phase 8) · prompt bloat
(→ token share cap, explicit-first truncation order) · cache staleness
(→ content key, §4) · inferred laundering into `ruleId` (→ namespaced ids +
rejection test) · scope creep into validation/publisher (→ P6-05 empty-diff
check).
