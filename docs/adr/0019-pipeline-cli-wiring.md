# ADR 0019 — Pipeline/CLI wiring, per-call headSha, and --no-llm

## Status

Accepted (P4-09). Implements the P4-09 slice of `implementation-phase4.md` §13.

## Context

P4-02–P4-08 built a tested `ReviewEngineImpl` + `OpenCodeProvider`, but
`src/cli/commands/review.ts` still wired the Phase 1 `stubReviewEngine`, so no
real review could run and the engine's constructor `headSha` stayed `""`.
The CLI also had no offline preview: `--dry-run` alone still sends repository
code to Muse Spark 1.3 Contributor. Per-unit attribution needs the exact
resolved head SHA, which the CLI cannot know up front (callers may pass
symbolic refs; only the diff stage resolves them).

## Decision

- Composition root is `runReview` (`src/cli/commands/review.ts`): demo keeps
  canned engines (demo wins even with `--no-llm`); `--no-llm` wires real
  diff/context engines with a skipped-review engine and never constructs
  `OpenCodeProvider`; live mode constructs `OpenCodeProvider` +
  `ReviewEngineImpl` via `createRealReviewEngine` and keeps
  `stubValidationEngine` (Phase 5 stays `NOT_IMPLEMENTED`).
- One config load: live mode loads `.reviewer.yml` once for provider bounds
  (`llm.max_retries`, `llm.request_timeout_ms`) and injects the loaded value
  into the pipeline, so CLI and stages cannot disagree. Config-invalid still
  exits 2 with no artifact (it fails before the pipeline starts).
- One opaque session per run: `ses_` + runId without dashes, reused across
  every per-unit request and retry; version comes from `readVersion()` for
  `User-Agent: codebleach/<version>`. Same runId/logger flow into the
  pipeline; no new run id is minted.
- `ReviewEngine.review()` options gain additive `headSha`
  (`src/core/contracts.ts` + `ReviewCallOptions`); the pipeline passes
  `diff.headSha`, which overrides the constructor fallback. No other contract
  changes; no `PipelineInput` flag was needed.
- A `skipped` review result drives the rest of the pipeline generically:
  review stage recorded `skipped` / `no_llm_flag`, then validation and
  (non-dry-run) publish recorded `skipped` / `review_skipped_no_llm` without
  invoking those engines. `run.json` retains context, units, and the skipped
  review; exit is 0 with an explicit offline-preview line on stdout.
- Live mode logs one preflight warning naming the fixed model, its
  non-ZDR/training terms, and the exact `CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING`
  opt-in variable. CLI help and README state that `--dry-run` alone is
  model-connected and `--no-llm` is the network-free preview.

## Consequences

- `run.json` from a real review reaches validation as `NOT_IMPLEMENTED`
  with findings retained; P4-09 tests pin this with `FakeProvider`.
- Zero-unit reviews stay gate-free (P4-04 contract kept); any unit-bearing
  review fails `CONFIG_INVALID` before network access without the key or
  opt-in.
- `systemdesign.md` §§4.3/5/7 now describe the real wiring; P4-10 owns docs
  freeze, the seeded-bug smoke, and cross-platform verification.
