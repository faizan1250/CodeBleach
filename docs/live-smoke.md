# Opt-in live seeded-bug smoke

`tests/live/review-live-smoke.test.ts` exercises the real prompt, the fixed
live provider (`OpenCodeProvider`), response parsing, and finding
normalization against two tiny synthetic fixtures: one obvious seeded defect
(`synthetic/withdraw.ts`, unguarded debit) and one clean control
(`synthetic/greet.ts`). Fixtures are purpose-written, contain no secrets or
repository source, and never touch the network except as the reviewed prompt.

## Invocation (manual only, never CI)

```bash
CODEBLEACH_LIVE_SMOKE=1 \
OPENCODE_API_KEY=<key> \
CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING=true \
bun test tests/live/review-live-smoke.test.ts
```

Plain `bun test` / `bun run check` / CI skips it (`describe.skipIf` on
`CODEBLEACH_LIVE_SMOKE`). With the gate on but the key or the exact
`...=true` opt-in missing, the first test fails pre-network — no provider is
constructed and no request is sent. Enabling the gate prints a Not-ZDR
warning: even synthetic prompts/completions may train future models.

## Contract

- Default output budget applies (32768 tokens; the test asserts a >= 4096
  floor so the 64-token incomplete probe from the P4-00 spike can never
  silently return). The engine's one bounded cap escalation still applies.
- `incomplete` is an explicit test failure, never a pass.
- Assertions are shape/completion-only: run status, unit counts, model id,
  prompt version, per-unit call lower bound, bounded secret-free
  diagnostics, and engine-owned finding fields. Finding prose and finding
  count are recorded, never asserted — this is a smoke test, not a
  precision/recall benchmark (that is Phase 8).
- The run logs one bounded JSON record (model, status, prompt version,
  fixture hash, date, outcome counts, finding file/line/category list,
  diagnostic codes, usage). No prompts, responses, or secrets are logged
  or persisted.
