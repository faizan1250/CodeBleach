# CodeBleach — Phase 6: Inferred Repository Conventions (plan only, no implementation)

**Baseline:** `main` at or after Phase 5 hardening (PRs #52–#66; deterministic-only validation, artifact v2).
**Audience:** implementing agent (future Phase 6 workstream).
**Scope:** deterministic inferred-convention discovery, file cache, and advisory prompt injection.
**Out of scope:** Phase 7 GitHub publishing/integration, Phase 8 evaluation/optimization, any change to Phase 5 validation semantics.

> **STATUS: PLAN ONLY.** This document proposes tickets, modules, contracts, and
> acceptance criteria. It implements nothing: no `src/` changes, no test changes,
> no publisher changes. The suppression at `src/review/prompt.ts:17,177`
> ("`convention` is Phase 6", "Never report convention findings") stays in force
> until a Phase 6 implementation ticket lands. No `src/conventions/` runtime
> exists today (verified by absence); Phase 5 validation is the ADR 0038
> occurrence-ordered interval index (not the never-implemented ADR 0037 probe).
> Phase 7 publishing and Phase 8 evaluation are out of scope and unchanged by
> this plan. Historical ADRs 0028–0038 are preserved, never rewritten; plan
> corrections land in a new ADR (see P6-00).

---

## 0. Mission and non-negotiable authority constraints

Give each review unit repo-aware context it does not have today (naming/export
patterns, error-handling idioms, test layout, common wrappers) without letting
guessed knowledge outrank verified knowledge.

These constraints are fixed for Phase 6 v1 (from `systemdesign.md` §6). Do not reopen:

1. **Explicit rules are authoritative.** `.reviewer.yml` `rules[]` keep their ids,
   severity, and path scoping. Injected first, numbered (`rule:arch-001`).
   Only the primary review pass sees them (P6-04).
2. **Inferred is advisory only**, produced by a SEPARATE convention-advisory
   pass — never mixed into the primary pass. Advisory findings are
   `convention`-category ONLY, max severity `low`; a non-convention category
   or above-`low` severity from the advisory pass is impossible by
   app-enforced invariant (orchestration merge cap, §5), not by prompt text.
   Provenance (`origin.pass: "convention-advisory"`) is stamped by trusted
   orchestration code, never by an LLM field.
3. Inferred knowledge can **never raise severity**, **never be the sole basis for
   a finding above `low`** (app-enforced: the advisory pass cannot emit one),
   and **never override an explicit rule** (deterministic merge: primary
   findings are never altered or dropped for advisory ones).
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
- **ReviewUnit carries explicit rules only.** `src/types/context.ts:22` declares
  `rules: Rule[]` — explicit only, today and after Phase 6. P6-00 decides the
  carrier for inferred items: additive flagged field separate from `rules[]`
  (e.g. `inferredConventions?: InferredConvention[]` on the unit or on the
  advisory-pass input — never silently mixed into `rules[]` unflagged). The
  primary pass input never carries inferred items (§5).
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
- No `convention`-category findings above `low` on an inferred-only basis
  (app-enforced merge invariant, §5 — not prompt obedience).

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
   export interface ConventionEvidence {
     file: string;        // repo-relative POSIX path, head snapshot only
     startLine: number;   // 1-based, head-snapshot lines
     endLine: number;     // >= startLine
   }
   export interface InferredConvention {
     id: string;              // stable: sha1(detector name+version + normalized pattern), `inf-` namespaced (never a valid ruleId)
     detector: string;        // e.g. "naming/export-patterns"
     detectorVersion: number; // bump resets cache (§4)
     pattern: string;         // one-sentence human-readable statement, bounded length
     evidence: ConventionEvidence[]; // retained locations, deterministic order (sorted by file, then startLine), capped
     matchingFiles: number;   // files exhibiting the pattern (full count, audit)
     eligibleFiles: number;   // detector-eligible files in the sampled set (denominator, audit)
     sampledFiles: number;    // total sampled files (global audit denominator)
     supportRatio: number;    // matching / eligible, 0..1 (never divide by zero: zero eligible ⇒ no convention, diagnostic)
   }
   ```
   `evidenceFiles: string[]` (repo-relative, capped, deterministic order) is a
   derived view over `evidence` (paths only), kept only where a path list is
   the convenient shape; the full `matchingFiles` count is always recorded
   separately for audit. No raw source excerpts anywhere in the type, the
   cache body, or the prompt — pattern text + `file:start-end` references only.
3. Lock thresholds as named constants (initial suggestions; P6-00 justifies and
   freezes): `MIN_SUPPORT_RATIO` (e.g. 0.6), `MIN_EVIDENCE_FILES` (e.g. 3),
   `MAX_CONVENTIONS_PER_RUN` (e.g. 20), `MAX_EVIDENCE_PER_CONVENTION`
   (e.g. 8, applies to retained `evidence`), `MAX_SAMPLED_FILES` (e.g. 200,
   deterministic order), advisory token budget share (e.g. ≤ 800 tokens,
   truncated by whole conventions, never mid-pattern).
4. Lock the sampling policy and version it: `SAMPLING_POLICY_VERSION`
   covering file selection order, per-detector eligibility rules, language
   scoping, `MAX_SAMPLED_FILES`, and population rules (which files may be
   sampled at all). The version is part of the cache key (§4); any policy
   change bumps it and invalidates the cache.
5. Decide `--no-llm` behavior (proposed: skip convention building entirely —
   preview stays fast and no prompt consumes it) and demo behavior (proposed:
   demo carries zero inferred conventions).
6. Record decisions in a new ADR (next free number; never rewrite ADRs
   0028–0038).

**Tests:** type-shape tests for `InferredConvention` + `ConventionEvidence`
(bounds: `endLine >= startLine`, 1-based; ordering: file then startLine;
serialization round-trip); threshold-boundary tests against the locked
constants; a test pinning the §1 contract list (rules-only `rules.ts`,
prompt suppression text hash, convention gate-pass).

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
thresholding (P6-02 owns filtering). Each detector ALSO declares a pure
eligibility predicate over `(path, head-snapshot text)` defining which sampled
files it can meaningfully judge — suggested policies (P6-00 locks the exact
rules):
1. naming/export patterns — eligible: source files with at least one
   export/definition statement;
2. error-handling idioms — eligible: source files using `throw`, `Result`,
   `try/catch`, or equivalent error-surface syntax;
3. test layout — eligible: source files plus test files (layout is a
   file-pairing property; detectors read pairing evidence, never rerun tests);
4. common wrappers — eligible: source files with repeated construction/cleanup
   call shapes.
Detector names + versions are part of the cache key (§4). Deterministic:
sorted inputs, no wall-clock, no randomness. Ineligible files are excluded
from that detector's denominator (never counted as misses).

**Tests:** per-detector unit tests on synthetic sources (positive, negative,
mixed, empty file, binary guard, ineligible-file exclusion); detector output
is byte-identical across runs and input permutations.

**Tests:** per-detector unit tests on synthetic sources (positive, negative,
mixed, empty file, binary guard); detector output is byte-identical across
runs and input permutations.

**Accept:** all detectors pure + tested; no I/O, no model calls, no new
dependencies.

### P6-02 — Support filtering and evidence records

**Modules:** `src/conventions/support.ts`.

**Work:** join detector candidates with the sampled file list; for each
candidate compute `eligibleFiles` (sampled files passing that detector's
eligibility predicate), `matchingFiles` (eligible files exhibiting the
pattern), and `supportRatio = matchingFiles / eligibleFiles`. Zero eligible
⇒ no convention from that candidate (empty result, diagnostic, never divide
by zero). Drop everything below `MIN_SUPPORT_RATIO` or below
`MIN_EVIDENCE_FILES` (retained-evidence count); cap to
`MAX_CONVENTIONS_PER_RUN` by deterministic order (higher support first, then
detector name, then pattern hash — never completion order); truncate retained
`evidence` to `MAX_EVIDENCE_PER_CONVENTION` in sorted order (file, then
startLine) and always record the full `matchingFiles` count separately for
audit. `sampledFiles` (global total) is recorded on each convention for audit
but is NOT the denominator.

**Tests:** ratio boundaries per detector family (just below / at / above
`MIN_SUPPORT_RATIO`), evidence-count floor, zero-eligible ⇒ empty (no
division), cap ordering stability under input permutation, denominators
recorded correctly (`eligibleFiles`/`matchingFiles`/`sampledFiles` counts),
empty-sample → empty result (never divide by zero).

**Accept:** weak patterns discarded with tests proving the boundary;
denominator is per-detector eligible (global-sampled-denominator regressions
covered by test); ordering deterministic.

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
4. `sampling:${SAMPLING_POLICY_VERSION}` (selection order, eligibility rules,
   language scoping, `MAX_SAMPLED_FILES`, population rules — policy change ⇒
   key change even with identical OIDs/detector/schema). `config:${hash}` of
   the explicit-rules-relevant slice only if P6-00 finds inferred output
   depends on config (default: exclude; document either way).

Cache body: `{ version, key, samplingPolicyVersion, generatedAt, headSha,
sampledFiles, conventions[] }`. On load: missing file, corrupt JSON, version
mismatch, or key mismatch ⇒ rebuild. Failure matrix (none fail the run):
read-corrupt-not-own-fault ⇒ empty + diagnostic; write-error ⇒ diagnostic,
run continues without cache write; over-budget ⇒ empty conventions +
diagnostic, never a failed run. Write atomically (temp-file-and-rename,
same as `run.json`). No TTL (content key subsumes it). No global state — cache
path resolved from `repoDir`, cleared per run. `.reviewer-cache/inferred.json`
stays a cache: content-keyed, invalidated on drift, fail-open to empty —
never a learning store.

Phase 7 note (no implementation): `actions/cache` restore with the computed key
plus a `restore-keys` prefix fallback; Phase 7 only adds the workflow step.

**Tests:** key stability on identical tree; key change on content edit (same
filenames), on detector version bump, on schema bump, on sampling-policy bump
with identical tree (drift invalidates); stale-key rebuild; corrupt-cache
fail-open; failure matrix (read-error ⇒ empty + diagnostic, write-error ⇒
diagnostic + run continues, over-budget ⇒ empty + diagnostic, never failed);
atomic write; no cache read/write outside `repoDir`.

**Accept:** filename-only staleness proven impossible by test (content edit
with identical file list changes the key); sampling-policy drift proven to
invalidate by test.

### P6-04 — Advisory pass + prompt injection (lift the suppression deliberately)

**Modules:** `src/review/prompt.ts` (+ template), advisory-pass orchestration,
prompt version bump.

**Work — two passes, strictly separated:**

1. **Primary pass (unchanged authority):** existing context + explicit rules
   only, ordinary finding categories, no inferred input. Its prompt, payload,
   and output shape are byte-identical with conventions on/off (test pins
   this). Suppression of `convention` findings in the primary pass stays.
2. **Convention-advisory pass (new, separate):** runs after (or alongside) the
   primary pass with bounded context + inferred conventions labeled advisory
   (`"inferredConventions (advisory — see authority rules)"`). Its output is
   constrained by app code, not by model obedience:
   `convention`-category ONLY, max severity `low`; anything else is rejected
   at the orchestration boundary before merge. `origin.pass` is stamped
   `"convention-advisory"` by trusted code; the model never supplies
   provenance.
3. **Deterministic merge (orchestration, tested):** advisory findings are
   appended; primary findings are never altered, dropped, or re-ranked
   because of advisory output. Explicit rules stay authoritative on conflict
   (explicit wins; the conflict case is covered in P6-05).
4. Replace the "Never report convention findings" line with the authority text
   (§5) in the template; bump `CODE_REVIEW_PROMPT_VERSION` (`code-review-v2`)
   so the existing prompt-hash machinery records the change.
5. Advisory section obeys the token budget share from P6-00 (whole-convention
   truncation, explicit rules never truncated for inferred).
6. `convention` category stays out of the primary pass's requested in-scope
   categories (`CATEGORY_ORDER` unchanged); advisory findings never carry a
   `ruleId` — inferred `inf-*` ids can never match a `.reviewer.yml` rule id
   (P6-05 pins the rejection).

**Tests:** primary prompt/payload byte-identical with conventions on/off;
advisory section present/labeled/ordered-after-explicit; authority text
present verbatim; budget truncation drops whole conventions; prompt version +
hash update; non-convention or above-`low` advisory output rejected at the
merge boundary; provenance stamped by code (model-supplied pass ignored);
`--no-llm`/demo carry no advisory section.

**Accept:** suppression lifted only via the labeled advisory pass; no silent
guard deletion (test asserts the old bare line is gone AND the authority text
is present); primary pass provably inference-free.

### P6-05 — Policy/validation guards and docs hardening

**Work:**

1. Confirm no validator change: inferred ids are namespaced (`inf-*`) and are
   not valid `ruleId` (`rule_id_unknown` already rejects them — add a
   regression test proving an inferred-style id is rejected, without touching
   the closed code set). Check codes stay closed; `run.json` shape unchanged.
2. Confirm `convention` gate behavior unchanged (always passes; no toggle).
3. Pin the caps at the orchestration boundary (app-enforced, tested): the
   merge step rejects advisory output that is not `convention`-category or is
   above `low` before it can reach validation. Prompt authority text is
   guidance (tested verbatim); the caps are invariants (tested by feeding
   violating advisory output at the boundary).
4. Provenance: `origin.pass` for advisory findings is set by orchestration
   code; model-supplied provenance is ignored (test: forged pass value does
   not survive the merge).
5. Sync `systemdesign.md` §6/§13 rows, `docs/validation.md` (one line: inferred
   is advisory, never validation evidence), and README docs index if a new doc
   is added. No ADR rewrites.
6. Assemble the Phase 6 matrix: explicit-beats-inferred precedence,
   advisory-label presence, cache round-trip, cap behavior, offline determinism
   (zero provider/GitHub calls — reuse the Phase 5 fetch-guard pattern).

**Accept:** validator + publisher diffs are empty by construction (assert via
review of the Phase 6 diff); docs agree; matrix green; Phase 5
validation/publisher behavior unchanged (no new codes, no new statuses, no
artifact change).

---

## 4. Cache key design (authoritative summary)

```
key = sha1(
  sort(sampledFiles.map(f => `${headBlobOid(f)}:${f.path}`)).join("\n")
  + "\n" + sort(detectors.map(d => `detector:${d.name}:${d.version}`)).join("\n")
  + `\nschema:${INFERRED_CACHE_SCHEMA_VERSION}`
  + `\nsampling:${SAMPLING_POLICY_VERSION}`
)
```

- **Why not filenames:** identical file lists with edited contents, a
  detector upgrade, or a sampling-policy change must invalidate; filename
  hashing misses all three. Tests in P6-03 prove each.
- **Invalidation triggers:** key mismatch, schema version mismatch,
  sampling-policy version mismatch, corrupt or missing file, sampled-set
  change (different OIDs/paths ⇒ different key).
- **Refresh:** rebuild synchronously in-run, bounded by the same run deadline
  family as context (P6-00 sets the bound; over-budget ⇒ empty conventions +
  diagnostic, never a failed run).
- **Eviction:** none beyond rebuild (single file, bounded by
  `MAX_CONVENTIONS_PER_RUN × (pattern + capped evidence)`).
- **CI:** local file works now; `actions/cache` keyed on this key in Phase 7.

---

## 5. Authority enforcement (two passes + app-enforced invariants)

Prompt text guides the model; app code enforces the invariants. The two must
not be confused: verbatim prompt tests prove guidance is present, boundary
tests prove violations are impossible even when the model disobeys.

1. **Two passes.** Primary: explicit rules + existing context, ordinary
   categories, zero inferred input. Convention-advisory: bounded context +
   inferred conventions, labeled advisory. Separate prompts, separate calls,
   separate provenance (`origin.pass: "primary"` vs `"convention-advisory"`
   stamped by orchestration — never model-supplied).
2. **Prompt text** (normative guidance, tested verbatim): explicit rules
   numbered and authoritative; advisory section labeled with the three
   never-rules (raise severity / sole-basis-above-low / override explicit).
3. **App-enforced invariants** (tested at the boundary, hold against a
   disobedient model): advisory output must be `convention`-category and
   severity ≤ `low` — violations rejected at the orchestration merge;
   inferred `inf-*` ids can never satisfy `ruleId` (existing `rule_id_unknown`
   path); deterministic merge never alters, drops, or re-ranks primary
   findings for advisory ones; explicit wins on conflict.
4. **No validator change:** the closed check-code set stays closed (§6
   accept); caps are enforced before validation, never by new codes.

### Authority acceptance cases (10 — each a test in P6-04/P6-05/§6 matrix)

1. Primary pass input carries zero inferred items (payload pin with
   conventions enabled).
2. Advisory pass receives bounded context only (budget cap pinned).
3. Advisory `convention`-category finding at `low` merges (happy path).
4. Advisory non-`convention` category rejected at the merge boundary.
5. Advisory above-`low` severity rejected at the merge boundary.
6. Provenance stamped by orchestration: forged model `origin.pass` ignored.
7. Inferred `inf-*` id as `ruleId` fails with `rule_id_unknown` (closed set
   untouched).
8. Explicit-vs-advisory conflict: explicit finding stands, advisory defers.
9. Primary findings byte-identical before/after advisory merge.
10. Phase 5 validation + publisher behavior unchanged (validator/publisher
    diffs empty; no new codes, statuses, or artifact fields).

---

## 6. Test coverage and acceptance

| Area | Tests |
|---|---|
| Types/thresholds (P6-00) | shape (`ConventionEvidence` bounds/order/serialization), boundary constants, §1 contract pins |
| Detectors (P6-01) | positive/negative/mixed/empty per family, eligibility exclusion, determinism under permutation |
| Support (P6-02) | per-detector eligible denominator, ratio + count boundaries, zero-eligible safety, cap order stability |
| Cache (P6-03) | key stability/drift (content, detector, schema, sampling-policy), stale rebuild, failure matrix (never fails run), atomic write, path containment |
| Prompt (P6-04) | primary inference-free pin, advisory label/order, authority text, explicit-unchanged, boundary caps (category/severity), provenance stamping, budget truncation, version/hash, no-llm/demo exclusion |
| Guards (P6-05) | inferred-id rejected as `ruleId`, convention gate unchanged, §5 authority cases 1–10, zero provider/GitHub calls, validator+publisher diff empty |
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
