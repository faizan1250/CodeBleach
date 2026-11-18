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

## Docs

- Architecture: `systemdesign.md`
- Phase 1 plan: `implementation.md`
