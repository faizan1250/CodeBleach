# ADR 0023 — Opt-in live seeded-bug smoke

## Status

Accepted (P4 post-merge hardening). Supplements, does not reopen, ADR 0020.

## Context

ADR 0020 froze Phase 4 with the deterministic offline seeded-bug smoke
(`tests/integration/review-seeded-smoke.test.ts`, FakeProvider) as the
recorded quality signal, explicitly deferring any live seeded-bug smoke under
the Not-ZDR training terms. `implementation-phase4.md` §§16–17 nevertheless
specifies one opt-in live smoke (synthetic defect + control, key + exact
training opt-in, high output cap, manual-only, record metadata not prompts).
`systemdesign.md` §11 and `docs/opencode-spike.md` state no such test exists.

## Decision

- Add `tests/live/review-live-smoke.test.ts`, gated by
  `CODEBLEACH_LIVE_SMOKE=1` (`describe.skipIf`, so default `bun test`,
  `bun run check`, and CI skip it). No provider/network touch without
  `OPENCODE_API_KEY` plus exact `CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING=true`;
  missing credentials fail the first test pre-network.
- Two tiny synthetic fixtures (seeded unguarded-debit defect, clean
  control); never repository source, no secrets. Default 32768-token output
  budget with an asserted >= 4096 floor, so the 64-token incomplete probe
  cannot silently return; `incomplete` fails the test explicitly.
- Assert shape/completion only (status, counts, model id, prompt version,
  usage lower bound, bounded secret-free diagnostics, engine-owned finding
  fields). Finding prose/count is logged, never asserted.
- One bounded JSON record per run (model, status, prompt version, fixture
  hash, date, outcome, diagnostic codes, usage); no prompts, responses, or
  secrets. Manual invocation documented in `docs/live-smoke.md`.

## Consequences

- The ADR 0020 deferral is lifted for the smoke harness only; the freeze
  otherwise stands (no runtime contract changed — test + docs only).
- `systemdesign.md` §11 and the spike verification ledger now reference the
  harness instead of claiming none exists. The offline FakeProvider smoke
  remains the deterministic CI signal; a single live run proves the live
  path, not model bug-detection capability.
