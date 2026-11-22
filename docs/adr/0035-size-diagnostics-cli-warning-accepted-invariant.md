# ADR 0035: Size-diagnostic wording, CLI warning path, complete accepted-publisher invariant

Date: 2026-11-22

Status: Accepted (post-Phase-5 hardening; Phases 6, 7, 8 not started).

## Context

Audit cb-evidence-01 (§4, §5, §6) confirmed three defects with existing
fail-closed behavior intact:

1. Size conflation (`src/validate/snapshot.ts`): both typed blob-cap kinds
   (`per-file-limit`, `cumulative-limit`) mapped to the identical reason
   "snapshot blob exceeds the per-file snapshot cap", mislabeling the
   cumulative case. The typed `{kind, sizeBytes, limitBytes}` cause details
   existed at the `SnapshotReader` throw sites but were dropped by the
   adapter, which returned a status-only `size_limit` result.
2. CLI warning (`src/cli/commands/review.ts`): the `run.json`-unreadable
   warning told the reader to "see the run.json artifact path in the stage
   line above", but the stage line (`review ${status}: ...`) carries no path —
   and the only `run.json` pointer (the success-line `details in ...`) never
   prints in exactly the case the warning fires.
3. Publisher guard (`src/core/contracts.ts`): `isAcceptedFinding` checked only
   `status === "accepted"`, while `demoValidationEngine` emitted
   status-accepted findings with no `derivedTarget`/`derivedAttribution` —
   proving any non-engine producer could pass the guard incomplete.

## Decision

1. The adapter keeps the typed cap kind end to end. `SnapshotReadResult`
   `size_limit` gains `kind` (`per-file-limit` | `cumulative-limit`) plus
   optional `sizeBytes`/`limitBytes`, read from the structured failure cause
   only (the message is never parsed). Per-file reasons name the per-file
   byte cap; cumulative reasons name the total run cap; both include byte
   counts when the cause carries them. The local per-read byte cap and the
   run-total cap carry the same kinds. Fail-closed mapping is unchanged:
   `size_limit` still folds into `snapshot_size_limit` (still `inconclusive`,
   never accepted), untyped cap wording still propagates, and transport
   output-limit still propagates as a stage failure, never a content-size
   status.
2. The warning is now a function of the configured output directory and names
   the artifact path it tried (`<outDir>/run.json`). Static text plus path
   only — no contents, quotes, source, secrets, or stack; no validation
   counts claimed; exit unchanged; validation-did-run is not denied.
3. `AcceptedValidatedFinding` requires the complete invariant: status
   `accepted` plus a valid head-side `derivedTarget` plus a
   code-derived `introducedByPr: true` attribution with a defined valid
   `AttributionBasis`. `isAcceptedFinding` enforces all of it (target shape,
   basis shape, `introducedByPr === true`), not just the status. The pipeline
   keeps the runtime filter and fails closed (`INTERNAL`, nothing published,
   incomplete items excluded from the validation count) on any
   status-accepted item that fails the guard. `demoValidationEngine` and the
   shared test fixtures now emit complete accepted findings. No GitHub
   implementation (Phase 7 scope untouched), no semantic validation, order
   preserved, fingerprint handling untouched.

## Consequences

- Contract change (narrowing, fail-closed): producers of `ValidatedFinding`
   (custom engines, mocks, fixtures) must emit complete accepted items or the
   pipeline rejects the run; consumers only gain precision. `systemdesign.md`
   §4.4 and `docs/validation.md` record the invariant and the size-diagnostic
   wording.
- No new check codes: `snapshot_size_limit` is retained for both cap kinds,
   so the closed `ValidationCheckCode` set and the `run.json` v2 schema are
   untouched.
- Phases 6/7/8 scope untouched: publisher stays a stub, no new user-facing
   mechanism, no CLI flags.
