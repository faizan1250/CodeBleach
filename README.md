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
bun run check         # typecheck + tests
bun run lint          # Biome lint (errors fail, warnings informational)
bun run format:check  # Biome format check (non-mutating; CI runs this)
bun run format        # Biome format write (run before commit if format:check fails)
```

Formatter notes: line width 120, double quotes, LF line endings (matches
`.gitattributes` `eol=lf` and Biome `lineEnding: lf`; do not commit CRLF). The Biome version is
pinned in `package.json`; run `bun install --frozen-lockfile` after pulling.

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
workspace training-data toggle). Findings are deterministically validated
(diff/path/location/evidence/provenance/policy — no model calls, see
`docs/validation.md`): a live `--dry-run` completes with
accepted/rejected/inconclusive counts (details in `.reviewer-out/run.json`)
and skips publishing. Without `--dry-run` a live run validates, then
publishes accepted findings as inline PR comments pinned to the current
head SHA (see `docs/validation.md` Modes and ADR 0045). Live publish
requires `GITHUB_TOKEN` plus `GITHUB_REPOSITORY`,
`CODEBLEACH_PR_NUMBER`, `CODEBLEACH_BASE_SHA`, and
`CODEBLEACH_HEAD_SHA`; a stale head posts zero comments. The GitHub
workflow (`.github/workflows/review.yml`) runs this on same-repository,
non-Dependabot PRs only — fork and Dependabot PRs are skipped — and
appends a redacted result to the job summary. `--no-llm` remains the
network-free preview: `review --dry-run --no-llm`
records review/validation as skipped and exits 0. Validation verifies
provenance and support; it does not prove a finding is semantically correct.

Experimental: `review --base <sha> --head <sha> --convention-advisory`
(default off) adds a bounded inferred-convention advisory pass (separate
model requests over repository code; see `implementation-phase6.md`).
Demo and `--no-llm` runs ignore the flag. The labeled usefulness gate has
not passed yet, so routine use is not recommended. Advisory generation
never implies publication: advisories are withheld from the publisher by
default (count-only diagnostic); publication needs a separate explicit
pipeline opt-in that the workflow never sets.

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

## Quality smoke (deterministic, offline)

```bash
bun test tests/integration/review-seeded-smoke.test.ts
```

A synthetic seeded defect plus a clean control run through the real prompt,
provider parsing, and normalization with a scripted provider: no network, no
key, no training opt-in needed. An opt-in live counterpart
(`tests/live/review-live-smoke.test.ts`, `CODEBLEACH_LIVE_SMOKE=1`,
manual-only, Not-ZDR) runs the same shape against the live model; see
`docs/live-smoke.md`. Neither smoke is a precision/recall benchmark.

## Docs

- Architecture: `systemdesign.md`
- Phase 1 plan: `implementation.md`
- Phase 4 plan: `implementation-phase4.md`
- Phase 5 plan: `implementation-phase5.md`
- Phase 6 plan + as-built record: `implementation-phase6.md`
- Phase 7 plan: `implementation-phase7.md`
- Validation (deterministic checks, codes, `run.json` v2): `docs/validation.md`
- Disposable-PR live smoke procedure (manual-only): `docs/disposable-pr-smoke.md`
- Decisions: `docs/adr/` (Phase 4 freeze: `0020-phase4-freeze.md`; Phase 5 deterministic-only: `0028-phase5-deterministic-validation.md`, `0029-phase5-result-contract.md`, `0030-phase5-cli-docs-hardening.md`; Phase 7 publisher: `0045-phase7-github-publisher.md`)

## License

MIT — see [LICENSE](LICENSE).
