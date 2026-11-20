# ADR 0020 — Phase 4 freeze: full pass, deterministic smoke, docs, x-plat

## Status

Accepted (P4-10). Closes Phase 4 per `implementation-phase4.md` §18 P4-10.

## Context

P4-00–P4-09 landed the fixed OpenCode Go + Muse Spark 1.3 Contributor
integration (endpoint pinned in `src/llm/constants.ts`), `OpenCodeProvider`,
versioned `code-review-v1` prompt, per-unit engine, Zod + one-repair +
bounded incomplete retry, code-owned normalization, `ReviewBuildResult`,
deadlines/cancel, and CLI/pipeline wiring with `--no-llm`. Validation stays
`NOT_IMPLEMENTED`. Remaining P4-10 work: full test pass, seeded-bug smoke,
docs sync, cross-platform green. No new features.

## Decision

- Deterministic seeded-bug smoke only:
  `tests/integration/review-seeded-smoke.test.ts` (FakeProvider, no network,
  no key, no opt-in needed). One synthetic unit with an obvious seeded defect
  (unguarded `account.balance -= amount`) yields exactly one `bug` finding at
  the seeded line with verbatim evidence; a clean control unit yields none;
  fingerprint is stable across runs while run-scoped id differs. No live
  seeded-bug smoke was run in Phase 4: even synthetic prompts/completions may
  train future models under the Not-ZDR terms, so the mock smoke is the
  recorded quality signal. The only live harness remains the P4-00 generic
  smoke (`scripts/opencode-spike.ts`, harmless prompt, opt-in gated).
- `bun run check` green (typecheck + full suite), `config validate` exit 0,
  `review --demo --dry-run` exit 0 and network-free. No provider secrets in
  logs/artifacts; raw prompts/responses never persisted.
- Docs: `systemdesign.md` §§9/10/13 synced to the as-built contracts;
  `README.md` notes the offline smoke; `docs/opencode-spike.md` carries a
  P4-10 close-out addendum (P4-00 record untouched).
- Cross-platform: CI matrix (`ubuntu/macos/windows-latest`, `ci.yml`) is the
  x-plat gate; the new smoke test uses only in-memory units and `node:` APIs
  safe on all three (no shell, no hardcoded separators, no tmp dirs).

## Consequences

- Phase 4 contracts are frozen. Any change now needs a new ADR.
- Phase 5 starts from: real `ReviewBuildResult` in `run.json`, validation
  stub `NOT_IMPLEMENTED`, demo untouched, `--no-llm` preview intact.

## Addendum (P4 hardening — history above unchanged)

The Decision section's "No live seeded-bug smoke was run in Phase 4" deferral
is lifted for the smoke harness only by ADR 0023 (opt-in live harness
`tests/live/review-live-smoke.test.ts`, `CODEBLEACH_LIVE_SMOKE=1`,
manual-only under Not-ZDR terms). Freeze otherwise stands.
