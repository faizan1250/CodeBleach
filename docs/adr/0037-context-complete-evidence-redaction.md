# ADR 0037: Complete-block evidence redaction via bounded secret-delimiter guard

Date: 2026-11-22

Status: Accepted (post-Phase-5 hardening; Phases 6, 7, 8 not started). Extends ADRs 0033 and 0036.

## Context

Two gaps in secret-fragment rejection, both rooted in the PEM pattern
(`src/utils/redact.ts`) requiring BEGIN..END in a single `redact()` input:

1. Exact-path bypass (confirmed): `matchSide` (`src/validate/evidence.ts`)
   tries the exact cited range first, comparing
   `normalizeQuoteForFingerprint(redactSource(...))` on both sides. A model
   citing only a payload line redacts to itself on both sides (no delimiters
   in the slice, so the pattern cannot fire) while the same payload in full
   source would be consumed to `[REDACTED]`. Equality holds and the fragment
   verifies.
2. Window-boundary gap (confirmed): the ±3-line fallback window
   (`EVIDENCE_SEARCH_RADIUS`) is redacted as one string per ADR 0036, but a
   block larger than the window excludes a delimiter, the pattern cannot
   fire, and the raw fragment verifies via the literal-substring gate.
   ADR 0036 recorded this limitation explicitly.

## Decision

1. `isSecretFragment(lines, startLine, endLine)` fail-closed guard wired
   into `matchSide` on both paths, reusing the already-cached `lines`
   array: exact equality holds but the cited span is a fragment → return
   `mismatch` directly (no fallback to another location); fallback
   `locateSubstring` matches but the matched span is a fragment → return
   `mismatch`. Both surface as `evidence_quote_not_found`.
2. Guard logic: in-range scan first — both delimiters present is a full
   block, allowed; a lone delimiter in range is a fragment, rejected.
   Otherwise a bounded outward probe (±20 lines,
   `SECRET_DELIMITER_SCAN_RADIUS`): upward, first delimiter END means a
   closed block above (allow), BEGIN means inside one (reject); downward
   mirrored. Either direction rejects (OR), so blocks with only one
   delimiter in bound are still caught.
3. Bounds and behavior preserved: the probe is in-memory over cached lines
   only — no new snapshot/Git reads, `AbortSignal`/cache/SHA-pinning
   untouched, +O(scan) regex cost. Exact-first, case-sensitivity,
   whitespace norm, minimal-span ambiguity, head/base distinction, and
   replacement-overlap disambiguation are unchanged; no new check codes.
   Full-block quotes (want contains `[REDACTED]`) still verify because
   their span holds both delimiters.
4. Failure semantics: suspect evidence resolves to `mismatch`
   (`evidence_quote_not_found`) or the preserved `ambiguous`
   (`evidence_side_ambiguous`, inconclusive) — never accepted, never a
   silent skip. `src/utils/redact.ts` is untouched.

## Consequences

- Acceptance only shrinks: matches become `mismatch`/`ambiguous`, and
  verified-only attribution inherits the narrowing. Deterministic-only —
  no semantic or LLM validation, no publisher change.
- Cover: red-first boundary tests plus one engine large-block case; the
  fix turns all 12 red failures green with no regressions, typecheck
  clean.
- Limitation: a block larger than the probe on both sides (neither
  delimiter within 20 lines) still misses — fail-open, same class as
  pre-fix; a larger bound or full-file scan was rejected per the
  bounded-context constraint. The guard is PEM-delimiter-specific; other
  redact patterns rely on the existing full-window redaction.
- Truncated-EOF blocks (BEGIN above, no END anywhere) reject via the
  upward probe — fail-closed by design, statically indistinguishable
  from fixture truncation.
- Phases 6/7/8 scope untouched.
