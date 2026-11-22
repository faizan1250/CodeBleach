# ADR 0036: Full-window redaction for evidence substring fallback

Date: 2026-11-22

Status: Accepted (post-Phase-5 P1; Phases 6, 7, 8 not started). Supersedes ADR 0033 §D2 (per-line fallback redaction).

## Context

ADR 0033 §D2 redacted the fallback window per line, claiming it mirrors
whole-text normalization. True for whitespace/case, false for cross-line
secret patterns: the multiline PEM pattern (`[\s\S]*?` spanning BEGIN..END)
and multiline quoted assignment values only match when both delimiters are
visible in one `redact()` call (`src/utils/redact.ts`). Per-line, neither
fragment matches, so raw secret fragments stayed in the fallback haystack
while the exact path and the quote form both use full-source `redactSource`
(`src/validate/evidence.ts`). A legitimate cross-line-secret quote that
missed exact (e.g. re-indented PEM) false-rejected in fallback, while a raw
payload-fragment quote could verify against the visible fragment line.

## Decision

1. Redact the bounded window as one source string
   (`redactSource(windowText, path)` + quote normalization), identical to
   the exact path. The gate is a literal-substring search of the normalized
   quote in that full-window redaction.
2. Coordinates come from minimal source spans, not char offsets (redaction
   changes lengths, so offsets are untrustworthy): enumerate contiguous
   spans by increasing length; a span matches when its own redaction
   contains the quote; a span containing an already-minimal proper subspan
   is skipped. Zero minima is defensive-ambiguous (unreachable: the whole
   window always explains a gated match), one verifies at its actual lines,
   several are ambiguous (`evidence_side_ambiguous`, inconclusive).
3. Unchanged: exact-range first, case-sensitive, whitespace norm, ±3 bound
   (`EVIDENCE_SEARCH_RADIUS`), head/base distinction, replacement-overlap
   disambiguation, verified-only attribution, no new check codes, no
   `run.json`/artifact change. No raw excerpts in diagnostics.

## Consequences

- Cross-line-secret quotes verify at actual lines (availability fix);
  payload-fragment and header-only quotes mismatch (fail-closed: verified
  quotes flow toward publication, raw fragments must never verify).
- Matches cost O(window²) bounded redacts (window ≤ cited span + 6, cited
  span ≤ 50 lines); snapshot reads stay cached and single (P2 cost test
  unaffected).
- Unit cover in `tests/unit/validate-evidence.test.ts` (reindented PEM
  block, fragment/header rejection, partial outside block, adjacent
  multiline, CRLF, repeated-block ambiguity) and
  `tests/unit/validate-engine.test.ts` (secret fragment never accepted).
- Phase 6/7/8 scope untouched. Limitation: a secret block larger than the
  ±3 window still shows raw fragments inside the window (bounded, never
  full-file reads).
