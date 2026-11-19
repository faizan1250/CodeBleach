# CodeBleach

Personal single-user AI PR reviewer. CLI-first; the GitHub Action is a thin wrapper.

## Prerequisites

- [Bun](https://bun.sh) pinned in `.bun-version` (1.3.13)

## Install

```bash
bun install --frozen-lockfile
```

## Check

```bash
bun run check   # typecheck + tests
```

## Demo (offline, no network or secrets)

```bash
bun run src/cli/index.ts review --demo --dry-run
```

Writes a synthetic run artifact to `.reviewer-out/run.json`.

## Diff (diagnostic, offline, no network or secrets)

```bash
bun run src/cli/index.ts diff --base <rev> --head <rev> [--repo .]
```

Prints the pretty `DiffResult` JSON to stdout; logs stay on stderr.
`<rev>` accepts full SHAs, symbolic refs (`HEAD`, branches), and unique
abbrevs; the CLI resolves each to a full commit SHA via
`git rev-parse --verify --end-of-options <rev>^{commit}` before the engine
(the engine stays full-SHA-only). Dash-prefixed input is rejected as
`INVALID_INPUT`; missing objects are `GIT_FAILED` with a fetch hint.
Exit codes: `0` ok, `1` Git/parse failure, `2` config/usage error.

## Docs

- Architecture: `systemdesign.md`
- Phase 1 plan: `implementation.md`
