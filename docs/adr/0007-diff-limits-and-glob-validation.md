# ADR 0007 — Additive `review.max_file_size_kb` and validated glob grammar

## Status

Accepted as design (Phase 2 preflight); implemented in P2-06.

## Context

Phase 1 caps changed lines (`review.max_changed_lines_per_file`, default
1500) but has no byte-size limit, so one huge generated file can dominate an
artifact. Separately, `ignore.paths` / `rules[].paths` /
`path_overrides[].paths` accept any non-empty string
(`src/config/schema.ts`); malformed globs therefore fail silently at match
time instead of at config load.

## Decision

- Add optional `review.max_file_size_kb` (default 500 KB) to the v1 schema,
  defaults, and `.reviewer.yml.example`. Additive: existing configs parse
  unchanged. The engine measures the head-commit blob
  (`git cat-file -s <headSha>:<path>`), never the working tree; a blob over
  `max_file_size_kb * 1024` skips with `"too-large"`. Exactly at the limit
  is accepted.
- Support one documented glob subset in `src/utils/glob.ts`, independent of
  `config` (no import cycle): `*` (one segment), `**` (whole segments only),
  `**/` (zero or more leading directories), `?` (one char), `/` separators.
  Reject empty patterns, NUL, backslashes, absolute patterns, `.`/`..`
  segments, repeated empty segments, malformed `***`, embedded `**`, and
  brace/char-class/extglob/negation syntax — never interpret them as
  literals.
- Wire validation into the Zod schema via a refinement calling the pure
  `isValidGlobPattern`; invalid patterns fail `config validate`
  (`CONFIG_INVALID`, exit 2) with a path-specific message. Apply to every
  configured glob field the checked-in schema exposes.
- `systemdesign.md` §6 records the setting; P2-06 implements schema,
  defaults, example, matcher, and tests together.

## Consequences

- Byte-size and changed-line caps share `"too-large"` under the fixed filter
  precedence; no new `DiffSkipReason` is needed.
- Previously accepted malformed globs become config errors by intent; the
  error message names the offending pattern.
