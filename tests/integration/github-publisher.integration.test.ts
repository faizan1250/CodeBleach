import { describe, expect, test } from "bun:test";
import { createGitHubClient } from "../../src/github/client.ts";
import type { GitHubTransport, GitHubTransportResponse } from "../../src/github/client.ts";
import { computeMarkerKey } from "../../src/github/comments.ts";
import { createGitHubPublisher } from "../../src/github/publish.ts";
import type { AcceptedValidatedFinding, ChangedFile, DiffResult, PrMeta } from "../../src/types/index.ts";

// Mocked end-to-end through the real Octokit transport seam: no network, no
// credentials. Exercises freshness GET → inventory → create POST → dedupe →
// new-head refresh + cleanup with the real client and publisher wired together.

const OWNER = "acme";
const REPO = "widget";
const NUM = 7;
const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
const HEAD2 = "e".repeat(40);
const BOT = "codebleach[bot]";

interface SentCall {
  route: string;
  parameters: Record<string, unknown>;
}

function stubTransport(handler: (call: SentCall) => Promise<GitHubTransportResponse>): GitHubTransport & {
  calls: SentCall[];
} {
  const calls: SentCall[] = [];
  return {
    calls,
    send: (route, parameters) => {
      calls.push({ route, parameters });
      return handler({ route, parameters });
    },
  };
}

function ok(data: unknown): GitHubTransportResponse {
  return { status: 200, data, headers: {} };
}

function pullData(head: string): unknown {
  return { state: "open", base: { sha: BASE }, head: { sha: head } };
}

function commentItem(id: number, body: string, head: string): unknown {
  return {
    id,
    body,
    path: "src/a.ts",
    line: 10,
    commit_id: head,
    user: { login: BOT },
    in_reply_to_id: null,
  };
}

function changedFile(): ChangedFile {
  return {
    path: "src/a.ts",
    oldPath: null,
    status: "modified",
    language: "typescript",
    hunks: [],
    commentableLines: [10, 11, 12],
    symbols: [],
  };
}

function diffFor(head: string): DiffResult {
  return { baseSha: BASE, headSha: head, mergeBase: "m".repeat(40), files: [changedFile()] };
}

function metaFor(head: string): PrMeta {
  return { owner: OWNER, repo: REPO, number: NUM, baseSha: BASE, headSha: head };
}

function findingFor(head: string): AcceptedValidatedFinding {
  return {
    finding: {
      id: "finding-1",
      fingerprint: "fp-1",
      headSha: head,
      symbol: "resolveUser",
      origin: { pass: "test", unitId: "unit-1" },
      title: "Null dereference",
      severity: "high",
      category: "bug",
      file: "src/a.ts",
      line: 10,
      description: "The value can be null here.",
      confidence: 0.9,
      evidence: [{ file: "src/a.ts", startLine: 10, endLine: 10, quote: "user.name" }],
      introducedByPr: true,
    },
    status: "accepted",
    checks: [],
    derivedTarget: { file: "src/a.ts", line: 10, side: "RIGHT", kind: "added" },
    derivedAttribution: {
      introducedByPr: true,
      basis: { kind: "added-lines", evidenceIndex: 0, file: "src/a.ts", lines: [10] },
    },
  };
}

function expectedKey(): string {
  return computeMarkerKey({ owner: OWNER, repo: REPO, number: NUM, fingerprint: "fp-1" });
}

describe("github publisher integration", () => {
  test("publishes one comment pinned to head sha", async () => {
    const transport = stubTransport((call) => {
      if (call.route.startsWith("POST ")) return Promise.resolve(ok({ id: 101 }));
      if (call.route.includes("/comments")) return Promise.resolve(ok([]));
      if (call.route.startsWith("GET /user")) return Promise.resolve(ok({ login: BOT }));
      return Promise.resolve(ok(pullData(HEAD)));
    });
    const api = createGitHubClient({ token: "test-token", transport });
    const slept: number[] = [];
    const publisher = createGitHubPublisher({
      api,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    const result = await publisher.publish([findingFor(HEAD)], diffFor(HEAD), metaFor(HEAD), { reconcileStale: true });
    expect(result).toEqual({ published: 1, skipped: 0, failures: [], runFailures: [] });
    const posts = transport.calls.filter((call) => call.route.startsWith("POST "));
    expect(posts).toHaveLength(1);
    expect(posts[0]?.parameters).toMatchObject({
      owner: OWNER,
      repo: REPO,
      pull_number: NUM,
      commit_id: HEAD,
      path: "src/a.ts",
      line: 10,
      side: "RIGHT",
    });
    const body = posts[0]?.parameters.body;
    expect(typeof body === "string" && body.endsWith(`\n\n<!-- codebleach:finding:v1:${expectedKey()} -->`)).toBe(true);
    expect(slept).toEqual([]);
  });

  test("second run on same head dedupes without writes", async () => {
    const first = stubTransport((call) => {
      if (call.route.startsWith("POST ")) return Promise.resolve(ok({ id: 101 }));
      if (call.route.includes("/comments")) return Promise.resolve(ok([]));
      if (call.route.startsWith("GET /user")) return Promise.resolve(ok({ login: BOT }));
      return Promise.resolve(ok(pullData(HEAD)));
    });
    const firstApi = createGitHubClient({ token: "test-token", transport: first });
    const firstPublisher = createGitHubPublisher({ api: firstApi });
    await firstPublisher.publish([findingFor(HEAD)], diffFor(HEAD), metaFor(HEAD));
    const postedBody = first.calls.find((call) => call.route.startsWith("POST "))?.parameters.body as string;

    const second = stubTransport((call) => {
      if (call.route.startsWith("POST ")) return Promise.resolve(ok({ id: 102 }));
      if (call.route.includes("/comments")) return Promise.resolve(ok([commentItem(101, postedBody, HEAD)]));
      if (call.route.startsWith("GET /user")) return Promise.resolve(ok({ login: BOT }));
      return Promise.resolve(ok(pullData(HEAD)));
    });
    const secondApi = createGitHubClient({ token: "test-token", transport: second });
    const secondPublisher = createGitHubPublisher({ api: secondApi });
    const result = await secondPublisher.publish([findingFor(HEAD)], diffFor(HEAD), metaFor(HEAD));
    expect(result).toEqual({ published: 0, skipped: 1, failures: [], runFailures: [] });
    expect(second.calls.some((call) => call.route.startsWith("POST ") || call.route.startsWith("DELETE "))).toBe(false);
  });

  test("new head refreshes the marker and cleans up with pacing", async () => {
    const oldBody = `note\n\n<!-- codebleach:finding:v1:${expectedKey()} -->`;
    const transport = stubTransport((call) => {
      if (call.route.startsWith("POST ")) return Promise.resolve(ok({ id: 202 }));
      if (call.route.startsWith("DELETE ")) return Promise.resolve(ok({}));
      if (call.route.includes("/comments")) return Promise.resolve(ok([commentItem(101, oldBody, HEAD)]));
      if (call.route.startsWith("GET /user")) return Promise.resolve(ok({ login: BOT }));
      return Promise.resolve(ok(pullData(HEAD2)));
    });
    const api = createGitHubClient({ token: "test-token", transport });
    const slept: number[] = [];
    const publisher = createGitHubPublisher({
      api,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    const result = await publisher.publish([findingFor(HEAD2)], diffFor(HEAD2), metaFor(HEAD2), {
      reconcileStale: true,
    });
    expect(result).toEqual({ published: 1, skipped: 0, failures: [], runFailures: [] });
    const posts = transport.calls.filter((call) => call.route.startsWith("POST "));
    const deletes = transport.calls.filter((call) => call.route.startsWith("DELETE "));
    expect(posts).toHaveLength(1);
    expect(posts[0]?.parameters).toMatchObject({ commit_id: HEAD2 });
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.parameters).toMatchObject({ comment_id: 101 });
    expect(slept).toEqual([1000]);
  });

  test("failed post is never retried", async () => {
    let posts = 0;
    const transport = stubTransport((call) => {
      if (call.route.startsWith("POST ")) {
        posts += 1;
        return Promise.reject({ status: 500, headers: {} });
      }
      if (call.route.includes("/comments")) return Promise.resolve(ok([]));
      if (call.route.startsWith("GET /user")) return Promise.resolve(ok({ login: BOT }));
      return Promise.resolve(ok(pullData(HEAD)));
    });
    const api = createGitHubClient({ token: "test-token", transport });
    const publisher = createGitHubPublisher({ api });
    const result = await publisher.publish([findingFor(HEAD)], diffFor(HEAD), metaFor(HEAD));
    expect(posts).toBe(1);
    expect(result.runFailures).toEqual([{ code: "ambiguous_post_outcome", message: expect.any(String) }]);
  });
});
