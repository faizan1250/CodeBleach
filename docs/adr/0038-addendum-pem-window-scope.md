# ADR 0038 addendum — PEM window-scope clarification (NOTE, not a new ADR)

Date: 2026-11-22

Status: Informational note. Not a new ADR, not a contract change.
ADR 0038 is untouched; ADR numbering is unchanged (0028–0039 stand).
No `src/` behavior changes; no new check codes, statuses, or artifact fields.

## Correction

ADR 0038 Consequences item 3 ("a secret block larger than the ±3 fallback
window still shows raw fragments inside the window") is scope-inaccurate as
worded for PEM. The PEM interval index is a full-snapshot structure,
independent of the ±3 window:

- `buildPemIntervals` scans all cached snapshot lines once per `(side, path)`
  (`src/validate/evidence.ts:36-65`); one combined `matchAll` over
  `PEM_DELIMITER_RE` yields BEGIN/END occurrences in source order, so no
  per-line sort is needed (commit `e75df21`).
- `matchSide` (`:531-557`) applies `isSecretSpan` (`:70-77`) to both the
  exact cited-range match and the bounded fallback match. A PEM block larger
  than the window is still rejected via the index whenever the matched span
  is a fragment of a covered interval.
- The "larger than the window shows raw fragments" limitation (ADR 0036,
  unchanged) therefore applies only to non-PEM `TOKEN_PATTERNS` (API keys,
  JWTs, connection strings), which rely on the full-window redaction gate
  alone and have no interval index (ADR 0038 Consequences item 1, unchanged).

No universal-detection claim: layered redaction is not exhaustive by design
(`src/utils/redact.ts` assignment-pass limits comment).
