# ADR 0013 — Context ranking, token budget, and partial-result contract (P3-10)

## Status

Accepted (P3-10 ranking/budget/partial). Pipeline wiring stays P3-11:
`ContextEngine.build` still returns `ReviewUnit[]` and the review stub stays
`NOT_IMPLEMENTED`.

## Context

P3-01–P3-09 produce ranked candidates (definitions, types, callees, callers,
tests) plus explicit rules and diff hunks for each changed symbol. Phase 4 has
no LLM provider yet, so Phase 3 must fit every unit into a deterministic,
conservative token cap that covers the full review payload, never silently
drops rules or diff content, and reports partial results with stable reasons.

## Decision

- Estimator (`src/utils/tokens.ts`): `ceil(utf8Bytes * 23 / 80)` per string
  (bytes/4 baseline plus 15% safety margin), `0` for empty text, always an
  integer. Stable for identical text, replaceable in Phase 4. It is an
  approximation, never claimed as exact model tokens.
- Weights (`src/context/rank.ts`): definition 100, type 85, callee 75,
  caller 65, test 55; rule/config/similar score 0 (rules live in
  `ReviewUnit.rules`, not in ranked context). Proximity: same-file 1.00,
  direct relative import 0.85, AST-confirmed cross-file caller 0.75,
  same-directory test heuristic 0.55, other 0.50. Reference-count decay
  `1 / (1 + 0.15 * (refs - 1))`. Sort: score desc, kind priority
  (definition > type > callee > caller > test > rule > config > similar),
  path lexicographically (code units, never locale), start line asc, id asc.
- Budget (`src/context/budget.ts`, hard cap always wins): mandatory payload
  is framing reserve (200 tokens, covers JSON keys, identity slack, and the
  truncation marker) plus all explicit rules in full, the symbol
  identity/signature, and the compact diff identity. If mandatory exceeds
  `max_tokens_per_unit`, skip the unit as `mandatory-budget-exceeded` and emit
  no partial rule set. Otherwise include complete hunks in original order
  while they fit, never splitting a hunk; trailing hunks omitted only with
  `truncated: true` and an omitted count. If no complete relevant hunk fits,
  skip as `diff-exceeds-budget`. Keep the declaration signature, truncate the
  definition body only at source-line boundaries (`definitionTruncated`).
  Add ranked candidates in score order while they fit; lower-ranked omitted
  first. The estimator rechecks after every inclusion; no emitted payload
  exceeds the cap.
- Config: `context.max_tokens_per_unit` (default 12000, bounds 1000–24000).
  Time-limit relation `parse <= total <= run` is unchanged.
- Additive types (`src/types/context.ts`, no `src/diff` touch, no contract
  rewiring yet): `ReviewUnitFile` (path/oldPath/status/language/
  commentableLines), `ReviewUnitDiff` (whole hunks plus
  original/included/omitted counts and truncation flag), `UnitSkipReason`
  (`mandatory-budget-exceeded`, `diff-exceeds-budget`, `run-deadline`,
  `parse-cancelled`, `parse-budget-exceeded`, `candidate-cap-exceeded`),
  `UnitSkip`, `ContextBuildDiagnostics` (elapsedMs, deadline/parse-budget
  flags, files considered/parsed/timed-out, units created/skipped, truncated
  diff/definition counts, cap-skipped candidates, query timeouts), and
  `ContextBuildResult` (`units`, `status: complete | partial`, `diagnostics`).
  P3-11 switches `ReviewUnit.file` to the projection, adds `ReviewUnit.diff`,
  changes `ContextEngine.build` to return `ContextBuildResult`, and persists
  it in the run artifact.

## Consequences

- No unit is emitted with a truncated rule, a partial hunk, or an
  over-budget estimate; over-budget units become explicit skips.
- P3-11 assembly consumes `rankContextItems`/`fitUnitToBudget` one unit per
  symbol and wires deadlines to `ContextBuildResult.partial` diagnostics.
- If weights, multipliers, the estimator, or the 200-token reserve change,
  update this ADR, `systemdesign.md`, and the rank/budget tests together.
