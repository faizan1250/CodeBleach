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

  test("leaves exact-key telemetry numerics alone", () => {
    expect(redact("tokenCount: 12345")).toBe("tokenCount: 12345");
    expect(redact("usage inputTokens: 10 outputTokens: 5")).toBe(
      "usage inputTokens: 10 outputTokens: 5",
    );
    expect(redact("MY_SECRET=hunter2")).toBe("MY_SECRET=[REDACTED]");
  });

  test("redacts numeric-only values under compound sensitive keys", () => {
    expect(redact("DB_PASSWORD=123456")).toBe("DB_PASSWORD=[REDACTED]");
    expect(redact("POSTGRES_PASSWORD=987654321")).toBe("POSTGRES_PASSWORD=[REDACTED]");
    expect(redact("MY_SECRET=123456789")).toBe("MY_SECRET=[REDACTED]");
    expect(redact("DB_TOKEN=123456")).toBe("DB_TOKEN=[REDACTED]");
    expect(redact('SERVICE_PASSWORD="123456"')).toBe('SERVICE_PASSWORD="[REDACTED]"');
    expect(redact('SECRET_KEY="false"')).toBe('SECRET_KEY="[REDACTED]"');
    expect(redact("MY_SECRET=123456")).toBe("MY_SECRET=[REDACTED]");
  });

  test("redacts boolean-like values under whole-sensitive keys", () => {
    expect(redact("PASSWORD=true")).toBe("PASSWORD=[REDACTED]");
    expect(redact("API_SECRET=false")).toBe("API_SECRET=[REDACTED]");
    expect(redact("password: null")).toBe("password:[REDACTED]");
  });

  test("redacts numeric secrets across json/yaml/query forms", () => {
    expect(redact('{"db_password": "123456"}')).toBe('{"db_password":"[REDACTED]"}');
    expect(redact("db_password: 123456")).toBe("db_password:[REDACTED]");
    expect(redact("https://x.test/cb?db_password=123456&b=1")).toBe(
      "https://x.test/cb?db_password=[REDACTED]&b=1",
    );
    expect(redact("https://x.test/cb?a=1&password=true")).toBe(
      "https://x.test/cb?a=1&password=[REDACTED]",
    );
  });

  test("redacts multi-line mixed assignments, preserves ordinary numerics", () => {
    const input = "DB_PASSWORD=123456\nretries=3\nport=5432\ntokenCount=42";
    expect(redact(input)).toBe("DB_PASSWORD=[REDACTED]\nretries=3\nport=5432\ntokenCount=42");
  });

  test("numeric redaction is idempotent and keeps surrounding syntax", () => {
    for (const sample of [
      "DB_PASSWORD=123456",
      'SERVICE_PASSWORD="123456"',
      "PASSWORD=true",
      "db_password: 123456",
      "https://x.test/cb?db_password=123456&b=1",
    ]) {
      const once = redact(sample);
      expect(once).toContain("[REDACTED]");
      expect(redact(once)).toBe(once);
    }
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

describe("redact spaced and escaped quoted values", () => {
  test("redacts spaced double-quoted values with balanced quotes", () => {
    expect(redact('PASSWORD="correct horse battery staple"')).toBe('PASSWORD="[REDACTED]"');
  });

  test("redacts spaced single-quoted values with balanced quotes", () => {
    expect(redact("API_KEY='secret value with spaces'")).toBe("API_KEY='[REDACTED]'");
  });

  test("redacts quoted values across env/json/yaml/ts forms", () => {
    expect(redact('{"password": "a b c", "user": "bob"}')).toBe(
      '{"password":"[REDACTED]", "user": "bob"}',
    );
    expect(redact('password: "hunter two"')).toBe('password:"[REDACTED]"');
    expect(redact('const password = "hunter two"')).toBe('const password="[REDACTED]"');
    expect(redact('USER=bob PASSWORD="correct horse battery staple" TOKEN=abc123')).toBe(
      'USER=bob PASSWORD="[REDACTED]" TOKEN=[REDACTED]',
    );
  });

  test("redacts escaped-quote values without leaking", () => {
    expect(redact('PASSWORD=\\"secret\\"')).toBe('PASSWORD=\\"[REDACTED]\\"');
    const spaced = redact('PASSWORD=\\"correct horse battery\\"');
    expect(spaced).toBe('PASSWORD=\\"[REDACTED]\\"');
    expect(spaced).not.toContain("correct");
  });

  test("leaves quoted prose alone", () => {
    expect(redact('cache key="some prose with spaces"')).toBe('cache key="some prose with spaces"');
    expect(redact('message: "hello world"')).toBe('message: "hello world"');
  });

  test("spaced redaction is idempotent", () => {
    const sample = 'PASSWORD="correct horse battery staple" TOKEN=abc123';
    expect(redact(redact(sample))).toBe(redact(sample));
  });
});

describe("redact uri and cloud key coverage", () => {
  test("redacts mongodb/redis/db urls even without embedded credentials", () => {
    expect(redact("MONGODB_URI=mongodb://app:hunter2@host/db")).toBe("MONGODB_URI=[REDACTED]");
    expect(redact("MONGODB_URI=mongodb://localhost:27017/app")).toBe("MONGODB_URI=[REDACTED]");
    expect(redact("PROD_MONGODB_URI=mongodb://localhost:27017/app")).toBe(
      "PROD_MONGODB_URI=[REDACTED]",
    );
    expect(redact("REDIS_URL=redis://localhost:6379")).toBe("REDIS_URL=[REDACTED]");
    expect(redact("DB_URL=postgres://app:hunter2@db:5432/app")).toBe("DB_URL=[REDACTED]");
  });

  test("redacts azure account keys bare and in connection strings", () => {
    expect(redact("AccountKey=c2VjcmV0a2V5dm9ybGQ=")).toBe("AccountKey=[REDACTED]");
    expect(redact("accountKey=c2VjcmV0a2V5dm9ybGQ=")).toBe("accountKey=[REDACTED]");
    const conn = redact(
      "DefaultEndpointsProtocol=https;AccountName=x;AccountKey=s3cr3t-value",
    );
    expect(conn).toBe("DefaultEndpointsProtocol=https;AccountName=x;AccountKey=[REDACTED]");
    expect(conn).not.toContain("s3cr3t-value");
  });

  test("redacts ado-style server connection strings with no partial leak", () => {
    const out = redact("ConnectionString=Server=h;User ID=u;Password=s3cr3t-value");
    expect(out).not.toContain("s3cr3t-value");
    expect(out).toBe("ConnectionString=[REDACTED];User ID=u;Password=[REDACTED]");
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
    expect(sanitizePayload({ MY_SECRET: "123456789" })).toEqual({ MY_SECRET: "[REDACTED]" });
    expect(sanitizePayload({ tokenCount: 3, nested: { MY_SECRET: "x" } })).toEqual({
      tokenCount: 3,
      nested: { MY_SECRET: "[REDACTED]" },
    });
  });

  test("drops numeric and boolean values under sensitive keys in objects", () => {
    expect(sanitizePayload({ DB_PASSWORD: 123456 })).toEqual({ DB_PASSWORD: "[REDACTED]" });
    expect(sanitizePayload({ DB_PASSWORD: "123456" })).toEqual({ DB_PASSWORD: "[REDACTED]" });
    expect(sanitizePayload({ PASSWORD: true })).toEqual({ PASSWORD: "[REDACTED]" });
    expect(sanitizePayload({ API_SECRET: false })).toEqual({ API_SECRET: "[REDACTED]" });
    expect(sanitizePayload({ nested: { SERVICE_PASSWORD: "123456" } })).toEqual({
      nested: { SERVICE_PASSWORD: "[REDACTED]" },
    });
  });

  test("string, object, and query paths agree on numeric secrets", () => {
    expect(redact("DB_PASSWORD=123456")).toContain("[REDACTED]");
    expect(sanitizePayload({ DB_PASSWORD: "123456" })).toEqual({ DB_PASSWORD: "[REDACTED]" });
    expect(redact("https://x.test/cb?db_password=123456")).toContain("db_password=[REDACTED]");
    expect(redact("tokenCount: 12345")).toBe("tokenCount: 12345");
    expect(sanitizePayload({ tokenCount: 12345 })).toEqual({ tokenCount: 12345 });
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

  test("drops mongodb/redis/accountkey/db-url keys", () => {
    expect(
      sanitizePayload({
        MONGODB_URI: "mongodb://app:hunter2@host/db",
        REDIS_URL: "redis://localhost:6379",
        DB_URL: "postgres://app:hunter2@db:5432/app",
        AccountKey: "s3cr3t-value",
        nested: { accountKey: "s3cr3t-value", keep: "yes" },
      }),
    ).toEqual({
      MONGODB_URI: "[REDACTED]",
      REDIS_URL: "[REDACTED]",
      DB_URL: "[REDACTED]",
      AccountKey: "[REDACTED]",
      nested: { accountKey: "[REDACTED]", keep: "yes" },
    });
  });

  test("keeps numeric secrets out of request/error/diagnostic/artifact shapes", () => {
    const dbPass = "771234";
    const pgPass = "987654321";
    const mySecret = "556789123";
    const request = {
      system: "prompt",
      user: redact(
        `diff line DB_PASSWORD=${dbPass} plus POSTGRES_PASSWORD=${pgPass} and MY_SECRET=${mySecret}`,
      ),
    };
    const err = sanitizePayload({
      err: new Error(`boom DB_PASSWORD=${dbPass} at PASSWORD=true`),
    });
    const diagnostics = sanitizePayload({ DB_PASSWORD: dbPass, PASSWORD: true, note: "plain" });
    const query = redact(`https://x.test/cb?db_password=${dbPass}&b=1`);
    const artifact = sanitizePayload({
      units: [{ file: "a.ts", diff: `MY_SECRET=${mySecret}` }],
      config: { POSTGRES_PASSWORD: pgPass },
      usage: { inputTokens: 10, outputTokens: 5, tokenCount: 100 },
    });
    for (const surface of [request, err, diagnostics, query, artifact]) {
      const serialized = JSON.stringify(surface);
      expect(serialized).not.toContain(dbPass);
      expect(serialized).not.toContain(pgPass);
      expect(serialized).not.toContain(mySecret);
      expect(serialized).not.toContain("PASSWORD=true");
    }
    expect(JSON.stringify(request)).toContain("[REDACTED]");
    expect(JSON.stringify(artifact)).toContain("[REDACTED]");
    // Telemetry survives the same pipeline untouched.
    const usage = (artifact as { usage: unknown }).usage;
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 5, tokenCount: 100 });
  });

  test("preserves briefing telemetry values verbatim", () => {
    expect(redact("inputTokens=123456")).toBe("inputTokens=123456");
    expect(redact("outputTokens=987654")).toBe("outputTokens=987654");
    expect(redact("tokenCount=100")).toBe("tokenCount=100");
    expect(sanitizePayload({ inputTokens: 123456, outputTokens: 987654, tokenCount: 100 })).toEqual(
      { inputTokens: 123456, outputTokens: 987654, tokenCount: 100 },
    );
  });
  test("keeps synthetic secrets out of request/error/diagnostic/artifact shapes", () => {
    const spaced = "correct horse battery staple";
    const connSecret = "s3cr3t-value";
    const request = {
      system: "prompt",
      user: redact(`diff line PASSWORD="${spaced}" plus MONGODB_URI=mongodb://a:${connSecret}@h/d`),
    };
    const err = sanitizePayload({ err: new Error(`boom PASSWORD="${spaced}" at AccountKey=${connSecret}`) });
    const diagnostics = sanitizePayload({ password: spaced, note: "plain" });
    const artifact = sanitizePayload({
      units: [{ file: "a.ts", diff: `PASSWORD="${spaced}"` }],
      config: { MONGODB_URI: `mongodb://a:${connSecret}@h/d` },
    });
    for (const surface of [request, err, diagnostics, artifact]) {
      const serialized = JSON.stringify(surface);
      expect(serialized).not.toContain(spaced);
      expect(serialized).not.toContain(connSecret);
    }
    expect(JSON.stringify(request)).toContain("[REDACTED]");
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

  test("drops containers under segment-sensitive keys whole-value", () => {
    expect(sanitizePayload({ DB_PASSWORD: ["hunter2"] })).toEqual({ DB_PASSWORD: "[REDACTED]" });
    expect(sanitizePayload({ DB_PASSWORD: { value: "hunter2" } })).toEqual({
      DB_PASSWORD: "[REDACTED]",
    });
    expect(sanitizePayload({ MY_SECRET: { nested: { deep: "hunter2" } } })).toEqual({
      MY_SECRET: "[REDACTED]",
    });
    expect(sanitizePayload({ DB_TOKEN: [["a"], [{ value: "b" }]] })).toEqual({
      DB_TOKEN: "[REDACTED]",
    });
    expect(sanitizePayload({ MY_SECRET: { value: "a", data: "b" } })).toEqual({
      MY_SECRET: "[REDACTED]",
    });
    expect(sanitizePayload({ DB_PASSWORD: ["hunter2", "benign", 123, { v: "x" }, true] })).toEqual(
      { DB_PASSWORD: "[REDACTED]" },
    );
  });

  test("drops numeric/boolean containers under segment keys, keeps benign recursion", () => {
    expect(sanitizePayload({ DB_PASSWORD: [123456] })).toEqual({ DB_PASSWORD: "[REDACTED]" });
    expect(sanitizePayload({ DB_PASSWORD: { retry: true } })).toEqual({
      DB_PASSWORD: "[REDACTED]",
    });
    expect(sanitizePayload({ MY_SECRET: { count: 42, flag: false } })).toEqual({
      MY_SECRET: "[REDACTED]",
    });
    expect(
      sanitizePayload({ config: { port: 5432, nested: { MY_SECRET: "x", keep: "yes" } } }),
    ).toEqual({ config: { port: 5432, nested: { MY_SECRET: "[REDACTED]", keep: "yes" } } });
  });

  test("container redaction is idempotent and leak-free serialized", () => {
    const once = sanitizePayload({
      DB_PASSWORD: ["hunter2"],
      nested: { MY_SECRET: { value: "hunter2" } },
    });
    expect(once).toEqual({ DB_PASSWORD: "[REDACTED]", nested: { MY_SECRET: "[REDACTED]" } });
    expect(sanitizePayload(once)).toEqual(once);
    expect(JSON.stringify(once)).not.toContain("hunter2");
  });

  test("redacts leading-acronym keys on object path", () => {
    for (const key of [
      "DBPassword",
      "DBToken",
      "DBSecret",
      "APISecret",
      "AWSSecret",
      "HTTPAuthToken",
      "OAuthClientSecret",
    ]) {
      expect(sanitizePayload({ [key]: "hunter2" })).toEqual({ [key]: "[REDACTED]" });
      expect(sanitizePayload({ [key]: ["hunter2"] })).toEqual({ [key]: "[REDACTED]" });
      expect(sanitizePayload({ [key]: { value: "hunter2" } })).toEqual({ [key]: "[REDACTED]" });
    }
  });

  test("redacts leading-acronym keys on text and query paths", () => {
    for (const key of [
      "DBPassword",
      "DBToken",
      "DBSecret",
      "APISecret",
      "AWSSecret",
      "HTTPAuthToken",
      "OAuthClientSecret",
    ]) {
      expect(redact(`${key}=hunter2`)).toBe(`${key}=[REDACTED]`);
      expect(redact(`https://x.test/cb?${key}=hunter2&b=1`)).toBe(
        `https://x.test/cb?${key}=[REDACTED]&b=1`,
      );
    }
  });

  test("leaves ordinary acronym-adjacent identifiers alone", () => {
    expect(
      sanitizePayload({
        DB: "x",
        database: "myapp",
        APIClient: "y",
        HTTPClient: "z",
        AWSRegion: "us-east-1",
        dbHost: "localhost",
      }),
    ).toEqual({
      DB: "x",
      database: "myapp",
      APIClient: "y",
      HTTPClient: "z",
      AWSRegion: "us-east-1",
      dbHost: "localhost",
    });
    expect(redact("database: myapp")).toBe("database: myapp");
    expect(redact("APIClient=y")).toBe("APIClient=y");
    expect(redact("dbHost=localhost")).toBe("dbHost=localhost");
  });
});
