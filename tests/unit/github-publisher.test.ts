import { describe, expect, test } from "bun:test";
import type { PublishContext } from "../../src/core/contracts.ts";
import { AmbiguousGitHubWriteError, GitHubApiError, RejectedGitHubWriteError } from "../../src/github/client.ts";
import type { GitHubApi, PullRequestSnapshot, ReviewCommentRecord } from "../../src/github/client.ts";
import { computeMarkerKey } from "../../src/github/comments.ts";
import { MAX_DELETE_PER_RUN, WRITE_PACING_MS, createGitHubPublisher } from "../../src/github/publish.ts";
import type {
  AcceptedValidatedFinding,
  ChangedFile,
  DiffResult,
  PrMeta,
  PublishResult,
} from "../../src/types/index.ts";

const OWNER = "acme";
const REPO = "widget";
const NUM = 7;
const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
const OLD = "d".repeat(40);
const HEAD2 = "e".repeat(40);
const BOT = "codebleach[bot]";

function meta(overrides: Partial<PrMeta> = {}): PrMeta {
  return { owner: OWNER, repo: REPO, number: NUM, baseSha: BASE, headSha: HEAD, ...overrides };
}

function changedFile(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: "src/a.ts",
    oldPath: null,
    status: "modified",
    language: "typescript",
    hunks: [],
    commentableLines: [10, 11, 12],
    symbols: [],
    ...overrides,
  };
}

function diff(headSha: string = HEAD, files: ChangedFile[] = [changedFile()]): DiffResult {
  return { baseSha: BASE, headSha, mergeBase: "m".repeat(40), files };
}

interface FindingInput {
  id?: string | undefined;
  fingerprint?: string | undefined;
  targetLine?: number | undefined;
}

function finding(input: FindingInput = {}): AcceptedValidatedFinding {
  const line = input.targetLine ?? 10;
  return {
    finding: {
      id: input.id ?? `finding-${input.fingerprint ?? "fp-1"}`,
      fingerprint: input.fingerprint ?? "fp-1",
      headSha: HEAD,
      symbol: "resolveUser",
      origin: { pass: "test", unitId: "unit-1" },
      title: "Null dereference",
      severity: "high",
      category: "bug",
      file: "src/a.ts",
      line,
      description: "The value can be null here.",
      confidence: 0.9,
      evidence: [{ file: "src/a.ts", startLine: 10, endLine: 10, quote: "user.name" }],
      introducedByPr: true,
    },
    status: "accepted",
    checks: [],
    derivedTarget: { file: "src/a.ts", line, side: "RIGHT", kind: "added" },
    derivedAttribution: {
      introducedByPr: true,
      basis: { kind: "added-lines", evidenceIndex: 0, file: "src/a.ts", lines: [10] },
    },
  };
}

function keyFor(fingerprint: string, number: number = NUM): string {
  return computeMarkerKey({ owner: OWNER, repo: REPO, number, fingerprint });
}

function markerBody(key: string): string {
  return `note\n\n<!-- codebleach:finding:v1:${key} -->`;
}

function record(id: number, overrides: Partial<ReviewCommentRecord> = {}): ReviewCommentRecord {
  return {
    id,
    body: "plain comment",
    path: null,
    line: null,
    commitId: null,
    authorLogin: null,
    inReplyToId: null,
    ...overrides,
  };
}

function ownedRecord(
  id: number,
  fingerprint: string,
  overrides: Partial<ReviewCommentRecord> = {},
): ReviewCommentRecord {
  return record(id, {
    body: markerBody(keyFor(fingerprint)),
    path: "src/a.ts",
    line: 10,
    commitId: HEAD,
    authorLogin: BOT,
    ...overrides,
  });
}

function snapshot(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return { owner: OWNER, repo: REPO, number: NUM, state: "open", baseSha: BASE, headSha: HEAD, ...overrides };
}

function apiError(
  code: "permission_denied" | "rate_limited" | "github_unavailable" | "comment_inventory_incomplete",
): GitHubApiError {
  return new GitHubApiError({
    operation: "test",
    resource: `${OWNER}/${REPO}#${NUM}`,
    status: 500,
    runFailure: { code, message: `test ${code}` },
  });
}

interface Call {
  kind: "getPr" | "list" | "login" | "create" | "delete";
  input?: unknown;
}

interface FakeBehavior {
  snapshotResults?: Array<PullRequestSnapshot | GitHubApiError> | undefined;
  listResults?: Array<ReviewCommentRecord[] | GitHubApiError> | undefined;
  loginResult?: string | GitHubApiError | undefined;
  createResults?: Array<{ id: number } | Error> | undefined;
  deleteResults?: Array<Error> | undefined;
}

function fakeApi(behavior: FakeBehavior = {}): { api: GitHubApi; calls: Call[]; slept: number[] } {
  const calls: Call[] = [];
  const slept: number[] = [];
  let prCalls = 0;
  let listCalls = 0;
  let createCalls = 0;
  let deleteCalls = 0;
  let nextId = 9000;
  const api: GitHubApi = {
    getPullRequest: () => {
      calls.push({ kind: "getPr" });
      const seq = behavior.snapshotResults ?? [snapshot()];
      const next: PullRequestSnapshot | GitHubApiError = seq[Math.min(prCalls, seq.length - 1)] ?? snapshot();
      prCalls += 1;
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    },
    listReviewComments: () => {
      calls.push({ kind: "list" });
      const seq = behavior.listResults ?? [[]];
      const next: ReviewCommentRecord[] | GitHubApiError = seq[Math.min(listCalls, seq.length - 1)] ?? [];
      listCalls += 1;
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    },
    getAuthenticatedLogin: () => {
      calls.push({ kind: "login" });
      if (behavior.loginResult instanceof Error) return Promise.reject(behavior.loginResult);
      return Promise.resolve(behavior.loginResult ?? BOT);
    },
    createReviewComment: (input) => {
      calls.push({ kind: "create", input: { path: input.path, line: input.line, commitId: input.commitId } });
      const scripted = behavior.createResults?.[createCalls];
      createCalls += 1;
      if (scripted instanceof Error) return Promise.reject(scripted);
      if (scripted !== undefined) return Promise.resolve(scripted);
      nextId += 1;
      return Promise.resolve({ id: nextId });
    },
    deleteReviewComment: (input) => {
      calls.push({ kind: "delete", input: { commentId: input.commentId } });
      const scripted = behavior.deleteResults?.[deleteCalls];
      deleteCalls += 1;
      if (scripted instanceof Error) return Promise.reject(scripted);
      return Promise.resolve();
    },
  };
  return { api, calls, slept };
}

async function runPublish(
  behavior: FakeBehavior,
  findings: AcceptedValidatedFinding[],
  options: { diff?: DiffResult | undefined; meta?: PrMeta | undefined; context?: PublishContext | undefined } = {},
): Promise<{ result: PublishResult; calls: Call[]; slept: number[] }> {
  const { api, calls, slept } = fakeApi(behavior);
  const publisher = createGitHubPublisher({
    api,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  });
  const result = await publisher.publish(findings, options.diff ?? diff(), options.meta ?? meta(), options.context);
  return { result, calls, slept };
}

const kinds = (calls: Call[]): string[] => calls.map((call) => call.kind);

describe("github publisher metadata", () => {
  test("rejects placeholder unknown meta without api calls", async () => {
    const { api, calls } = fakeApi();
    const publisher = createGitHubPublisher({ api });
    const bad = { owner: "unknown", repo: "unknown", number: 0, baseSha: BASE, headSha: HEAD };
    await expect(publisher.publish([], diff(), bad)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(calls).toEqual([]);
  });

  test("rejects malformed shas without api calls", async () => {
    const { api, calls } = fakeApi();
    const publisher = createGitHubPublisher({ api });
    await expect(publisher.publish([], diff(), meta({ headSha: "abc" }))).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    expect(calls).toEqual([]);
  });
});

describe("github publisher freshness", () => {
  test("closed pr publishes nothing", async () => {
    const { result, calls } = await runPublish({ snapshotResults: [snapshot({ state: "closed" })] }, [finding()]);
    expect(result).toMatchObject({ published: 0, skipped: 1, failures: [], runFailures: [{ code: "pr_closed" }] });
    expect(kinds(calls)).toEqual(["getPr"]);
  });

  test("head mismatch publishes nothing", async () => {
    const { result, calls } = await runPublish({ snapshotResults: [snapshot({ headSha: HEAD2 })] }, [finding()]);
    expect(result.runFailures).toEqual([{ code: "stale_head_sha", message: expect.any(String) }]);
    expect(result.published).toBe(0);
    expect(kinds(calls)).toEqual(["getPr"]);
  });

  test("base mismatch publishes nothing", async () => {
    const { result } = await runPublish({ snapshotResults: [snapshot({ baseSha: "c".repeat(40) })] }, [finding()]);
    expect(result.runFailures).toEqual([{ code: "stale_base_sha", message: expect.any(String) }]);
  });

  test("number mismatch publishes nothing", async () => {
    const { result } = await runPublish({ snapshotResults: [snapshot({ number: 99 })] }, [finding()]);
    expect(result.runFailures).toEqual([{ code: "pr_identity_mismatch", message: expect.any(String) }]);
  });

  test("diff drift publishes nothing", async () => {
    const { result, calls } = await runPublish({}, [finding()], { diff: diff(HEAD2) });
    expect(result.runFailures).toEqual([{ code: "stale_head_sha", message: expect.any(String) }]);
    expect(kinds(calls)).toEqual(["getPr"]);
  });

  test("api outage maps to run failure", async () => {
    const { result, calls } = await runPublish({ snapshotResults: [apiError("github_unavailable")] }, [finding()]);
    expect(result).toMatchObject({ published: 0, skipped: 1, runFailures: [{ code: "github_unavailable" }] });
    expect(kinds(calls)).toEqual(["getPr"]);
  });

  test("zero findings still checks freshness", async () => {
    const { result, calls } = await runPublish({}, []);
    expect(result).toEqual({ published: 0, skipped: 0, failures: [], runFailures: [] });
    expect(kinds(calls)).toEqual(["getPr", "list", "login"]);
  });
});

describe("github publisher gating", () => {
  test("non-commentable target is skipped with failure", async () => {
    const { result, calls } = await runPublish({}, [finding({ targetLine: 99 })]);
    expect(result).toMatchObject({
      published: 0,
      skipped: 1,
      failures: [{ file: "src/a.ts", line: 99, reason: "target_line_not_commentable" }],
    });
    expect(kinds(calls)).not.toContain("create");
  });

  test("same-run collision withholds both", async () => {
    const { result, calls } = await runPublish({}, [
      finding({ fingerprint: "same" }),
      finding({ fingerprint: "same" }),
    ]);
    expect(result.published).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.failures).toEqual([
      { file: "src/a.ts", line: 10, reason: "marker_key_collision" },
      { file: "src/a.ts", line: 10, reason: "marker_key_collision" },
    ]);
    expect(kinds(calls)).not.toContain("create");
  });

  test("same-head duplicate skips without budget", async () => {
    const dupes = Array.from({ length: 10 }, (_, i) => finding({ fingerprint: `dupe-${i}`, targetLine: 10 }));
    const fresh = Array.from({ length: 10 }, (_, i) => finding({ fingerprint: `new-${i}`, targetLine: 11 }));
    const inventory = dupes.map((item, i) => ownedRecord(100 + i, item.finding.fingerprint));
    const { result, calls } = await runPublish({ listResults: [inventory] }, [...dupes, ...fresh]);
    expect(result.published).toBe(10);
    expect(result.skipped).toBe(10);
    expect(result.failures).toEqual([]);
    expect(calls.filter((call) => call.kind === "create")).toHaveLength(10);
  });

  test("foreign-author marker withholds without delete", async () => {
    const foreign = ownedRecord(41, "fp-1", { authorLogin: "someone-else" });
    const { result, calls } = await runPublish({ listResults: [[foreign]] }, [finding()]);
    expect(result).toMatchObject({
      published: 0,
      skipped: 1,
      failures: [{ file: "src/a.ts", line: 10, reason: "marker_ownership_ambiguous" }],
    });
    expect(kinds(calls)).not.toContain("create");
    expect(kinds(calls)).not.toContain("delete");
  });

  test("unknown-author marker withholds without delete", async () => {
    const unknown = ownedRecord(42, "fp-1", { authorLogin: null });
    const { result, calls } = await runPublish({ listResults: [[unknown]] }, [finding()]);
    expect(result.failures).toEqual([{ file: "src/a.ts", line: 10, reason: "marker_ownership_ambiguous" }]);
    expect(kinds(calls)).not.toContain("delete");
  });
});

describe("github publisher creates", () => {
  test("posts one comment pinned to head sha", async () => {
    const { result, calls } = await runPublish({}, [finding()]);
    expect(result).toMatchObject({ published: 1, skipped: 0, failures: [], runFailures: [] });
    const creates = calls.filter((call) => call.kind === "create");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.input).toMatchObject({ path: "src/a.ts", line: 10, commitId: HEAD });
  });

  test("comment body ends with stable marker", async () => {
    const seen: string[] = [];
    const { api, calls } = fakeApi();
    void calls;
    const capturing: GitHubApi = {
      ...api,
      createReviewComment: (input) => {
        seen.push(input.body);
        return Promise.resolve({ id: 1 });
      },
    };
    const publisher = createGitHubPublisher({ api: capturing });
    await publisher.publish([finding()], diff(), meta());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.endsWith(`\n\n<!-- codebleach:finding:v1:${keyFor("fp-1")} -->`)).toBe(true);
  });

  test("caps create attempts at ten", async () => {
    const lines = [10, 11, 12] as const;
    const many = Array.from({ length: 12 }, (_, i) =>
      finding({ fingerprint: `cap-${i}`, targetLine: lines[i % lines.length] }),
    );
    const overflowA = lines[10 % lines.length] ?? 10;
    const overflowB = lines[11 % lines.length] ?? 10;
    const { result, calls } = await runPublish({}, many);
    expect(result.published).toBe(10);
    expect(result.skipped).toBe(2);
    expect(result.failures).toEqual([
      { file: "src/a.ts", line: overflowA, reason: "publish_cap_exceeded" },
      { file: "src/a.ts", line: overflowB, reason: "publish_cap_exceeded" },
    ]);
    expect(calls.filter((call) => call.kind === "create")).toHaveLength(10);
  });

  test("paces consecutive writes", async () => {
    const stale = ownedRecord(7, "old-fp", { commitId: OLD });
    const { slept } = await runPublish({ listResults: [[stale]] }, [finding()], { context: { reconcileStale: true } });
    expect(slept).toEqual([WRITE_PACING_MS]);
  });

  test("permission failure stops the run", async () => {
    const denied = new GitHubApiError({
      operation: "create review comment",
      status: 403,
      runFailure: { code: "permission_denied", message: "nope" },
    });
    const { result, calls } = await runPublish({ createResults: [denied] }, [
      finding(),
      finding({ fingerprint: "fp-2" }),
    ]);
    expect(result.runFailures).toEqual([{ code: "permission_denied", message: "nope" }]);
    expect(result.published).toBe(0);
    expect(result.skipped).toBe(2);
    expect(calls.filter((call) => call.kind === "create")).toHaveLength(1);
    expect(kinds(calls)).not.toContain("delete");
  });

  test("rate limit stops the run", async () => {
    const limited = new GitHubApiError({
      operation: "create review comment",
      status: 429,
      runFailure: { code: "rate_limited", message: "slow down" },
    });
    const { result, calls } = await runPublish({ createResults: [limited] }, [finding()]);
    expect(result.runFailures).toEqual([{ code: "rate_limited", message: "slow down" }]);
    expect(calls.filter((call) => call.kind === "create")).toHaveLength(1);
  });

  test("rejected write records per-finding failure and continues", async () => {
    const rejected = new RejectedGitHubWriteError({ operation: "create review comment", status: 422 });
    const stale = ownedRecord(7, "old-fp", { commitId: OLD });
    const { result, calls } = await runPublish(
      { listResults: [[stale]], createResults: [rejected] },
      [finding(), finding({ fingerprint: "fp-2", targetLine: 11 })],
      { context: { reconcileStale: true } },
    );
    expect(result.published).toBe(1);
    expect(result.failures).toEqual([{ file: "src/a.ts", line: 10, reason: "comment_write_rejected" }]);
    // A failed write blocks destructive cleanup even with the gate open.
    expect(kinds(calls)).not.toContain("delete");
    expect(result.runFailures).toEqual([
      { code: "reconciliation_skipped_incomplete_run", message: expect.any(String) },
    ]);
  });

  test("rejected write on stale head stops the run", async () => {
    const rejected = new RejectedGitHubWriteError({ operation: "create review comment", status: 422 });
    const { result, calls } = await runPublish(
      { snapshotResults: [snapshot(), snapshot({ headSha: HEAD2 })], createResults: [rejected] },
      [finding(), finding({ fingerprint: "fp-2" })],
    );
    expect(result.runFailures).toEqual([{ code: "stale_head_sha", message: expect.any(String) }]);
    expect(result.published).toBe(0);
    expect(calls.filter((call) => call.kind === "create")).toHaveLength(1);
  });

  test("ambiguous write confirmed by refresh counts as published", async () => {
    const timeout = new AmbiguousGitHubWriteError({ operation: "create review comment", status: undefined });
    const confirmed = ownedRecord(55, "fp-1");
    const { result, calls } = await runPublish({ listResults: [[], [confirmed]], createResults: [timeout] }, [
      finding(),
    ]);
    expect(result).toMatchObject({ published: 1, skipped: 0, failures: [], runFailures: [] });
    expect(calls.filter((call) => call.kind === "create")).toHaveLength(1);
  });

  test("ambiguous write without refresh match stops the run", async () => {
    const timeout = new AmbiguousGitHubWriteError({ operation: "create review comment", status: 500 });
    const { result, calls } = await runPublish({ listResults: [[], []], createResults: [timeout] }, [
      finding(),
      finding({ fingerprint: "fp-2" }),
    ]);
    expect(result.runFailures).toEqual([{ code: "ambiguous_post_outcome", message: expect.any(String) }]);
    expect(result.published).toBe(0);
    expect(calls.filter((call) => call.kind === "create")).toHaveLength(1);
    expect(kinds(calls)).not.toContain("delete");
  });
});

describe("github publisher reconciliation", () => {
  test("new head posts then deletes the old owned comment", async () => {
    const old = ownedRecord(11, "fp-1", { commitId: OLD });
    const { result, calls } = await runPublish({ listResults: [[old]] }, [finding()], {
      context: { reconcileStale: true },
    });
    expect(result).toMatchObject({ published: 1, skipped: 0, runFailures: [] });
    expect(calls.filter((call) => call.kind === "delete")).toEqual([{ kind: "delete", input: { commentId: 11 } }]);
  });

  test("closed gate keeps stale comments with diagnostic", async () => {
    const old = ownedRecord(11, "fp-1", { commitId: OLD });
    const { result, calls } = await runPublish({ listResults: [[old]] }, [finding()], { context: undefined });
    expect(result.published).toBe(1);
    expect(kinds(calls)).not.toContain("delete");
    expect(result.runFailures).toEqual([
      { code: "reconciliation_skipped_incomplete_run", message: expect.any(String) },
    ]);
  });

  test("duplicate legacy extras collapse after confirm", async () => {
    const first = ownedRecord(11, "fp-1", { commitId: OLD });
    const second = ownedRecord(12, "fp-1", { commitId: OLD, line: 11 });
    const { result, calls } = await runPublish(
      { listResults: [[first, second]], createResults: [{ id: 9001 }] },
      [finding()],
      { context: { reconcileStale: true } },
    );
    expect(result).toMatchObject({ published: 1, runFailures: [] });
    expect(calls.filter((call) => call.kind === "delete")).toEqual([
      { kind: "delete", input: { commentId: 11 } },
      { kind: "delete", input: { commentId: 12 } },
    ]);
  });

  test("human reply vetoes root deletion only", async () => {
    const vetoed = ownedRecord(1, "old-a", { commitId: OLD });
    const reply = record(2, { authorLogin: "human", inReplyToId: 1 });
    const other = ownedRecord(3, "old-b", { commitId: OLD });
    const { result, calls } = await runPublish({ listResults: [[vetoed, reply, other]] }, [], {
      context: { reconcileStale: true },
    });
    expect(calls.filter((call) => call.kind === "delete")).toEqual([{ kind: "delete", input: { commentId: 3 } }]);
    expect(result.runFailures).toEqual([{ code: "reconciliation_incomplete", message: expect.any(String) }]);
  });

  test("unknown-author reply vetoes deletion", async () => {
    const vetoed = ownedRecord(1, "old-a", { commitId: OLD });
    const reply = record(2, { authorLogin: null, inReplyToId: 1 });
    const { result, calls } = await runPublish({ listResults: [[vetoed, reply]] }, [], {
      context: { reconcileStale: true },
    });
    expect(kinds(calls)).not.toContain("delete");
    expect(result.runFailures).toEqual([{ code: "reconciliation_incomplete", message: expect.any(String) }]);
  });

  test("bot-authored reply does not veto", async () => {
    const root = ownedRecord(1, "old-a", { commitId: OLD });
    const reply = record(2, { authorLogin: BOT, inReplyToId: 1 });
    const { result, calls } = await runPublish({ listResults: [[root, reply]] }, [], {
      context: { reconcileStale: true },
    });
    expect(calls.filter((call) => call.kind === "delete")).toEqual([{ kind: "delete", input: { commentId: 1 } }]);
    expect(result.runFailures).toEqual([]);
  });

  test("pre-delete recheck stops cleanup on head change", async () => {
    const stale = ownedRecord(7, "old-fp", { commitId: OLD });
    const { result, calls } = await runPublish(
      { snapshotResults: [snapshot(), snapshot({ headSha: HEAD2 })], listResults: [[stale]] },
      [finding()],
      { context: { reconcileStale: true } },
    );
    expect(result.published).toBe(1);
    expect(kinds(calls)).not.toContain("delete");
    expect(result.runFailures).toEqual([{ code: "stale_head_sha", message: expect.any(String) }]);
  });

  test("delete budget caps at ten", async () => {
    const stale = Array.from({ length: 12 }, (_, i) => ownedRecord(i + 1, `old-${i}`, { commitId: OLD }));
    const { result, calls } = await runPublish({ listResults: [stale] }, [], {
      context: { reconcileStale: true },
    });
    expect(calls.filter((call) => call.kind === "delete")).toHaveLength(MAX_DELETE_PER_RUN);
    expect(result.runFailures).toEqual([{ code: "reconciliation_incomplete", message: expect.any(String) }]);
  });

  test("ambiguous delete with marker remaining stops cleanup", async () => {
    const first = ownedRecord(1, "old-a", { commitId: OLD });
    const second = ownedRecord(2, "old-b", { commitId: OLD });
    const ambiguous = new AmbiguousGitHubWriteError({ operation: "delete review comment", status: 500 });
    const { result, calls } = await runPublish(
      {
        listResults: [
          [first, second],
          [first, second],
        ],
        deleteResults: [ambiguous],
      },
      [],
      { context: { reconcileStale: true } },
    );
    expect(calls.filter((call) => call.kind === "delete")).toHaveLength(1);
    expect(result.runFailures).toEqual([{ code: "reconciliation_incomplete", message: expect.any(String) }]);
  });

  test("delete failure stops cleanup", async () => {
    const first = ownedRecord(1, "old-a", { commitId: OLD });
    const second = ownedRecord(2, "old-b", { commitId: OLD });
    const { result, calls } = await runPublish(
      { listResults: [[first, second]], deleteResults: [apiError("github_unavailable")] },
      [],
      { context: { reconcileStale: true } },
    );
    expect(calls.filter((call) => call.kind === "delete")).toHaveLength(1);
    expect(result.runFailures).toEqual([{ code: "reconciliation_incomplete", message: expect.any(String) }]);
  });

  test("empty run cleans up stale with gate open", async () => {
    const stale = ownedRecord(9, "old-fp", { commitId: OLD });
    const { result, calls } = await runPublish({ listResults: [[stale]] }, [], {
      context: { reconcileStale: true },
    });
    expect(result).toMatchObject({ published: 0, skipped: 0, failures: [], runFailures: [] });
    expect(calls.filter((call) => call.kind === "delete")).toHaveLength(1);
  });

  test("incomplete inventory blocks writes", async () => {
    const { result, calls } = await runPublish({ listResults: [apiError("comment_inventory_incomplete")] }, [
      finding(),
    ]);
    expect(result).toMatchObject({ published: 0, runFailures: [{ code: "comment_inventory_incomplete" }] });
    expect(kinds(calls)).not.toContain("create");
  });

  test("login failure blocks writes", async () => {
    const { result, calls } = await runPublish({ loginResult: apiError("github_unavailable") }, [finding()]);
    expect(result).toMatchObject({ published: 0, runFailures: [{ code: "github_unavailable" }] });
    expect(kinds(calls)).not.toContain("create");
  });
});
