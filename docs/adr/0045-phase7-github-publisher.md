# ADR 0045: Phase 7 GitHub publisher contract — per-comment publishing, marker lifecycle, run-level failures

Date: 2026-11-24

Status: Accepted (locks the Phase 7 publisher contract; no runtime publisher yet).

Preserves ADRs 0001–0044; rewrites none. Supersedes the stale `systemdesign.md`
§4.5 sketch (single batched `pulls.createReview`): the per-comment design below
is normative, the full §4.5 rewrite lands in P7-06.

## Context

Phase 7 replaces `stubPublisher` with a production GitHub pull-request
publisher plus a minimal Actions workflow. P7-00 locks the API, reconciliation,
failure, and metadata contracts before any runtime or workflow work so
P7-01–P7-06 build against a frozen interface. Baseline: `8ab22dd`
(plan `implementation-phase7.md`); `src/github/` does not exist, no Octokit
dependency, `PublishResult` is `{ published, skipped, failures }`.

## Decision

1. **Per-comment POST, no review object.** One finding maps to one
   `pulls.createReviewComment` POST pinned to `commit_id = meta.headSha`,
   using modern `line` + `side: "RIGHT"` fields (never legacy diff
   `position`). No `createReview`, no batched multi-comment POST, no review
   object or `event` in MVP. Each POST is independently auditable and
   partially recoverable; up to 10 separate inline-comment notifications per
   run is an accepted MVP trade-off.
2. **Target is `derivedTarget` only.** Before any API call, each candidate is
   cross-checked against the same-run `DiffResult`: exact path match, file
   not deleted/binary/generated/skipped, `side === "RIGHT"`, line a positive
   safe integer in `commentableLines`, `diff.headSha === meta.headSha`.
   Model-authored `file`/`line`/`endLine` are explanatory input, never
   coordinates. Anything absent, stale, or non-commentable is never posted.
3. **Accepted-only, guard unchanged.** `Publisher.publish()` keeps
   `AcceptedValidatedFinding[]`; `isAcceptedFinding()` stays the fail-closed
   pipeline guard (status alone never passes). Rejected/inconclusive findings
   and convention advisories (default off) never reach a write call.
4. **Marker lifecycle.** Every comment ends with a hidden marker
   `<!-- codebleach:finding:v1:<sha256> -->` where the digest covers a
   canonical tuple (owner, repo, PR number, existing finding fingerprint),
   never raw model text. Same marker on same head/path/line suppresses
   duplicates; same fingerprint on a new head posts the new comment first and
   reconciles the old CodeBleach-owned comment only after success.
   **SHA-1 fingerprint limitation (explicit):** the existing fingerprint
   (file, symbol, category, normalized anchor quote) is not semantic identity
   — renames, moves, category edits, or anchor-quote edits mint a new marker,
   and the older marker is treated as obsolete during successful
   reconciliation. No fuzzy or model-based matching in Phase 7.
5. **Collision behavior.** Same-run candidates sharing one marker key are all
   withheld with per-finding `marker_key_collision` (new reserved reason);
   none may suppress another. Duplicate owned markers in inventory are legacy
   state, cleaned only after one canonical current-head comment is confirmed.
6. **Budgets.** At most 10 comment-create POST attempts per run (a duplicate
   already present consumes no slot; an ambiguous POST consumes one) and at
   most 10 cleanup DELETEs. Overflow stays posted-nowhere with a stable
   reason; excess stale comments persist with `reconciliation_incomplete`.
7. **Retry and ambiguity.** Bounded retries for idempotent GETs only: at most
   3 attempts on network interruption, 502/503/504, or rate limits, honoring
   `Retry-After`/`X-RateLimit-Reset` inside a hard 10-second wait budget
   (1s then 2s backoff, 5s cap). No generic retries for writes. After a
   create-POST timeout/reset/retryable-5xx, consume the attempt slot, do one
   bounded paginated inventory refresh (cap §8), and treat a verified
   same-identity comment as confirmed; otherwise record
   `ambiguous_post_outcome` and stop all further writes and reconciliation.
   Deletes are never blindly retried.
8. **Inventory cap.** List review comments paginated (`per_page` max), at most
   20 pages × 100 records. A remaining next page fails closed with
   `comment_inventory_incomplete`: no creates, no deletes.
9. **Required `runFailures` contract.** `PublishResult` gains required
   `runFailures: PublishRunFailure[]` (empty when none), mandatory even for
   zero-finding runs. Closed 11-code union: `permission_denied`,
   `rate_limited`, `github_unavailable`, `pr_closed`,
   `pr_identity_mismatch`, `stale_base_sha`, `stale_head_sha`,
   `comment_inventory_incomplete`, `ambiguous_post_outcome`,
   `reconciliation_incomplete`, `reconciliation_skipped_incomplete_run`.
   Per-finding `failures` keep `{ file, line, reason }`. The serialized JSON
   change is additive: schema stays v2, and readers normalize a missing field
   to `[]` at the read boundary (`normalizePublishResult`).
10. **`PublishContext.reconcileStale`.** `Publisher.publish()` gains optional
    fourth `context?: PublishContext`; absent/false must never delete stale
    comments. The pipeline (P7-04) may set it true only when context is
    complete, review status is complete, every submitted unit completed
    (`unitsFailed === 0`), and validation completed with **zero inconclusive
    findings** — a run-wide, fail-closed gate. Otherwise publish confirmed
    findings but delete nothing and record
    `reconciliation_skipped_incomplete_run`. Stale leftovers accumulate by
    design; cleanup is manual in GitHub until a separately reviewed tool
    exists.
11. **Pre-delete freshness recheck.** Immediately before the first DELETE of
    a reconciliation phase, re-fetch PR metadata and re-verify open state
    plus base/head SHAs. Any change/close issues zero DELETEs and the
    matching `stale_*`/`pr_closed` run failure. No delete-phase check is
    needed when nothing is eligible for deletion.
12. **Reply-safe deletion.** Group inventory by root comment via
    `in_reply_to_id`. A stale CodeBleach root with any non-CodeBleach or
    unknown-author reply is preserved with its whole thread; no reply is
    independently deleted; record `reconciliation_incomplete` and continue
    with unrelated eligible roots within budget. Ownership requires the
    authenticated publisher identity, never the marker alone.
13. **Freshness before write.** Pre-write: PR open, API `base.sha`/`head.sha`
    equal `meta`, `diff` SHAs equal `meta`, owner/repo/number match. Any
    mismatch posts zero comments with the matching stable failure. On a
    mid-run API rejection, re-fetch once, stop further writes on change, and
    record a bounded failure; never switch to the new head silently.
14. **Metadata handoff.** `PrMeta` comes from explicit validated inputs
    (Action env: `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `CODEBLEACH_PR_NUMBER`,
    `CODEBLEACH_BASE_SHA`, `CODEBLEACH_HEAD_SHA`; full 40-hex SHAs). For a
    non-dry-run live publish the unknown `{ owner: "unknown", … }` fallback
    is forbidden — P7-04 removes it on the live path and preflights
    token/meta before model work. Demo and `--no-llm` stay offline; `--dry-run`
    makes zero GitHub calls and needs no token.
15. **Fork/Dependabot policy.** Same-repository, non-Dependabot PRs only in
    MVP. Fork PRs (including null/deleted head repos) and Dependabot PRs are
    skipped with clear diagnostics; no secrets reach fork jobs; never
    `pull_request_target`; never execute PR-head code (reviewer runs from the
    trusted base, the head is Git data only).
16. **Pacing and errors.** Mutating requests are serialized with ≥1,000 ms
    between consecutive writes (injectable clock/sleeper in tests). Map API
    failures to stable codes without logging bodies, headers, or raw errors.
    Token/secret values never enter `PrMeta`, artifacts, comments, or logs.
    `CONFIG_INVALID` for bad setup (preflight, non-zero exit);
    `GITHUB_FAILED` for expected outages (non-blocking, artifact preserved,
    summary states incompleteness); stale-head runs publish nothing and exit
    successfully. Token enters only via the GitHub-client construction
    boundary (P7-01). Job summary reads the redacted `run.json` only; no
    untrusted-content interpolation; `timeout-minutes: 25`.

## Consequences

- Type-breaking for every `PublishResult` producer/fake/fixture (updated in
  this ticket); additive on disk (schema v2 kept; legacy normalizes to `[]`).
- `isAcceptedFinding`, advisory withholding, demo/`--no-llm`/`--dry-run`
  semantics, and Phase 6 acceptance claims are unchanged.
- Deferred by ticket: Octokit pin + client seam (P7-01), renderer + target
  gate (P7-02), publisher + reconciliation (P7-03), CLI wiring + fallback
  removal (P7-04), workflow (P7-05), §4.5 rewrite + smoke (P7-06).
- Compatibility inventory (inspected; updated where it constructs or asserts
  a result): `src/types/publish.ts`, `src/core/contracts.ts`,
  `src/core/pipeline.ts`, `src/core/run-artifact.ts`, `src/core/demo.ts`,
  `src/cli/commands/review.ts` (no publish rendering today — none needed),
  `tests/fixtures/stubs.ts`, `tests/unit/stubs.test.ts` (stub throws — no
  literal), `tests/unit/run-artifact.test.ts` (null-only fixtures),
  `tests/unit/pipeline-advisory-publish.test.ts`,
  `tests/unit/pipeline-validation.test.ts`, `tests/unit/review-wiring.test.ts`,
  `tests/unit/context-diagnostics.test.ts`,
  `tests/unit/context-output-limit.test.ts`,
  `tests/unit/context-query-timeouts.test.ts`,
  `tests/integration/pipeline.test.ts` (fixture-driven assertions),
  `tests/integration/cli.test.ts` (null-only), `tests/live/phase6-eval/`
  (reads `validated`/status only — tolerant, unchanged).
