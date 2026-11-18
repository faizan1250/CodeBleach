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
});
