# CodeBleach — Phase 6: Inferred Repository Conventions (plan only, no implementation)

**Baseline:** `main` at or after PR #68 (Phase 5 hardening PRs #52–#68;
deterministic-only validation, artifact v2; ADR 0039 two-pass authority;
ADR 0038 occurrence-ordered PEM index plus the e75df21 sort-free single-scan
linearization).
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
   Only the primary review pass sees them (P6-04). The primary pass input is
   existing context + explicit rules only — byte-identical with conventions
   on/off — and no inferred item ever enters the primary pass.
2. **Inferred is advisory only**, produced by a SEPARATE convention-advisory
   pass — never mixed into the primary pass. Advisory findings are
   `convention`-category ONLY, max severity `low`, no `ruleId` (any supplied
   `ruleId` rejected); a non-convention category, above-`low` severity, or any
   present `ruleId` from the advisory pass is impossible by
   app-enforced invariant (orchestration merge gates, §5), not by prompt text.
   The advisory pass runs under its own separate template, version, hash,
   contract, validation, and boundary — never as a section appended to the
   primary prompt.
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
- **Primary prompt stays unchanged.** `src/review/prompt.ts:17`
  ("`convention` is Phase 6 and is never requested here"), `CATEGORY_ORDER`
  excludes `convention`, and `buildReviewPrompt` appends "Never report
  convention findings" (`:177`) — all preserved verbatim. Phase 6 never edits
  the primary template, `CODE_REVIEW_PROMPT_VERSION`, categories, hash,
  serialization, or output contract. The advisory pass gets its own separate
  template, version, hash, tests, contract, validation, and boundary
  (P6-04, §5).
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
4. A separate advisory contract: its own template, version, hash, and output
   contract carrying inferred conventions labeled advisory, with authority
   guardrails in its own template text (§5) — never a section appended after
   explicit rules in the primary prompt.
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

### P6-04 — Separate convention-advisory pass (primary prompt untouched)

**Modules:** new advisory template (own file, own version constant), new
advisory-pass orchestration. `src/review/prompt.ts` and its template get NO
diff — no primary template edit, no `CODE_REVIEW_PROMPT_VERSION` bump.

**Work — two passes, strictly separated:**

1. **Primary pass (byte-identical on/off):** existing context + explicit rules
   only, ordinary finding categories, zero inferred input. Template bytes,
   `CODE_REVIEW_PROMPT_VERSION`, requested categories, template hash,
   payload serialization, and output contract are byte-identical with
   conventions on/off — pinned by a test that builds the primary prompt both
   ways and asserts equality. The "Never report convention findings" guard
   stays verbatim. No inference into primary, ever.
2. **Convention-advisory pass (new, separate contract):** runs after (or
   alongside) the primary pass with bounded inferred context ONLY (no
   explicit rules) + inferred conventions labeled advisory
   (`"inferredConventions (advisory — see authority rules)"`). It owns a
   separate template file with its own version constant, hash test, output
   contract, validation, and merge boundary — never a section appended to the
   primary prompt. Its output is constrained by app code, not by model
   obedience: `convention`-category ONLY, max severity `low`, and NO
   `ruleId`; anything else is rejected at the orchestration boundary before
   merge. `origin.pass` is stamped `"convention-advisory"` by trusted code
   (any model-supplied value overwritten); the model never supplies
   provenance.
3. **Deterministic merge (orchestration, tested):** advisory findings are
   appended; primary findings are never altered, dropped, or re-ranked
   because of advisory output. Explicit wins on conflict per the deterministic
   conflict identity (§5.1): a conflicting advisory finding is suppressed and
   the primary finding stays byte-identical.
4. Primary template, `CODE_REVIEW_PROMPT_VERSION` (`code-review-v1`),
   `CATEGORY_ORDER`, and the suppression line are preserved verbatim (a test
   pins the primary template hash and version). The advisory authority text
   (§5) lives ONLY in the separate advisory template, which gets its own
   version constant and hash test — no primary version bump exists.
5. Advisory input obeys the token budget share from P6-00 (whole-convention
   truncation; explicit rules are never truncated for inferred because the
   advisory pass never carries explicit rules).
6. `convention` category stays out of the primary pass's requested in-scope
   categories (`CATEGORY_ORDER` unchanged); advisory findings must carry NO
   `ruleId` — missing is the only valid state. ANY supplied `ruleId` on an
   advisory finding is rejected at the orchestration boundary before
   validation: `inf-*` and fabricated ids (which `rule_id_unknown` would
   reject) AND real rule ids (which validation would otherwise ACCEPT via the
   `rule_ok` path — hence presence itself is rejected in orchestration).
   P6-05 pins the four-case matrix.

**Tests:** primary prompt/payload byte-identical with conventions on/off
(template bytes, version, categories, hash, serialization, output contract);
primary template hash + version pinned unchanged; separate advisory
template/version/hash/contract present and distinct from primary; advisory
authority text present verbatim in the advisory template only; budget
truncation drops whole conventions; non-convention, above-`low`, or
`ruleId`-carrying advisory output rejected at the merge boundary (four-case
ruleId matrix: missing ok, `inf-*` / real / fabricated rejected);
model-supplied provenance overwritten by code stamping;
`--no-llm`/demo carry no advisory pass.

**Accept:** primary prompt provably inference-free and byte-identical on/off
(no primary diff exists); advisory lives only under its separate contract;
no silent guard change (test asserts the primary suppression line is still
present verbatim).

### P6-05 — Policy/validation guards and docs hardening

**Work:**

1. Confirm no validator change: advisory findings must carry NO `ruleId`
   (missing is the only valid state). ANY supplied `ruleId` on advisory
   output is rejected at the orchestration boundary before validation —
   four cases, all tested: (a) missing ⇒ ok; (b) `inf-*` ⇒ rejected (would
   fail `rule_id_unknown`); (c) real rule id ⇒ rejected (validation would
   otherwise ACCEPT it via `rule_ok`, so presence itself is rejected in
   orchestration); (d) fabricated id ⇒ rejected (`rule_id_unknown`). No new
   Phase 5 codes. Check codes stay closed; `run.json` shape unchanged.
2. Confirm `convention` gate behavior unchanged (always passes; no toggle).
   Category=`convention` + severity≤`low` gates run at the orchestration
   boundary BEFORE validation; validation never sees violating advisory
   output.
3. Pin the caps at the orchestration boundary (app-enforced, tested): the
   merge step rejects advisory output that is not `convention`-category, is
   above `low`, or carries any `ruleId`, before it can reach validation.
   Prompt authority text is guidance (tested verbatim); the caps are
   invariants (tested by feeding violating advisory output at the boundary).
4. Provenance: `origin.pass` for advisory findings is stamped by trusted
   orchestration code; any model-supplied pass value is overwritten, never
   trusted (test: forged pass value does not survive the merge).
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

Five guarantee kinds — do not conflate them:

1. **Prompt guidance** (advisory-template text, tested verbatim): states the
   never-rules (raise severity / sole-basis-above-low / override explicit) to
   the model. Holds only when the model obeys.
2. **App-enforced invariants** (orchestration merge boundary, tested against a
   disobedient model): advisory output must be `convention`-category AND
   severity ≤ `low` AND carry no `ruleId` — violations rejected before
   validation. Hold even when the model disobeys.
3. **Provenance** (trusted code): `origin.pass` stamped `"primary"` vs
   `"convention-advisory"` by orchestration; any model-supplied pass value is
   overwritten, never trusted.
4. **Merge order** (deterministic orchestration): advisory findings appended
   only; primary findings never altered, dropped, or re-ranked; explicit wins
   on conflict per §5.1.
5. **Phase 5 unchanged:** closed check-code set, validator, publisher, and
   artifact shape untouched; caps enforced before validation, never by new
   codes.

1. **Two passes.** Primary: explicit rules + existing context, ordinary
   categories, zero inferred input; template, version, categories, hash,
   serialization, and output contract byte-identical with conventions on/off.
   Convention-advisory: bounded inferred context ONLY (no explicit rules) +
   inferred conventions, labeled advisory, under its own separate template,
   version, hash, contract, validation, and boundary. Separate prompts,
   separate calls, separate provenance (see kind 3 above).

### 5.1 Deterministic conflict identity (explicit-vs-advisory)

A conflict holds when an advisory finding and a primary finding identify the
same location — defined WITHOUT prose similarity (no title/description
comparison: model prose is untrusted and non-deterministic):

- **Canonical path:** both findings' head-side canonical paths equal after
  snapshot path validation. **Renames canonicalize** to the head-side path:
  `oldPath` spellings map to the same identity, never a separate conflict
  domain.
- **Symbol (with missing-symbol fallback):** compare
  `finding.symbol ?? unit-symbol-name` on each side — a finding without its
  own symbol inherits its unit's symbol. Comparison after fallback is exact;
  no fuzzy matching.
- **Overlapping target/evidence ranges:** resolved head-side target line plus
  cited evidence spans; same canonical file sharing ≥ 1 line (shared-line
  overlap, same safe direction as P5-07 `rangesOverlap`). Near-misses with no
  shared line are NOT conflicts.
- **When conflicting:** same canonical path AND same fallback-resolved symbol
  AND overlapping ranges. Category and title are IGNORED (advisory is always
  `convention`, primary never is; titles are model prose).
- **Missing symbol:** falls back per above; two findings on different symbols
  are distinct defects even at nearby lines (false separation shows both —
  safe direction; false merging would hide a defect).
- **Renames:** head-side path is the identity; evidence citing the old path
  canonicalizes to it before comparison.
- **Overlap calc:** interval intersection over `{target line} ∪ {evidence
  spans}` per finding, same file only; ≥ 1 shared line ⇒ overlap.
- **Multi-primary:** an advisory finding conflicting with ANY retained primary
  finding is suppressed (one suppression record; the primary side is
  untouched).
- **Advisory dupes:** two advisory findings with the same conflict identity
  collapse to the first in deterministic order; the second drops as an
  advisory-duplicate (diagnostic). Primary findings are never involved.

**Outcome:** a conflicting advisory finding is suppressed (dropped +
diagnostic, never merged); the primary finding stays byte-identical (no
mutation, no re-rank, no annotation).

**Two invariants, tested separately:**

- **(I1) Primary preserved:** primary findings byte-identical before/after
  advisory merge, with or without conflicts.
- **(I2) Conflict suppresses advisory:** every advisory finding conflicting
  per §5.1 is dropped; suppression is total (no partial merge of a
  conflicting finding).

### Authority acceptance cases (10 — each a test in P6-04/P6-05/§6 matrix)

1. Primary pass input carries zero inferred items (payload pin with
   conventions enabled).
2. Primary prompt byte-identical with conventions on/off (template bytes,
   version, categories, hash, serialization, output contract).
3. Advisory pass receives bounded inferred context only (no explicit rules,
   budget cap pinned) under its own template/version/contract.
4. Advisory `convention`-category `low` finding with NO `ruleId` merges
   (happy path).
5. Advisory non-`convention` category rejected at the merge boundary (even at
   `low` severity).
6. Advisory above-`low` severity rejected at the merge boundary (even with
   `convention` category).
7. Advisory `ruleId` matrix at the orchestration boundary (before
   validation): missing ⇒ ok (case 4); `inf-*` ⇒ rejected; real rule id ⇒
   rejected (presence itself, since validation would accept it); fabricated
   id ⇒ rejected. Model-forged `origin.pass` overwritten by trusted code.
   No new Phase 5 codes.
8. Explicit-vs-advisory conflict (§5.1): same path + same fallback-resolved
   symbol + overlapping ranges ⇒ advisory suppressed, primary
   byte-identical; near-miss with no shared line ⇒ both kept; different
   symbols ⇒ both kept; rename oldPath spelling ⇒ same identity, advisory
   suppressed.
9. Multi-primary + advisory dupes: advisory conflicting with any of N
   primaries suppressed once; advisory-advisory dupes collapse to first;
   primary set byte-identical (I1 + I2 together).
10. Phase 5 validation + publisher behavior unchanged (validator/publisher
    diffs empty; no new codes, statuses, or artifact fields; advisory caps
    enforced before validation, never by new codes).

### 5.2 Isolated advisory validation policy (Blocker A)

**Root cause (verified in tree).** Under default config the advisory happy
path above cannot validate: `DEFAULT_SEVERITY_THRESHOLD = "medium"`
(`src/config/defaults.ts:12`, wired as the schema default at
`src/config/schema.ts:80`) with rank `low = 1 < medium = 2`
(`src/validate/policy.ts:42-48`). The `convention` category gate passes
unconditionally (`src/validate/policy.ts:126-129`, group `convention` at
`:16-27`), but the severity gate has no category exemption: with no
`groupOverride` for `convention`, the threshold resolves
`effective.severityThreshold ?? groupOverride ?? config.review.severity_threshold`
(`:177-179`) to the global `medium`, and a `convention`/`low` finding is
rejected (`severity_below_threshold`, `:180-186`). With no `ruleId` cited,
`effectiveSeverity = finding.severity` (`:141`, `:170-172`), so the
advisory contract (NO `ruleId` on advisory output, §0 item 2) leaves no
rule-severity rescue. Routing advisory findings through unmodified
`validatePolicy` under default config therefore rejects every advisory
`low`. This section is the plan fix; no validator or config change.

**Fix (plan-only, orchestration boundary + separate call, no new codes).**
Advisory findings NEVER enter the primary `validate()` array. Orchestration
makes TWO `validate()` calls on disjoint inputs with the same engine code:

1. **Primary call:** findings from the primary pass only, full user config
   (path-override → category-override → global precedence, unchanged).
2. **Advisory call:** findings that survived the §5 boundary gate only,
   under an isolated advisory policy pinned in orchestration/test code (NOT
   user config, NOT a validator flag, NOT a schema change):
   - Severity threshold fixed to `low` (named constant locked in P6-00,
     e.g. `ADVISORY_SEVERITY_THRESHOLD = "low"`). No inherited path
     thresholds: `path_overrides` severity entries and category severity
     overrides do NOT apply to the advisory call (advisory scope is global,
     never path-tuned).
   - Confidence threshold PRESERVED: the resolved effective confidence
     threshold for the finding's canonical path (path → global, same as
     primary) applies unchanged — advisory narrows authority scope, never
     weakens evidence strength.
   - Convention category gate KEPT: always passes, identical to primary.
   - Effective severity is ALWAYS `finding.severity`: no `ruleId` exists to
     override it (any present `ruleId` was already rejected pre-validation
     per the four-case matrix, §5 case 7).
3. **Explicitly forbidden:** minting a fake explicit rule to carry `low`
   severity; mutating the global default or schema; adding a `convention`
   slot to `category_overrides`; lowering user thresholds to admit
   advisories.
4. **`info` is below-threshold (ineligible), stated explicitly:** the
   advisory call accepts exactly severity `low`. An advisory `info` finding
   is below the advisory threshold and is rejected at the boundary (dropped
   + bounded count, never validated, never merged). `info` is not a quieter
   advisory — it is not advisory-eligible at all. Primary default `medium`
   already excludes both `low` and `info`; the advisory domain admits `low`
   only.

The validation engine, policy function, check codes, and config schema are
UNCHANGED: isolation comes from separate calls with separate inputs and a
pinned advisory threshold at orchestration, plus the pre-validation
boundary gates. P6-00 locks the constant name/value with tests; P6-05 pins
the two-call separation (feed an advisory `low` through the primary call
in a test and assert it still fails `severity_below_threshold` under
default config — the test that proves the separate call is load-bearing).

### 5.3 Two independent merge domains and execution order (Blocker B)

**Root cause (verified in tree).** `ValidationEngineImpl.validate` runs
per-finding stages into ONE `pending: PendingAccepted[]` array
(`src/validate/engine.ts:102-177`), then `resolveDuplicates` over it
(`:182`) and `selectWithinCap` over the survivors with
`config.review.max_findings` (`:201-204`). Dedupe is scoped to validated
candidates only (`src/validate/dedupe.ts:118-124`) and the cap to
post-dedupe winners (`:214-221`), with Phase 5 winner order (effective
severity, confidence, path, line, fingerprint, id; `:59-71`). The engine
takes ONE `findings[]` set (`:85-91`): any advisory item merged into that
array before `validate()` shares the pending set, the dedupe, and the
ranked cap — advisory `low`s lose the cap race by severity order AND the
cap is computed over the mixed set, so primary byte-identity (I1) cannot
hold. Two domains are therefore mandatory, not stylistic.

**Domains (no shared set, no shared dedupe, no shared cap):**

- **Primary domain:** primary-pass findings → `validate()` (user config) →
  `resolveDuplicates` (primary validated only) →
  `selectWithinCap(config.review.max_findings)` (Phase 5 order, unchanged).
  Advisory input NEVER enters this domain at any stage.
- **Advisory domain:** boundary-surviving advisories → separate `validate()`
  (isolated policy §5.2) → conflict suppression vs RETAINED primaries
  (§5.1 as canonicalized by §5.4) → advisory-internal
  `resolveDuplicates` (advisory validated only) → advisory-internal
  `selectWithinCap` with the named advisory cap below (same comparator,
  advisory-only ranking).

**Named advisory cap (P6-00 locks name + value with tests).**
`MAX_ADVISORY_FINDINGS_PER_RUN` (suggestion e.g. 5 — P6-00 justifies and
freezes). Rationale vs `MAX_CONVENTIONS_PER_RUN` (P6-00, e.g. 20): the two
caps bound DIFFERENT units at different stages. `MAX_CONVENTIONS_PER_RUN`
caps INPUT patterns admitted to the advisory prompt (prompt-bloat guard);
`MAX_ADVISORY_FINDINGS_PER_RUN` caps OUTPUT findings merged per run
(comment-noise guard). One convention can yield several findings, so the
pattern cap alone cannot bound merged output — the findings cap is
independently required. NO user config option: a named tested constant is
the default; a `.reviewer.yml` knob is added only if Phase 8 evaluation
proves a need (YAGNI — no speculative configurability). Advisory count-cap
overflow is recorded as a bounded orchestration merge diagnostic (counts
only), NEVER a new `VALIDATION_CHECK_CODE` (closed set, §5 kind 5).

**Normative execution order (1–9, no combined cap):**

1. Validate primary findings (one `validate()` call, user config).
2. Dedupe primary validated winners (`resolveDuplicates`, primary-only).
3. Cap primary (`selectWithinCap`, `config.review.max_findings`).
4. Boundary-gate advisory output (category / severity / `ruleId` presence /
   provenance stamping — §5 kinds 2–3; violators dropped pre-validation).
5. Validate surviving advisories (SEPARATE `validate()` call, §5.2 policy).
6. Conflict-suppress advisories vs retained primaries (head-coordinate
   contract §5.4; suppressed advisory dropped wholly + bounded diagnostic).
7. Dedupe surviving advisories advisory-internally (`resolveDuplicates`
   over advisory validated only; advisory-advisory identity per §5.1).
8. Cap advisories (`selectWithinCap` with
   `MAX_ADVISORY_FINDINGS_PER_RUN`, advisory-only winner order).
9. Append + aggregate: surviving advisories appended AFTER primaries in
   deterministic order; `run.json` aggregates per-domain counts; a combined
   `selectWithinCap` over concatenated primaries+advisories is FORBIDDEN
   (pinned by M2/M3 below).

### Merge-domain acceptance matrix (8 — each a test in P6-04/P6-05/§6)

- **M1** `max_findings = 1` with 1 accepted primary + N accepted advisories
  ⇒ primary kept; advisories appended up to the advisory cap (advisory
  count never evicts the primary).
- **M2** Full primary cap (e.g. 12 accepted primaries, `max_findings = 10`,
  plus advisories) ⇒ exactly the top-10 primaries kept, byte-identical
  with advisories absent (no combined-cap recomputation).
- **M3** Advisory over-cap (e.g. 8 validated surviving advisories, advisory
  cap 5) ⇒ top 5 in advisory winner order kept; rest dropped with a bounded
  merge diagnostic (counts only, no new check code).
- **M4** Duplicate primaries + duplicate advisories in one run ⇒ primary
  dedupe and advisory dedupe resolve independently (neither domain's
  duplicates consume the other's cap).
- **M5** Advisory-advisory dupes ⇒ collapse to first in deterministic order;
  primary set untouched.
- **M6** Conflicting advisory vs retained primary (§5.4) ⇒ advisory
  suppressed wholly, primary byte-identical (I1 + I2 together at domain
  scale).
- **M7** Reversed merge input order (advisories supplied before primaries to
  the merge function) ⇒ byte-identical output (domains computed separately;
  append order fixed primaries-then-advisories, never input order).
- **M8** Conventions on/off ⇒ primary validated/deduped/capped set
  byte-identical (extends §5 cases 1–2 from prompt bytes to validated
  output).

---

## 6. Test coverage and acceptance

| Area | Tests |
|---|---|
| Types/thresholds (P6-00) | shape (`ConventionEvidence` bounds/order/serialization), boundary constants, §1 contract pins |
| Detectors (P6-01) | positive/negative/mixed/empty per family, eligibility exclusion, determinism under permutation |
| Support (P6-02) | per-detector eligible denominator, ratio + count boundaries, zero-eligible safety, cap order stability |
| Cache (P6-03) | key stability/drift (content, detector, schema, sampling-policy), stale rebuild, failure matrix (never fails run), atomic write, path containment |
| Prompt (P6-04) | primary inference-free + byte-identical pin (template/version/categories/hash/serialization/contract), separate advisory template+version+hash+contract, advisory authority text (advisory template only), boundary caps (category/severity/ruleId-presence), provenance overwrite, budget truncation, no-llm/demo exclusion |
| Guards (P6-05) | advisory ruleId matrix (missing ok; inf-*/real/fabricated rejected pre-validation), convention gate unchanged, §5 authority cases 1–10 (§5.1 conflict identity, I1/I2), zero provider/GitHub calls, validator+publisher diff empty |
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
