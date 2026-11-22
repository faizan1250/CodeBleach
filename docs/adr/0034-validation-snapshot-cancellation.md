# ADR 0034: Validation snapshot cancellation via caller AbortSignal

Date: 2026-11-22

Status: Accepted (post-Phase-5 hardening; Phases 6, 7, 8 not started).

## Context

`ValidationSnapshotReadOptions.signal` existed on `readHead`/`readBase`/`readAt`
but had no caller: `validateEvidence`/`validateLocation` never accepted a
signal and never passed one, `ValidationSnapshotSource` had no signal
parameter, and `SnapshotReader.runGit` never forwarded a signal to
`runProcess`. The only abort coverage was the pre-spawn check inside
`GitValidationSnapshotReader.readAt`, so an abort arriving mid-read could not
reach the underlying Git subprocess — the process ran to completion while the
caller had already moved on. `runProcess` itself already kills (`SIGKILL`) and
reaps the child on abort with a typed `reason: "abort"` cause, and
`isGitAbort`/`"aborted"` classification already distinguished abort from
timeout/output-limit (ADR 0031); the missing piece was purely propagation.

## Decision

1. Thread one optional caller `AbortSignal` end to end: `PipelineInput.signal`
   → `ValidationEngine.validate(..., { signal })` →
   `EvidenceInput`/`LocationInput.signal` → `reader.readHead/readBase/readAt`
   → `ValidationSnapshotSource` methods → `SnapshotReader.runGit/runBatch` →
   `runProcess({ signal })`, which kills and reaps the in-flight child.
2. The SAME signal object propagates verbatim at every hop (asserted by
   identity tests); no layer wraps, replaces, or synthesizes a signal.
3. Abort is fail-closed: aborted reads surface as the typed `"aborted"`
   status, which location/evidence map to `inconclusive` (never accepted);
   `timeout`/`output-limit`/protocol/generic failures keep their existing
   outcomes and never classify as abort. `ValidationEngineImpl` still releases
   the reader in its `finally` (`reader.clear()`), including on cancel.
4. No new user-facing mechanism: the CLI wires no caller signal yet, so
   cancellation is available only to programmatic `runPipeline`/engine use.
   True mid-flight timing against local Git is nondeterministic (local Git is
   too fast to reliably preempt), so in-flight kill is proven at the
   `runProcess` layer plus deterministic deferred-source tests, not by racing
   real Git.

## Consequences

- Contract change (additive, backward compatible): optional `signal` on
  `PipelineInput`, `ValidationEngine.validate` options, `EvidenceInput`,
  `LocationInput`, `ValidationSnapshotSource` methods, and `SnapshotReader`
  read methods. Existing zero-arg callers and scripted sources still compile
  and pass. `systemdesign.md` §4.4 notes the new propagation.
- No new check codes: `"aborted"` folds into the existing
  `snapshot_unavailable`/`evidence_unavailable` inconclusive codes, so the
  closed `ValidationCheckCode` set and artifact schema are untouched.
- Phase 6/7/8 scope is untouched: no broad run cancellation, no CLI flag.
