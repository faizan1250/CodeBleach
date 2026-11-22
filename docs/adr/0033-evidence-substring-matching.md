# ADR 0033: Evidence substring matching with verified locations

Date: 2026-11-22

Status: Accepted (post-Phase-5 P1; Phases 6, 7, 8 not started).

## Context

`matchSide` (`src/validate/evidence.ts`) verified whole-span equality only:
the exact cited range, else every contiguous sub-span in the ±3-line window
compared as a whole against the quote. A model citing a partial line (a
fragment starting/ending mid-line) or a slightly re-indented multiline span
failed even when the quoted text was literally present at the cited
location. ADR 0032 deliberately kept whole-span semantics with a
shortest-span discrimination rule for fallback matches.

## Decision

1. Keep exact cited-range match first (it still bypasses all ambiguity);
   replace the whole-span fallback enumeration with a literal-substring
   search of the normalized quote within the same bounded window
   (`max(1,citedStart-3)`..`min(lineCount,citedEnd+3)`), covering partial
   first/last lines and multiline spans with whitespace variation.
2. Comparison is unchanged: `redactSource` + `normalizeQuoteForFingerprint`,
   case-sensitive, per source line, joined with single spaces (mirrors the
   whole-text normalization). A per-line offset table maps every normalized
   character back to its source line, so each match reports actual snapshot
   coordinates. No fuzzy/Levenshtein/semantic/LLM matching.
3. Every distinct matched range counts: none is a mismatch, exactly one
   verifies at its actual lines, several are ambiguous
   (`evidence_side_ambiguous`, inconclusive, never accepted). The same exact
   range matching repeatedly collapses to one line-level location. An
   unmappable offset fails closed as ambiguous. Never store raw excerpts in
   diagnostics (details carry lines/thresholds only).
4. Replacement overlap, head/base distinction, both-identical inconclusive,
   unavailable-inconclusive, and verified-only attribution semantics are
   unchanged; attribution still intersects verified locations only. No new
   check code, no `run.json`/artifact change, no `systemdesign.md` contract
   change (its "appears verbatim ... at/near the cited range" wording
   already describes this).

## Consequences

- Partial-line and re-indented quotes now verify at their actual lines;
  prefix-collision substrings (e.g. `line-1` inside `line-10`) fail closed
  as ambiguous instead of attributing arbitrarily.
- The ADR 0032 shortest-span rule is removed: any multiplicity of distinct
  ranges is ambiguous, which is strictly fail-closed relative to picking one.
- Unit cover in `tests/unit/validate-evidence.test.ts` (substring,
  partway start/end/both, multiline whitespace, CRLF vs LF,
  case/punctuation/insertion failures, max-distance in/out, overlap
  dedupe, cross-line ambiguity, redacted-secret substring, ordered
  multi-evidence, replacement base-side) and
  `tests/unit/validate-engine.test.ts` (substring accept, mixed
  added/unchanged span attributes added overlap only, nearby-unchanged
  substring never attributes).
- Phase 6/7/8 scope is untouched: no semantic validation, no publisher, no
  cross-run behavior.
