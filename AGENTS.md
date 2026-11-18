# AGENTS.md — CodeBleach contributor rules

Read `systemdesign.md` before changing code; do tickets P1-01→P1-08 in order.

## Commands

- `bun install --frozen-lockfile` — install from lockfile
- `bun run check` — typecheck + tests (must pass before every commit)
- `bun run src/cli/index.ts review --demo --dry-run` — offline demo walkthrough

## Ownership & direction

- `src/types` holds pure data only, imports nothing from `src/`.
- Stage interfaces live in `src/core/contracts.ts`; only `core/pipeline` + `cli` wire engines.
- Only `src/github/` may import Octokit. No circular imports.

## Rules

- Zod only at trust boundaries (config file, LLM output); no redundant schemas.
- Never log secrets; keep logs on stderr, results on stdout.
- Never execute reviewed-repo code, tests, or builds.
- No real Git/GitHub/OpenCode integration before its phase.
- Contract or decision change ⇒ update `systemdesign.md` + add `docs/adr/` note.
- Tests make no network calls and need no secrets; keep diffs minimal.
