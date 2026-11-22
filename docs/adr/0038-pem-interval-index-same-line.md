# ADR 0038: Occurrence-ordered PEM interval index for secret-fragment rejection

Date: 2026-11-22

Status: Accepted (post-Phase-5 hardening; Phases 6, 7, 8 not started).
Supersedes the ADR 0037 guard mechanism (bounded probe); extends ADRs 0033
§D2 and 0036. ADR 0037 is left untouched — history is not rewritten.

## Context

1. Original vulnerability (see ADR 0037 for the full account): the PEM
   pattern (`src/utils/redact.ts`) requires BEGIN..END in a single
   `redact()` input, so a model citing only a payload line redacts to
   itself on both sides of the exact-path comparison while the same
   payload in full source would be consumed to `[REDACTED]` — the
   fragment verifies. The ±3-line fallback window (ADR 0036) has the
   same shape for blocks larger than the window.
2. ADR 0037 prescribed `isSecretFragment(lines, startLine, endLine)` with
   a bounded ±20-line outward probe (`SECRET_DELIMITER_SCAN_RADIUS`).
   That design is stale: the tree implements a complete per-snapshot PEM
   interval index instead (`buildPemIntervals` + `isSecretSpan` +
   `closed` flag + `coverEnd` orphan cursor + EOF extension in
   `src/validate/evidence.ts:15-76`). No `isSecretFragment` and no
   `SECRET_DELIMITER_SCAN_RADIUS` exist anywhere in `src/` (verified by
   search, not inference).
3. Multi-block pairing bug in the first index version (confirmed): the
   builder used per-line booleans (`hasBegin`/`hasEnd` via single
   `RegExp.test`), so one line holding `BEGIN..END..BEGIN` collapsed to a
   single `closed:true` interval and the trailing `BEGIN` was dropped —
   a later tail-payload quote saw no covering interval and verified.
   One line holding two complete blocks likewise collapsed to one
   interval (benign for secrecy, wrong coordinates), as did multiple
   `BEGIN`s before one `END`.

## Decision

1. Per-snapshot PEM interval index, built once per `(side, path)` in
   `createSideLoader` (`src/validate/evidence.ts:440-460`) and stored on
   `LoadedSide`. `matchSide` (`:530-556`) checks `isSecretSpan` on both
   the exact-path equality and the fallback `locateSubstring` match; a
   suspect span returns `mismatch` (`evidence_quote_not_found`) directly.
2. Occurrence-ordered scan: every BEGIN/END occurrence on a line is
   collected via `matchAll` on the shared `/g` regexes (cloned per call,
   so no `lastIndex` leakage) and processed in character order against
   the existing cross-line `open` stack plus `coverEnd` orphan cursor.
   `isSecretSpan`, cache wiring, side resolution, and SHA/cancel/
   provenance/failure semantics are untouched.
3. Pairing table (1-based lines, deterministic order):
   - Sequential completes (`BEGIN..END..BEGIN..END`, any line layout)
     → one `closed:true` interval each; a span covering every overlapped
     closed interval verifies, anything partial rejects.
   - Trailing `BEGIN` (`BEGIN..END..BEGIN` + payload, same line or
     later) → stays on `open` → fail-closed interval to EOF; any
     overlapping payload span rejects.
   - `END..BEGIN` on one line → orphan interval (`coverEnd+1..line`,
     `closed:false`) plus an open remainder; overlapping spans reject.
   - Multiple `BEGIN`s before one `END` → one closed interval plus an
     open remainder; the intermediate payload rejects.
   - Orphan `END` with empty `open` → `coverEnd+1..line`,
     `closed:false` (conservative); a second orphan `END` on the same
     line clamps to the valid range `[line,line]` instead of inverting
     it. Unterminated `open` at EOF extends to `lines.length`,
     `closed:false`.
4. Failure semantics: suspect evidence resolves to `mismatch`
   (`evidence_quote_not_found`) or the preserved `ambiguous`
   (`evidence_side_ambiguous`, inconclusive) — never accepted, never a
   silent skip. No new check codes, no `run.json`/artifact change.
5. Cost: one O(lines + occurrences) scan per cached snapshot; every span
   check after is a cheap overlap test. No new snapshot/Git/network
   reads, no per-finding full-file scans.
6. Redact compatibility (`src/utils/redact.ts` untouched): the redaction
   regex is BEGIN-to-first-END with independent labels, and the interval
   builder is label-independent too — sequential same-line completes
   verify in both views. Where the views diverge
   (multi-BEGIN-before-END, `END..BEGIN`), the interval view fails
   closed: security over permissiveness. A same-line `BEGIN RSA..END EC`
   pair matches in both views — intended parity, labels are never
   required.
7. Regression coverage: `tests/unit/validate-pem-interval.test.ts`
   (`multi-block`, `boundaries`, `controls`, `engine` suites) plus the
   red-first `same-line` suite (7 tests: complete+trailing-BEGIN,
   trailing-BEGIN across an ordinary line, END-then-BEGIN, BEGIN-END-
   BEGIN trailing payload, two-completes-verify, multi-BEGIN-one-END,
   CRLF trailing-BEGIN) and the `same-line engine` suite (never
   accepted/publishable, no payload in details). The `validate-engine`
   secret-fragment case and the `validation-phase5-matrix` integration
   are the wider regression surface.

## Consequences

- Acceptance only shrinks: matches become `mismatch`/`ambiguous`, and
  verified-only attribution inherits the narrowing. Deterministic-only —
  no semantic or LLM validation, no publisher change.
- Roadmap: this is Phase 5 hardening. Phase 6 (inferred conventions) is
  unstarted — no `src/conventions/`, no plan-code changes in this
  ticket; the Phase 6 plan corrections are separate tickets.
- Honest remaining limits:
  1. PEM-delimiter-specific; other `TOKEN_PATTERNS` (API keys, JWTs,
     connection strings) rely on the full-window redaction gate only —
     no interval index.
  2. BEGIN/END labels are never matched (parity with `redact.ts`, by
     design); a mismatched-label block counts as one block in both
     views.
  3. A secret block larger than the ±3 fallback window still shows raw
     fragments inside the window (ADR 0036 limitation, unchanged).
  4. Same-line `END..BEGIN` line-level verify was lost versus the old
     boolean code — intended narrowing, documented in §D3.
  5. Multi-BEGIN-before-END rejects the intermediate payload even
     though the redaction regex would consume BEGIN-to-first-END —
     deliberate fail-closed divergence between the two views.
  6. No dedicated check code: interval rejections surface as generic
     `evidence_quote_not_found` / `evidence_side_ambiguous`, so
     diagnostics cannot distinguish them from other mismatches.
  7. The index cache lives on the per-run side loader; it is rebuilt
     per validation invocation, never shared across runs.
  8. CRLF handling rests on `split("\n")` plus unanchored regexes (the
     trailing `\r` never blocks a match) — covered by test but still an
     implicit assumption, not a normalized line model.
  9. Evidence bounds (8 items, 2000 chars/quote, 50 cited lines) are
     unchanged; oversized claims fail instead of being truncated.
  10. Deterministic ≠ semantic: a structurally valid, evidence-grounded
     finding may still assert a wrong bug claim (`docs/validation.md`
     limitation on record).
