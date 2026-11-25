# Disposable-PR live smoke (manual-only, never CI)

Phase 7 acceptance step for a human operator. No agent runs this: do not
create real PRs from automation, and never use a production PR as the
first end-to-end test.

## Preconditions

- Repository owner has enabled branch protection/rules before any
  write-capable automation runs on real PRs.
- Operator has a write-capable `GITHUB_TOKEN`, `OPENCODE_API_KEY`, and
  `CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING=true` (Not-ZDR: prompts/completions
  may train future models).
- Same repository, non-Dependabot test PR. Fork PRs are out of scope and
  must stay skipped.

## Procedure (plan `implementation-phase7.md` §8.7)

1. Open a disposable test PR adding one seeded defect on a changed line.
2. Confirm exactly one inline comment appears on the correct line and uses
   the current head SHA.
3. Re-run without changing the head; confirm no duplicate is created.
4. Push a commit that moves/fixes the finding; confirm the current run
   posts no stale target and reconciles the older CodeBleach comment only
   after a successful publish.
5. Close the PR or push another commit during a controlled test; confirm
   freshness checks suppress stale publication.
6. Confirm a fork PR is skipped and receives no secret/token with write
   permissions.
7. Confirm demo and `--no-llm` are offline and dry-run makes no GitHub
   write calls.

## Recording

Append the dated result (PR number, head SHAs, observed comment
counts/markers, job-summary text) to the session dossier. A missing step
is a Phase 7 gap, not a silent pass.
