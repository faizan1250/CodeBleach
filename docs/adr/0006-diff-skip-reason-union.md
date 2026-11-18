# ADR 0006 — `ChangedFile.skipReason` is a closed `DiffSkipReason` union

## Status

Accepted (Phase 2 preflight; implemented in P2-01).

## Context

`ChangedFile.skipReason` was `string | undefined`
(`src/types/diff.ts`), while `systemdesign.md` §5 and the Phase 2 contract
already listed six exact values. A plain string lets any engine invent
reasons ad hoc, so skip accounting across diff, artifact, and publisher
could silently diverge with no compiler complaint.

## Decision

- Add and export `DiffSkipReason = "binary" | "generated" | "too-large" |
  "ignored" | "deleted" | "lockfile"` in `src/types/diff.ts`; change
  `skipReason?: DiffSkipReason | undefined`.
- `src/types/index.ts` re-exports it via the existing `export *` barrel; no
  duplicate public definition is introduced.
- Deterministic filter precedence (`deleted > binary > lockfile > ignored >
  too-large > generated`) is owned by the Phase 2 filter stage and asserted
  there, not in the type.
- `systemdesign.md` §5 now references the named union; the contract change
  ships with `tests/unit/diff-skip-reason.test.ts`, which pins the six
  members and rejects arbitrary strings at type level.

## Consequences

- New skip reasons are a contract change: type, tests, `systemdesign.md`,
  and a new ADR move together. The engine cannot widen the set unilaterally.
- Existing consumers pass unchanged; narrowing only rejects values that
  were never valid.
