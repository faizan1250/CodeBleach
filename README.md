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

## Review

```bash
# Live review (sends repo code to Muse Spark 1.3 Contributor)
OPENCODE_API_KEY=... CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING=true \
  bun run src/cli/index.ts review --base <sha> --head <sha> --dry-run

# Offline preview: diff + context only, no model calls, no key needed
bun run src/cli/index.ts review --base <sha> --head <sha> --dry-run --no-llm
```

Muse Spark 1.3 Contributor is not zero-data-retention: prompts/completions
may train future models. Live review requires `OPENCODE_API_KEY` plus the
explicit `CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING=true` opt-in (and the
workspace training-data toggle). `--dry-run` alone still calls the model;
add `--no-llm` for a network-free preview that records review/validation as
skipped and exits 0. Findings are validated in Phase 5; until then a live
run ends at the validation stub with review results retained in
`.reviewer-out/run.json`.

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
