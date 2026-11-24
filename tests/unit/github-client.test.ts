import { describe, expect, test } from "bun:test";
import { GitHubApiError, createGitHubClient, resolveGitHubToken } from "../../src/github/client.ts";
import type { GitHubTransport, GitHubTransportResponse } from "../../src/github/client.ts";

interface SentCall {
  route: string;
  parameters: Record<string, unknown>;
}

function stubTransport(
  handler: (call: SentCall) => Promise<GitHubTransportResponse>,
): GitHubTransport & { calls: SentCall[] } {
  const calls: SentCall[] = [];
  return {
    calls,
    send: (route, parameters) => {
      calls.push({ route, parameters });
      return handler({ route, parameters });
    },
  };
}

function ok(data: unknown, headers: Record<string, string> = {}): GitHubTransportResponse {
  return { status: 200, data, headers };
}

function httpError(status: number, headers: Record<string, string> = {}): unknown {
  return { status, headers, message: `RAW-BODY-${status}-must-never-surface` };
}

const BASE = "b".repeat(40);
const HEAD = "h".repeat(40);

function pullData(): unknown {
  return { state: "open", base: { sha: BASE }, head: { sha: HEAD } };
}

function commentItem(id: number, overrides: Record<string, unknown> = {}): unknown {
  return {
    id,
    body: `note <!-- codebleach:finding:v1:key${id} -->`,
    path: "src/a.ts",
    line: 10,
    commit_id: HEAD,
    user: { login: "codebleach[bot]" },
    in_reply_to_id: null,
    ...overrides,
  };
}

function commentPage(ids: number[]): unknown {
  return ids.map((id) => commentItem(id));
}

function clientWith(
  handler: (call: SentCall) => Promise<GitHubTransportResponse>,
  extra: { now?: () => number } = {},
): { api: ReturnType<typeof createGitHubClient>; transport: GitHubTransport & { calls: SentCall[] }; slept: number[] } {
  const transport = stubTransport(handler);
  const slept: number[] = [];
  const api = createGitHubClient({
    token: "test-token",
    transport,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    now: extra.now ?? (() => 1_000_000),
  });
  return { api, transport, slept };
}

describe("github client construction", () => {
  test("rejects blank token", () => {
    for (const token of ["", "   "]) {
      expect(() => createGitHubClient({ token, transport: stubTransport(() => Promise.resolve(ok([]))) })).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }),
      );
    }
  });

  test("rejects non-positive timeout", () => {
    expect(() =>
      createGitHubClient({ token: "t", timeoutMs: 0, transport: stubTransport(() => Promise.resolve(ok([]))) }),
    ).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  test("constructs without network", () => {
    const transport = stubTransport(() => Promise.resolve(ok(pullData())));
    createGitHubClient({ token: "test-token", transport });
    expect(transport.calls).toEqual([]);
    // Real Octokit construction also performs no requests.
    createGitHubClient({ token: "test-token" });
  });

  test("reads token from env", () => {
    expect(resolveGitHubToken({})).toBeUndefined();
    expect(resolveGitHubToken({ GITHUB_TOKEN: "   " })).toBeUndefined();
    expect(resolveGitHubToken({ GITHUB_TOKEN: "  abc  " })).toBe("abc");
  });
});

describe("github client pull request", () => {
  test("returns snapshot on success", async () => {
    const { api, transport } = clientWith(() => Promise.resolve(ok(pullData())));
    await expect(api.getPullRequest({ owner: "o", repo: "r", number: 1 })).resolves.toEqual({
      owner: "o",
      repo: "r",
      number: 1,
      state: "open",
      baseSha: BASE,
      headSha: HEAD,
    });
    expect(transport.calls).toEqual([
      {
        route: "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        parameters: { owner: "o", repo: "r", pull_number: 1 },
      },
    ]);
  });

  test("rejects invalid identity before network", async () => {
    const { api, transport } = clientWith(() => Promise.resolve(ok(pullData())));
    await expect(api.getPullRequest({ owner: "", repo: "r", number: 1 })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    await expect(api.getPullRequest({ owner: "o", repo: "r", number: 0 })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    expect(transport.calls).toEqual([]);
  });

  test("maps missing pull request", async () => {
    const { api } = clientWith(() => Promise.reject(httpError(404)));
    const error = await api.getPullRequest({ owner: "o", repo: "r", number: 9 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ code: "GITHUB_FAILED", status: 404, runFailure: { code: "pr_identity_mismatch" } });
    expect((error as GitHubApiError).message).not.toContain("RAW-BODY");
  });

  test("maps auth failure without retry or leak", async () => {
    const { api, transport, slept } = clientWith(() => Promise.reject(httpError(401)));
    const error = await api.getPullRequest({ owner: "o", repo: "r", number: 1 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ runFailure: { code: "permission_denied" } });
    expect(transport.calls).toHaveLength(1);
    expect(slept).toEqual([]);
    expect((error as GitHubApiError).message).not.toContain("RAW-BODY");
    expect((error as GitHubApiError).message).not.toContain("test-token");
  });

  test("plain forbidden is permissions, not rate limit", async () => {
    const { api, transport } = clientWith(() => Promise.reject(httpError(403)));
    const error = await api.getPullRequest({ owner: "o", repo: "r", number: 1 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ runFailure: { code: "permission_denied" } });
    expect(transport.calls).toHaveLength(1);
  });

  test("rejects malformed pull payload", async () => {
    const { api } = clientWith(() => Promise.resolve(ok({ state: "open", base: { sha: BASE } })));
    await expect(api.getPullRequest({ owner: "o", repo: "r", number: 1 })).rejects.toMatchObject({ code: "INTERNAL" });
  });
});

describe("github client get retry", () => {
  test("retries 503 with 1s then 2s backoff", async () => {
    let attempts = 0;
    const { api, slept } = clientWith(() => {
      attempts += 1;
      return attempts < 3 ? Promise.reject(httpError(503)) : Promise.resolve(ok(pullData()));
    });
    await expect(api.getPullRequest({ owner: "o", repo: "r", number: 1 })).resolves.toMatchObject({ headSha: HEAD });
    expect(attempts).toBe(3);
    expect(slept).toEqual([1000, 2000]);
  });

  test("non-retryable 500 maps to unavailable", async () => {
    const { api, transport, slept } = clientWith(() => Promise.reject(httpError(500)));
    const error = await api.getPullRequest({ owner: "o", repo: "r", number: 1 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ runFailure: { code: "github_unavailable" } });
    expect(transport.calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  test("honors retry-after within budget", async () => {
    let attempts = 0;
    const { api, slept } = clientWith(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(httpError(429, { "retry-after": "1" })) : Promise.resolve(ok(pullData()));
    });
    await expect(api.getPullRequest({ owner: "o", repo: "r", number: 1 })).resolves.toMatchObject({ headSha: HEAD });
    expect(slept).toEqual([1000]);
  });

  test("oversized retry-after stops with rate limited", async () => {
    const { api, transport, slept } = clientWith(() => Promise.reject(httpError(429, { "retry-after": "60" })));
    const error = await api.getPullRequest({ owner: "o", repo: "r", number: 1 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ runFailure: { code: "rate_limited" } });
    expect(transport.calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  test("honors rate-limit reset timestamp", async () => {
    let attempts = 0;
    const { api, slept } = clientWith(
      () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(httpError(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1005" }))
          : Promise.resolve(ok(pullData()));
      },
      { now: () => 1_000_000 },
    );
    await expect(api.getPullRequest({ owner: "o", repo: "r", number: 1 })).resolves.toMatchObject({ headSha: HEAD });
    expect(slept).toEqual([5000]);
  });

  test("retries abort timeouts, then gives up", async () => {
    let attempts = 0;
    const { api, slept } = clientWith(() => {
      attempts += 1;
      return attempts < 3 ? Promise.reject({ name: "AbortError" }) : Promise.resolve(ok(pullData()));
    });
    await expect(api.getPullRequest({ owner: "o", repo: "r", number: 1 })).resolves.toMatchObject({ headSha: HEAD });
    expect(slept).toEqual([1000, 2000]);

    const failing = clientWith(() => Promise.reject({ name: "AbortError" }));
    const error = await failing.api.getPullRequest({ owner: "o", repo: "r", number: 1 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ runFailure: { code: "github_unavailable" } });
    expect(failing.slept).toEqual([1000, 2000]);
  });
});

describe("github client review comments", () => {
  test("paginates until short page", async () => {
    const full = commentPage(Array.from({ length: 100 }, (_, i) => i + 1));
    const { api, transport } = clientWith(({ parameters }) => {
      const page = parameters.page as number;
      if (page === 1 || page === 2) return Promise.resolve(ok(full));
      return Promise.resolve(ok(commentPage([201, 202])));
    });
    const comments = await api.listReviewComments({ owner: "o", repo: "r", number: 1 });
    expect(comments).toHaveLength(202);
    expect(transport.calls.map((call) => call.parameters.page)).toEqual([1, 2, 3]);
    expect(transport.calls[0]?.parameters.per_page).toBe(100);
    expect(comments[0]).toMatchObject({
      id: 1,
      path: "src/a.ts",
      line: 10,
      commitId: HEAD,
      authorLogin: "codebleach[bot]",
    });
  });

  test("caps inventory at twenty full pages", async () => {
    const full = commentPage(Array.from({ length: 100 }, (_, i) => i + 1));
    const { api, transport } = clientWith(() => Promise.resolve(ok(full)));
    const error = await api.listReviewComments({ owner: "o", repo: "r", number: 1 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ runFailure: { code: "comment_inventory_incomplete" } });
    expect(transport.calls).toHaveLength(20);
  });

  test("preserves reply links and unknown authors", async () => {
    const { api } = clientWith(() =>
      Promise.resolve(ok([commentItem(7, { user: null, in_reply_to_id: 3, path: null, line: null })])),
    );
    await expect(api.listReviewComments({ owner: "o", repo: "r", number: 1 })).resolves.toEqual([
      expect.objectContaining({ id: 7, authorLogin: null, inReplyToId: 3, path: null, line: null }),
    ]);
  });

  test("rejects malformed inventory", async () => {
    const { api } = clientWith(() => Promise.resolve(ok([{ nope: true }])));
    await expect(api.listReviewComments({ owner: "o", repo: "r", number: 1 })).rejects.toMatchObject({
      code: "INTERNAL",
    });
  });
});

describe("github client authenticated user", () => {
  test("returns login", async () => {
    const { api, transport } = clientWith(() => Promise.resolve(ok({ login: "codebleach[bot]" })));
    await expect(api.getAuthenticatedLogin()).resolves.toBe("codebleach[bot]");
    expect(transport.calls).toEqual([{ route: "GET /user", parameters: {} }]);
  });

  test("rejects malformed user payload", async () => {
    const { api } = clientWith(() => Promise.resolve(ok({ login: "" })));
    await expect(api.getAuthenticatedLogin()).rejects.toMatchObject({ code: "INTERNAL" });
  });
});
