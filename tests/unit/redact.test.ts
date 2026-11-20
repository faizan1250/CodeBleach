import { describe, expect, test } from "bun:test";
import { redact, sanitizePayload } from "../../src/utils/redact.ts";

describe("redact", () => {
  test("replaces exact secrets longest-first", () => {
    expect(redact("ab abc", ["ab", "abc"])).toBe("[REDACTED] [REDACTED]");
  });

  test("ignores empty secrets", () => {
    expect(redact("hello", [""])).toBe("hello");
  });

  test("redacts github tokens", () => {
    expect(redact("key ghp_abcDEF123 rest")).toBe("key [REDACTED] rest");
    expect(redact("key github_pat_abc_123 rest")).toBe("key [REDACTED] rest");
  });

  test("redacts api keys", () => {
    expect(redact("key sk-live-abcdef123456 rest")).toBe("key [REDACTED] rest");
  });

  test("redacts aws keys", () => {
    expect(redact("id AKIAIOSFODNN7EXAMPLE end")).toBe("id [REDACTED] end");
  });

  test("redacts bearer values", () => {
    expect(redact("auth Bearer abcDEF123._-~+/= end")).toBe("auth [REDACTED] end");
  });

  test("redacts pem blocks", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----";
    expect(redact(`a ${pem} b`)).toBe("a [REDACTED] b");
  });
});

describe("redact pre-send canaries", () => {
  test("redacts google api keys", () => {
    expect(redact("key AIzaSyD12345678901234567890123456789012 end")).toBe("key [REDACTED] end");
  });

  test("redacts slack tokens", () => {
    // Split literals: push protection rejects real-format token shapes.
    const bot = `${"xox"}b-123456789012-abcdefghijklmno`;
    const user = `${"xox"}p-abcDEF123456789`;
    expect(redact(`t ${bot} end`)).toBe("t [REDACTED] end");
    expect(redact(`t ${user} end`)).toBe("t [REDACTED] end");
  });

  test("redacts stripe keys", () => {
    expect(redact("k sk_live_abcDEF123456789 end")).toBe("k [REDACTED] end");
    expect(redact("k rk_test_xyz789ABCDEF end")).toBe("k [REDACTED] end");
    expect(redact("w whsec_abcDEF123456 end")).toBe("w [REDACTED] end");
  });

  test("redacts jwts", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(redact(`auth ${jwt} end`)).toBe("auth [REDACTED] end");
  });

  test("redacts basic auth values", () => {
    expect(redact("auth Basic dXNlcjpwYXNzd29yZA== end")).toBe("auth [REDACTED] end");
  });

  test("redacts database connection strings with credentials", () => {
    expect(redact("connect postgres://app:hunter2@db.internal:5432/appdb now")).toBe(
      "connect [REDACTED] now",
    );
    expect(redact("u mysql://app:hunter2@db:3306/app end")).toBe("u [REDACTED] end");
    expect(redact("u mongodb+srv://app:hunter2@cluster0.x/app end")).toBe("u [REDACTED] end");
  });

  test("leaves credential-less database urls in prose alone", () => {
    expect(redact("uses postgres://localhost/mydb locally")).toBe(
      "uses postgres://localhost/mydb locally",
    );
  });

  test("redacts database-url and phase-4 assignment keys", () => {
    expect(redact("DATABASE_URL=postgres://app:hunter2@db:5432/app")).toBe(
      "DATABASE_URL=[REDACTED]",
    );
    expect(redact("DATABASE_URL=postgres://localhost/mydb")).toBe("DATABASE_URL=[REDACTED]");
    expect(redact("PROD_DATABASE_URL=postgres://localhost/mydb")).toBe(
      "PROD_DATABASE_URL=[REDACTED]",
    );
    expect(redact("access_key=hunter2")).toBe("access_key=[REDACTED]");
    expect(redact("access_key=12345678")).toBe("access_key=[REDACTED]");
    expect(redact("credential: hunter2")).toBe("credential:[REDACTED]");
    expect(redact("signing_key=hunter2")).toBe("signing_key=[REDACTED]");
    expect(redact("webhook_secret=hunter2")).toBe("webhook_secret=[REDACTED]");
    expect(redact("passwd=hunter2")).toBe("passwd=[REDACTED]");
    expect(redact("connectionString: hunter2")).toBe("connectionString:[REDACTED]");
  });

  test("redacts secrets in url query strings", () => {
    expect(redact("https://x.test/cb?api_key=SECRET123&b=1")).toBe(
      "https://x.test/cb?api_key=[REDACTED]&b=1",
    );
    expect(redact("https://x.test/cb?a=1&token=SECRET123")).toBe(
      "https://x.test/cb?a=1&token=[REDACTED]",
    );
  });

  test("redacts generic sensitive assignments in env/yaml/json forms", () => {
    expect(redact("MY_SECRET=hunter2")).toBe("MY_SECRET=[REDACTED]");
    expect(redact("password: hunter2")).toBe("password:[REDACTED]");
    expect(redact('{"api_key": "abc123"}')).toBe('{"api_key":"[REDACTED]"}');
    expect(redact("OPENCODE_API_KEY=dummy")).toBe("OPENCODE_API_KEY=[REDACTED]");
  });

  test("redacts numeric-only values under whole-sensitive keys", () => {
    expect(redact("password: 123456")).toBe("password:[REDACTED]");
    expect(redact("api_key=12345678")).toBe("api_key=[REDACTED]");
    expect(redact('{"token": "987654"}')).toBe('{"token":"[REDACTED]"}');
  });

  test("leaves segment-only numeric values alone", () => {
    expect(redact("tokenCount: 12345")).toBe("tokenCount: 12345");
    expect(redact("MY_SECRET=hunter2")).toBe("MY_SECRET=[REDACTED]");
  });

  test("redaction is idempotent", () => {
    const samples = [
      "key AIzaSyD12345678901234567890123456789012 end",
      `t ${"xox"}b-123456789012-abcdefghijklmno end`,
      "k sk_live_abcDEF123456789 end",
      "https://x.test/cb?api_key=SECRET123&b=1",
      "MY_SECRET=hunter2",
      '{"api_key": "abc123"}',
      "auth Basic dXNlcjpwYXNzd29yZA== end",
      "connect postgres://app:hunter2@db.internal:5432/appdb now",
      "DATABASE_URL=postgres://localhost/mydb",
    ];
    for (const sample of samples) {
      expect(redact(redact(sample))).toBe(redact(sample));
    }
  });

  test("leaves telemetry and unrelated syntax alone", () => {
    expect(redact("usage inputTokens: 10 outputTokens: 5")).toBe(
      "usage inputTokens: 10 outputTokens: 5",
    );
    expect(redact("database: myapp")).toBe("database: myapp");
    expect(redact("url=https://example.com/x")).toBe("url=https://example.com/x");
    expect(redact("max_tokens: 50 max_tokens_per_unit: 12000")).toBe(
      "max_tokens: 50 max_tokens_per_unit: 12000",
    );
    expect(redact('{"a":1,"password":"hunter2","b":2}')).toBe(
      '{"a":1,"password":"[REDACTED]","b":2}',
    );
  });
});

describe("sanitizePayload", () => {
  test("redacts nested strings and arrays", () => {
    const out = sanitizePayload(
      { a: ["x ghp_secret123", { b: "ok" }], c: 1 },
      ["ghp_secret123"],
    );
    expect(out).toEqual({ a: ["x [REDACTED]", { b: "ok" }], c: 1 });
  });

  test("drops values under sensitive keys without pattern match", () => {
    const out = sanitizePayload({
      token: "plain-value",
      password: "hunter2",
      nested: { apiKey: "whatever", api_key: "x", authorization: "y", secret: "z", keep: "yes" },
    });
    expect(out).toEqual({
      token: "[REDACTED]",
      password: "[REDACTED]",
      nested: {
        apiKey: "[REDACTED]",
        api_key: "[REDACTED]",
        authorization: "[REDACTED]",
        secret: "[REDACTED]",
        keep: "yes",
      },
    });
  });

  test("drops string values under segment-sensitive keys, keeps telemetry numerics", () => {
    expect(sanitizePayload({ MY_SECRET: "hunter2" })).toEqual({ MY_SECRET: "[REDACTED]" });
    expect(sanitizePayload({ tokenCount: 3, nested: { MY_SECRET: "x" } })).toEqual({
      tokenCount: 3,
      nested: { MY_SECRET: "[REDACTED]" },
    });
  });

  test("drops database-url and credential keys", () => {
    expect(
      sanitizePayload({
        DATABASE_URL: "postgres://app:hunter2@db:5432/app",
        nested: { credential: "x", credentials: "y", signingKey: "z", access_key: "k" },
      }),
    ).toEqual({
      DATABASE_URL: "[REDACTED]",
      nested: {
        credential: "[REDACTED]",
        credentials: "[REDACTED]",
        signingKey: "[REDACTED]",
        access_key: "[REDACTED]",
      },
    });
  });

  test("serializes errors with redacted message", () => {
    const out = sanitizePayload({ err: new Error("failed with ghp_abc123") });
    expect(out).toMatchObject({ err: { name: "Error", message: "failed with [REDACTED]" } });
  });

  test("preserves shared references instead of flagging circular", () => {
    const shared = { path: "src/a.ts", secret: "ghp_abc123" };
    const out = sanitizePayload({ first: shared, second: shared, list: [shared] }) as Record<
      string,
      unknown
    >;
    expect(out["first"]).toEqual({ path: "src/a.ts", secret: "[REDACTED]" });
    expect(out["second"]).toEqual({ path: "src/a.ts", secret: "[REDACTED]" });
    expect(out["list"]).toEqual([{ path: "src/a.ts", secret: "[REDACTED]" }]);
    expect(JSON.stringify(out)).not.toContain("[Circular]");
  });

  test("flags true cycles as circular", () => {
    const node: Record<string, unknown> = { name: "root" };
    node["self"] = node;
    const out = sanitizePayload({ node }) as { node: { self: unknown } };
    expect(out.node.self).toBe("[Circular]");
  });

  test("flags indirect cycles through arrays", () => {
    const holder: Record<string, unknown> = { items: [] };
    (holder["items"] as unknown[]).push(holder);
    const out = sanitizePayload(holder) as { items: unknown[] };
    expect(out.items[0]).toBe("[Circular]");
  });

  test("preserves error code, retryable, and redacted cause", () => {
    const cause = new Error("inner ghp_abc123");
    const err = new Error("outer failed");
    Object.assign(err, { code: "PROVIDER_FAILED", retryable: true });
    err.cause = cause;
    const out = sanitizePayload({ err }) as {
      err: { code: unknown; retryable: unknown; cause: { message: unknown } };
    };
    expect(out.err.code).toBe("PROVIDER_FAILED");
    expect(out.err.retryable).toBe(true);
    expect(out.err.cause.message).toBe("inner [REDACTED]");
  });

  test("flags self-caused errors as circular cause", () => {
    const err = new Error("loop");
    err.cause = err;
    const out = sanitizePayload({ err }) as { err: { cause: unknown } };
    expect(out.err.cause).toBe("[Circular]");
  });

  test("preserves usage and token-count telemetry keys", () => {
    const payload = {
      usage: { inputTokens: 10, outputTokens: 5 },
      maxTokens: 100,
      max_tokens: 50,
      tokenCount: 3,
      totalTokens: 15,
    };
    expect(sanitizePayload(payload)).toEqual(payload);
  });

  test("redacts sensitive key variants across separators and casing", () => {
    const out = sanitizePayload({
      apiKey: "k1",
      api_key: "k2",
      OPENCODE_API_KEY: "k3",
      "API-KEY": "k4",
      accessToken: "t1",
      access_token: "t2",
      refreshToken: "t3",
      password: "p1",
      Password: "p2",
      SECRET: "s1",
      clientSecret: "c1",
      "client-secret": "c2",
      authorization: "a1",
      Authorization: "a2",
      privateKey: "pem1",
      private_key: "pem2",
      nested: { Access_Token: "x", keep: "yes" },
      list: [{ REFRESH_TOKEN: "y" }],
    });
    expect(out).toEqual({
      apiKey: "[REDACTED]",
      api_key: "[REDACTED]",
      OPENCODE_API_KEY: "[REDACTED]",
      "API-KEY": "[REDACTED]",
      accessToken: "[REDACTED]",
      access_token: "[REDACTED]",
      refreshToken: "[REDACTED]",
      password: "[REDACTED]",
      Password: "[REDACTED]",
      SECRET: "[REDACTED]",
      clientSecret: "[REDACTED]",
      "client-secret": "[REDACTED]",
      authorization: "[REDACTED]",
      Authorization: "[REDACTED]",
      privateKey: "[REDACTED]",
      private_key: "[REDACTED]",
      nested: { Access_Token: "[REDACTED]", keep: "yes" },
      list: [{ REFRESH_TOKEN: "[REDACTED]" }],
    });
  });
});
