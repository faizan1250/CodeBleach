import { normalizeRepoPath } from "../review/normalize.ts";
import type { PublishContext, Publisher } from "../core/contracts.ts";
import { ReviewerError } from "../core/errors.ts";
import { AmbiguousGitHubWriteError, GitHubApiError, RejectedGitHubWriteError } from "./client.ts";
import type { GitHubApi, PullRequestSnapshot, ReviewCommentRecord } from "./client.ts";
import {
  MAX_INLINE_COMMENTS,
  groupByMarkerKey,
  parseMarkerKeys,
  partitionPublishable,
  renderCommentBody,
} from "./comments.ts";
import type { PublishableCandidate } from "./comments.ts";
import type {
  AcceptedValidatedFinding,
  DiffResult,
  PrMeta,
  PublishFailure,
  PublishResult,
  PublishRunFailure,
} from "../types/index.ts";

// Phase 7 publisher + reconciliation (ADR 0045). Side-effect boundary: it
// receives already-validated accepted findings and posts one review comment
// per finding pinned to commit_id = meta.headSha. Freshness, dedupe, budgets,
// pacing, and reply-safe reconciliation live here; transport details in
// client.ts, rendering and the target gate in comments.ts.

/** Cleanup budget: at most 10 DELETE requests per run (ADR 0045 D6). */
export const MAX_DELETE_PER_RUN = 10;

/** Fixed pacing between consecutive mutating requests, in milliseconds. */
export const WRITE_PACING_MS = 1000;

const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Stable per-finding reasons for publisher-side withholds beyond the target gate. */
const REASON_OWNERSHIP_AMBIGUOUS = "marker_ownership_ambiguous";
const REASON_CAP_EXCEEDED = "publish_cap_exceeded";
const REASON_WRITE_REJECTED = "comment_write_rejected";

export interface GitHubPublisherOptions {
  readonly api: GitHubApi;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export function createGitHubPublisher(options: GitHubPublisherOptions): Publisher {
  const api = options.api;
  const sleep = options.sleep ?? defaultSleep;
  return {
    publish: (findings, diff, meta, context) => publishAccepted(api, sleep, findings, diff, meta, context),
  };
}

async function publishAccepted(
  api: GitHubApi,
  sleep: (ms: number) => Promise<void>,
  findings: AcceptedValidatedFinding[],
  diff: DiffResult,
  meta: PrMeta,
  context: PublishContext | undefined,
): Promise<PublishResult> {
  // Unknown/placeholder metadata never reaches a write call: it fails here
  // with CONFIG_INVALID instead of the pipeline's offline fallback shape.
  requireValidPrMeta(meta);
  const failures: PublishFailure[] = [];
  const runFailures: PublishRunFailure[] = [];
  let published = 0;
  let skipped = 0;
  let writesSoFar = 0;
  const pace = async (): Promise<void> => {
    if (writesSoFar > 0) await sleep(WRITE_PACING_MS);
  };

  // Freshness before any write: an open PR whose base/head SHAs still match.
  let snapshot: PullRequestSnapshot;
  try {
    snapshot = await api.getPullRequest({ owner: meta.owner, repo: meta.repo, number: meta.number });
  } catch (error) {
    return { published, skipped: findings.length, failures, runFailures: [...runFailures, toRunFailure(error)] };
  }
  const identity = checkSnapshot(snapshot, meta);
  if (!identity.ok) {
    return { published, skipped: findings.length, failures, runFailures: [...runFailures, identity.failure] };
  }
  const drift = checkDiffDrift(diff, meta);
  if (drift !== undefined) {
    return { published, skipped: findings.length, failures, runFailures: [...runFailures, drift] };
  }

  // Target gate first (no budget cost), then same-run marker collisions.
  const { eligible, ineligible } = partitionPublishable(findings, diff, meta);
  for (const item of ineligible) {
    skipped += 1;
    failures.push({
      file: item.finding.derivedTarget.file,
      line: item.finding.derivedTarget.line,
      reason: item.reason,
    });
  }
  const singles: PublishableCandidate[] = [];
  for (const group of groupByMarkerKey(eligible).values()) {
    const first = group[0];
    if (first === undefined) continue;
    if (group.length === 1) {
      singles.push(first);
      continue;
    }
    for (const candidate of group) {
      skipped += 1;
      failures.push({ file: candidate.target.path, line: candidate.target.line, reason: "marker_key_collision" });
    }
  }

  // Inventory and publisher identity before any write.
  let inventory: ReviewCommentRecord[];
  try {
    inventory = await api.listReviewComments({ owner: meta.owner, repo: meta.repo, number: meta.number });
  } catch (error) {
    return {
      published,
      skipped: skipped + singles.length,
      failures,
      runFailures: [...runFailures, toRunFailure(error)],
    };
  }
  let botLogin: string;
  try {
    botLogin = await api.getAuthenticatedLogin();
  } catch (error) {
    return {
      published,
      skipped: skipped + singles.length,
      failures,
      runFailures: [...runFailures, toRunFailure(error)],
    };
  }
  const botLower = botLogin.toLowerCase();
  // Ownership requires the authenticated publisher identity, never the marker alone.
  const isOwned = (record: ReviewCommentRecord): boolean =>
    record.authorLogin !== null && record.authorLogin.toLowerCase() === botLower;
  const byKey = indexByMarkerKey(inventory);
  const currentKeys = new Set(singles.map((candidate) => candidate.markerKey));
  const confirmedKeys = new Set<string>();
  const canonicalIds = new Map<string, number>();
  const pending: PublishableCandidate[] = [];
  for (const candidate of singles) {
    const matches = byKey.get(candidate.markerKey) ?? [];
    const owned = matches.filter(isOwned);
    const canonical = owned.find((record) => isCurrentLocation(record, candidate, meta));
    if (canonical !== undefined) {
      skipped += 1;
      confirmedKeys.add(candidate.markerKey);
      canonicalIds.set(candidate.markerKey, canonical.id);
      continue;
    }
    if (owned.length > 0) {
      // Same fingerprint on an older head or location: post the new comment
      // first; the old owned copies become cleanup-eligible after success.
      pending.push(candidate);
      continue;
    }
    if (matches.length > 0) {
      // Marker exists only under a foreign or unknown author: never claim it
      // as our duplicate and never delete it; withhold this candidate.
      skipped += 1;
      failures.push({ file: candidate.target.path, line: candidate.target.line, reason: REASON_OWNERSHIP_AMBIGUOUS });
      continue;
    }
    pending.push(candidate);
  }

  // Per-comment creates: deterministic order, one POST each, no retries.
  let createAttempts = 0;
  let stopped = false;
  let publishClean = true;
  for (const candidate of pending) {
    if (stopped) {
      skipped += 1;
      continue;
    }
    if (createAttempts >= MAX_INLINE_COMMENTS) {
      skipped += 1;
      failures.push({ file: candidate.target.path, line: candidate.target.line, reason: REASON_CAP_EXCEEDED });
      publishClean = false;
      continue;
    }
    createAttempts += 1;
    await pace();
    const body = renderCommentBody(candidate.finding, candidate.markerKey);
    try {
      const created = await api.createReviewComment({
        owner: meta.owner,
        repo: meta.repo,
        number: meta.number,
        commitId: candidate.target.commitId,
        path: candidate.target.path,
        line: candidate.target.line,
        body,
      });
      writesSoFar += 1;
      published += 1;
      confirmedKeys.add(candidate.markerKey);
      canonicalIds.set(candidate.markerKey, created.id);
    } catch (error) {
      writesSoFar += 1;
      publishClean = false;
      if (error instanceof AmbiguousGitHubWriteError) {
        // The POST may have applied: exactly one inventory refresh decides.
        // A verified same-identity comment counts as confirmed; anything
        // else stops all further writes and reconciliation. A failed refresh
        // keeps the stop but carries the refresh cause (closed code only).
        let refreshFailure: PublishRunFailure | undefined;
        const confirmed = await refreshInventory(api, meta).then(
          (refresh) =>
            refresh.find(
              (record) =>
                isOwned(record) &&
                isCurrentLocation(record, candidate, meta) &&
                parseMarkerKeys(record.body).includes(candidate.markerKey),
            ),
          (error) => {
            if (error instanceof GitHubApiError) refreshFailure = error.runFailure;
            return undefined;
          },
        );
        if (confirmed === undefined) {
          runFailures.push({
            code: "ambiguous_post_outcome",
            message:
              refreshFailure === undefined
                ? "a comment create outcome is ambiguous; stopped to prefer a missing comment over a duplicate"
                : `a comment create outcome is ambiguous; inventory refresh failed (${refreshFailure.code}); stopped to prefer a missing comment over a duplicate`,
          });
          stopped = true;
          skipped += 1;
        } else {
          published += 1;
          confirmedKeys.add(candidate.markerKey);
          canonicalIds.set(candidate.markerKey, confirmed.id);
        }
      } else if (error instanceof RejectedGitHubWriteError) {
        // The API rejected this comment: re-fetch once to distinguish a
        // stale head (stop everything) from a comment-specific rejection.
        const verdict = await recheckFreshness(api, meta);
        if (verdict !== undefined) {
          runFailures.push(verdict);
          stopped = true;
          skipped += 1;
        } else {
          skipped += 1;
          failures.push({ file: candidate.target.path, line: candidate.target.line, reason: REASON_WRITE_REJECTED });
        }
      } else if (error instanceof GitHubApiError) {
        runFailures.push(error.runFailure);
        stopped = true;
        skipped += 1;
      } else {
        throw error;
      }
    }
  }

  // Reconciliation is destructive: it runs only after a fully successful
  // publish pass and only when the pipeline explicitly opened the gate (the
  // pipeline owns the run-wide zero-inconclusive completeness proof).
  const deletable = collectDeletableRoots(inventory, currentKeys, confirmedKeys, canonicalIds, isOwned);
  if (deletable.length === 0) return { published, skipped, failures, runFailures };
  if (context?.reconcileStale !== true || !publishClean) {
    // A create-pass run failure already explains the skip; adding a second
    // diagnostic here is noise, so record the skip only when unexplained.
    if (runFailures.length === 0) {
      runFailures.push({
        code: "reconciliation_skipped_incomplete_run",
        message: "stale comment reconciliation skipped: cleanup gate closed or publish pass incomplete",
      });
    }
    return { published, skipped, failures, runFailures };
  }
  // Separate freshness recheck immediately before the first DELETE: pacing
  // can leave a 10-20s gap since the pre-create check.
  const recheck = await recheckFreshness(api, meta);
  if (recheck !== undefined) {
    runFailures.push(recheck);
    return { published, skipped, failures, runFailures };
  }
  const childrenById = indexReplies(inventory);
  let deletes = 0;
  let incompleteRecorded = false;
  const recordIncomplete = (cause?: PublishRunFailure): void => {
    if (!incompleteRecorded) {
      incompleteRecorded = true;
      runFailures.push({
        code: "reconciliation_incomplete",
        message:
          cause === undefined
            ? "stale comment reconciliation incomplete; some owned comments remain"
            : `stale comment reconciliation incomplete; some owned comments remain (inventory refresh failed: ${cause.code})`,
      });
    }
  };
  for (const root of deletable) {
    if (deletes >= MAX_DELETE_PER_RUN) {
      recordIncomplete();
      break;
    }
    // Reply-safe rule: any non-CodeBleach or unknown-author reply vetoes
    // deletion of the root; no reply is ever deleted independently.
    const replies = childrenById.get(root.id) ?? [];
    if (replies.some((reply) => !isOwned(reply))) {
      recordIncomplete();
      continue;
    }
    await pace();
    try {
      await api.deleteReviewComment({ owner: meta.owner, repo: meta.repo, commentId: root.id });
      writesSoFar += 1;
      deletes += 1;
    } catch (error) {
      writesSoFar += 1;
      if (error instanceof AmbiguousGitHubWriteError) {
        // Fail closed on refresh failure (assume still there), but keep the
        // refresh cause (closed code only) instead of swallowing it.
        let refreshFailure: PublishRunFailure | undefined;
        const stillThere = await refreshInventory(api, meta).then(
          (refresh) => refresh.some((record) => record.id === root.id),
          (refreshError) => {
            if (refreshError instanceof GitHubApiError) refreshFailure = refreshError.runFailure;
            return true;
          },
        );
        if (stillThere) {
          recordIncomplete(refreshFailure);
          break;
        }
        deletes += 1;
      } else if (error instanceof GitHubApiError) {
        recordIncomplete();
        break;
      } else {
        throw error;
      }
    }
  }
  return { published, skipped, failures, runFailures };
}

/** Placeholder and malformed metadata never reach a write call (CONFIG_INVALID). */
function requireValidPrMeta(meta: PrMeta): void {
  if (
    meta.owner.trim().length === 0 ||
    meta.repo.trim().length === 0 ||
    !Number.isSafeInteger(meta.number) ||
    meta.number < 1
  ) {
    throw new ReviewerError({
      code: "CONFIG_INVALID",
      message: "github publisher requires a valid pull-request owner, repository, and positive number",
    });
  }
  if (!SHA_PATTERN.test(meta.baseSha) || !SHA_PATTERN.test(meta.headSha)) {
    throw new ReviewerError({
      code: "CONFIG_INVALID",
      message: "github publisher requires full 40-character base and head SHAs",
    });
  }
}

/** API-level failures map to their stable run-level code; anything else is a defect. */
function toRunFailure(error: unknown): PublishRunFailure {
  if (error instanceof GitHubApiError) return error.runFailure;
  throw error;
}

/** Pre-write identity: open PR with matching owner/repo/number and SHAs. */
function checkSnapshot(
  snapshot: PullRequestSnapshot,
  meta: PrMeta,
): { ok: true } | { ok: false; failure: PublishRunFailure } {
  if (snapshot.owner !== meta.owner || snapshot.repo !== meta.repo || snapshot.number !== meta.number) {
    return {
      ok: false,
      failure: {
        code: "pr_identity_mismatch",
        message: "pull request identity does not match the requested owner, repository, and number",
      },
    };
  }
  if (snapshot.state !== "open") {
    return { ok: false, failure: { code: "pr_closed", message: "pull request is closed; nothing was published" } };
  }
  if (snapshot.baseSha !== meta.baseSha) {
    return {
      ok: false,
      failure: { code: "stale_base_sha", message: "pull request base SHA changed; nothing was published" },
    };
  }
  if (snapshot.headSha !== meta.headSha) {
    return {
      ok: false,
      failure: { code: "stale_head_sha", message: "pull request head SHA changed; nothing was published" },
    };
  }
  return { ok: true };
}

/** The same-run diff must belong to the requested snapshot before posting. */
function checkDiffDrift(diff: DiffResult, meta: PrMeta): PublishRunFailure | undefined {
  if (diff.baseSha !== meta.baseSha) {
    return { code: "stale_base_sha", message: "diff base SHA does not match the requested pull request" };
  }
  if (diff.headSha !== meta.headSha) {
    return { code: "stale_head_sha", message: "diff head SHA does not match the requested pull request" };
  }
  return undefined;
}

/** Re-fetch PR metadata after a rejection: a changed/closed PR stops the run,
 *  an unchanged one means the rejection was comment-specific. */
async function recheckFreshness(api: GitHubApi, meta: PrMeta): Promise<PublishRunFailure | undefined> {
  let snapshot: PullRequestSnapshot;
  try {
    snapshot = await api.getPullRequest({ owner: meta.owner, repo: meta.repo, number: meta.number });
  } catch (error) {
    return toRunFailure(error);
  }
  const identity = checkSnapshot(snapshot, meta);
  return identity.ok ? undefined : identity.failure;
}

async function refreshInventory(api: GitHubApi, meta: PrMeta): Promise<ReviewCommentRecord[]> {
  return api.listReviewComments({ owner: meta.owner, repo: meta.repo, number: meta.number });
}

/** An inventory record counts as the current comment only on the same head SHA, path, and line. */
function isCurrentLocation(record: ReviewCommentRecord, candidate: PublishableCandidate, meta: PrMeta): boolean {
  if (record.commitId !== meta.headSha) return false;
  if (record.line !== candidate.target.line) return false;
  const recordPath = record.path === null ? null : normalizeRepoPath(record.path);
  const targetPath = normalizeRepoPath(candidate.target.path);
  if (recordPath === null || targetPath === null) return record.path === candidate.target.path;
  return recordPath === targetPath;
}

function indexByMarkerKey(inventory: ReviewCommentRecord[]): Map<string, ReviewCommentRecord[]> {
  const byKey = new Map<string, ReviewCommentRecord[]>();
  for (const record of inventory) {
    for (const key of parseMarkerKeys(record.body)) {
      const group = byKey.get(key);
      if (group === undefined) byKey.set(key, [record]);
      else group.push(record);
    }
  }
  return byKey;
}

function indexReplies(inventory: ReviewCommentRecord[]): Map<number, ReviewCommentRecord[]> {
  const children = new Map<number, ReviewCommentRecord[]>();
  for (const record of inventory) {
    if (record.inReplyToId === null) continue;
    const group = children.get(record.inReplyToId);
    if (group === undefined) children.set(record.inReplyToId, [record]);
    else group.push(record);
  }
  return children;
}

/**
 * Owned roots eligible for deletion: orphans (no marker claimed by any
 * current finding) plus duplicate-legacy extras for confirmed keys, excluding
 * each key's canonical current-head comment by id. Roots only — replies are
 * never deleted independently — and deterministic id order.
 */
function collectDeletableRoots(
  inventory: ReviewCommentRecord[],
  currentKeys: Set<string>,
  confirmedKeys: Set<string>,
  canonicalIds: Map<string, number>,
  isOwned: (record: ReviewCommentRecord) => boolean,
): ReviewCommentRecord[] {
  const deletable: ReviewCommentRecord[] = [];
  for (const record of inventory) {
    if (record.inReplyToId !== null) continue;
    if (!isOwned(record)) continue;
    const keys = parseMarkerKeys(record.body);
    if (keys.length === 0) continue;
    if (keys.every((key) => !currentKeys.has(key))) {
      deletable.push(record);
      continue;
    }
    // A record touching a current-but-unconfirmed key stays: its finding was
    // never confirmed on this head, so nothing proves it obsolete.
    if (keys.some((key) => currentKeys.has(key) && !confirmedKeys.has(key))) continue;
    const isCanonical = keys.some((key) => canonicalIds.get(key) === record.id);
    if (!isCanonical) deletable.push(record);
  }
  deletable.sort((a, b) => a.id - b.id);
  return deletable;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
