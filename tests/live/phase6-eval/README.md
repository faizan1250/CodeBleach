# Phase 6 live usefulness evaluation (P6-05, plan §15/§16.5)

Manual-only measurement harness. It never runs under `bun run check` or CI:
`phase6-eval.test.ts` is gated by `CODEBLEACH_PHASE6_EVAL=1` (plus provider
credentials), and `gate.ts` / `curate-corpus.ts` are plain scripts, not tests.

Until this gate passes, `--convention-advisory` stays a development/experiment
flag. A failing gate never weakens thresholds; routine use is not recommended.

## 1. Prerequisites

- Provider credentials: `OPENCODE_API_KEY` and
  `CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING=true` (identical to live review; the
  flag is not training consent).
- Disk: one full-history clone per corpus repo under a repos root
  (default: `<CodeBleach>/../phase6-eval-repos`, so clones never pollute
  `git status`):
  ```sh
  mkdir ../phase6-eval-repos
  for repo in sveltejs/svelte vuejs/core vitejs/vite trpc/trpc eslint/eslint prettier/prettier; do
    git clone "https://github.com/${repo}.git" "../phase6-eval-repos/$(echo "$repo" | tr / -)"
  done
  ```

## 2. Run the sweep

From the CodeBleach checkout:

```sh
CODEBLEACH_PHASE6_EVAL=1 \
CODEBLEACH_PHASE6_EVAL_REPOS=../phase6-eval-repos \
CODEBLEACH_PHASE6_EVAL_OUT=tests/live/phase6-eval/results \
bun test tests/live/phase6-eval/phase6-eval.test.ts
```

Single-PR iteration:

```sh
CODEBLEACH_PHASE6_EVAL=1 CODEBLEACH_PHASE6_EVAL_ONLY=sveltejs-svelte-19362 \
bun test tests/live/phase6-eval/phase6-eval.test.ts
```

Each entry runs the production CLI twice on the same pinned merge-base/head
pair (primary-only, then `--convention-advisory`) at `--log-level info` and
writes `results/<slug>.json` plus `results/manifest.json`. Info level is
load-bearing: the advisory metrics events are info logs, so warn would
suppress them and every token/projection column would read zero. A per-PR
failure is recorded in its result file and never aborts the sweep; re-run
with `_ONLY` after fixing checkouts. Advisory usage (batches, input/output
tokens, projected/skipped units, diagnostic codes) is parsed from stderr
JSON events with exact `msg` matching, never substring matching and never
silent zeros: a missing or malformed metrics event is recorded as
`metricsStatus: "missing"` with a bounded detail, and early-exit paths emit
their own `advisory pass skipped` / `advisory merge skipped` events so a
genuine zero is distinguishable from lost telemetry. Per-run execution is
bounded by `RUN_TIMEOUT_MS` (a hung provider call kills the child instead of
stalling the sweep). The sweep also records the primary prompt version/hash
for both runs so reviewers can confirm the pair compared identical prompts.
Training gate and redaction hold throughout: metrics carry numbers and
static codes only, never prompts, source, evidence, or secrets.

## 3. Label

For every emitted advisory candidate (`advisoryFindings` in each result
file), two reviewers independently assign one label:

- `useful` — the advisory identifies a real convention deviation worth acting on.
- `technically-correct-but-not-actionable` — factually right, not worth changing.
- `incorrect/unsupported` — wrong, or not backed by the cited evidence.

Resolve disagreements through an adjudication pass and record the final label
per candidate in `labels.json` (shape in `labels.template.json`): PR URL,
finding ID, adjudicated label, optional notes. Category, severity, and ruleId
are NOT labels: the gate derives authority from the emitted records, and
labels files carrying those fields are rejected. Seeded fixtures never
count: only real-PR emitted candidates enter the gate.

## 4. Apply the gate

```sh
bun tests/live/phase6-eval/gate.ts labels.json tests/live/phase6-eval/results [--repos-root ../phase6-eval-repos]
```

Pass requires all of plan §16.5 plus measurement integrity: the corpus pins at
least 30 merged PRs across at least 5 repos with unique PR URLs; every corpus
PR has a successful result whose provenance (repo, repo URL, PR number/URL,
pinned base/head SHAs) matches its corpus pin exactly, with the recorded
merge-base recomputed from the full-history checkout under `--repos-root`
(missing checkouts or SHAs fail closed); `results/manifest.json` is the run
index and must list exactly the current run's result files with identical
provenance (a missing or drifted manifest fails the gate, so stale files from
an older run can never pass); every emitted real-PR candidate (exactly 30 or
more, counted from emitted records, never from labels) carries exactly one label;
no duplicate, unmatched (label for a never-emitted finding), unknown-PR, or
duplicate-emitted identities; at least 80% `useful` precision; zero authority
violations (emitted category must be `convention`, severity exactly `low`, no
`ruleId`); and advisory metrics present for every included run (missing or
malformed telemetry fails instead of reporting zero usage). The report also
prints per-run provider calls, input/output tokens, projection skips, and
added median/p95 wall-clock latency. Exit 0 means pass; exit 1 prints reasons
and keeps the flag experimental.

## 5. If the gate fails

- Fewer than 30 candidates: extend `corpus.json` (same shape; pin repo URL,
  PR URL, base SHA, head SHA) with `curate-corpus.ts` or by hand, re-run, and
  re-label. Never count seeded fixtures toward the minimum.
- Precision or authority failures: fix the implementation (new ticket), never
  weaken the 80% floor or relabel candidates to pass.
