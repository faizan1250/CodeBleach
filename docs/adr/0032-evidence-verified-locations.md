# ADR 0032: Evidence verified locations, attribution from actual lines

Date: 2026-11-22

Status: Accepted (post-Phase-5 hardening P2; Phases 6, 7, 8 not started).

## Context

`matchSide` (`src/validate/evidence.ts`) verified occurrence, not location:
exact-range first, then a bounded ±3-line `window.includes` fallback. The
fallback proved the quote existed *somewhere* in the window, and
`validateAttribution` then intersected the *model-cited* range with PR
added/deleted lines. A finding citing added lines 5-6 whose quote actually
lived at unchanged line 8 (inside the radius) verified and attributed as
introduced-by-PR — a structural false accept, confirmed by an engine-level
regression test (old code: `accepted`; new code: `inconclusive`).

## Decision

1. Each evidence item resolves to a `VerifiedEvidenceLocation` (side,
   canonical path, actual matched start/end lines). Exact cited-range first;
   the bounded ±3-line fallback searches only the documented window,
   identifies the actual range, and rejects multiples as ambiguous
   (`evidence_side_ambiguous`, inconclusive, never accepted). A
   minimum-discrimination rule keeps the shortest matching span and fails
   closed on ties; exact-range hits bypass it entirely.
2. Comparison stays `redactSource` + `normalizeQuoteForFingerprint`,
   case-sensitive, no fuzzy/Levenshtein/semantic matching, no model calls.
3. `validateAttribution` intersects verified locations only (never
   `startLine`/`endLine` from the finding). Replacement hunks keep the
   head/base distinction; identical matches on both sides stay
   `evidence_side_ambiguous`.
4. No new check code (ambiguity reuses `evidence_side_ambiguous`), no
   `run.json`/artifact change (`AttributionBasis` shape and
   `VALIDATION_CHECK_CODES` untouched), no `systemdesign.md` contract change
   beyond recording verified-location semantics.

## Consequences

- Nearby-unchanged quotes can no longer attribute through an overlapping
  cited range; multi-occurrence neighborhood quotes fail closed instead of
  attributing arbitrarily.
- `EvidenceSuccess.sides` is replaced by `locations`; the engine wires
  `locations` into attribution. Unit tests pin exact-range, moved-by-one,
  max-distance, outside-window, generic multi-occurrence, nearby-duplicate,
  critical off-range (evidence, attribution, and engine levels), both-sides,
  head-only, base-only, redacted-secret, and multi-evidence cases.
- Phase 6/7/8 scope is untouched: no semantic validation, no publisher, no
  cross-run behavior.
