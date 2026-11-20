import { describe, expect, test } from "bun:test";
import { MAX_LLM_MAX_OUTPUT_TOKENS } from "../../src/config/defaults.ts";
import { ConfigFileSchema, type ResolvedConfig } from "../../src/config/schema.ts";
import { ReviewerError } from "../../src/core/errors.ts";
import type { Logger } from "../../src/core/logger.ts";
import {
  API_KEY_ENV,
  FIXED_MODEL_ID,
  TRAINING_OPT_IN_ENV,
} from "../../src/llm/constants.ts";
import { FakeProvider } from "../../src/providers/fake.ts";
import { OpenCodeProvider } from "../../src/providers/opencode.ts";
import { ReviewEngineImpl } from "../../src/review/engine.ts";
import type { ReviewUnit } from "../../src/types/context.ts";
import type { Rule } from "../../src/types/rules.ts";

const OPT_IN = { CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING: "true" };
const GATE = { ...OPT_IN, [API_KEY_ENV]: "dummy-key" };

function nullLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function rule(overrides: Partial<Rule> & { id: string }): Rule {
  return { kind: "security", text: `rule text for ${overrides.id}`, ...overrides };
}

function unit(overrides: Partial<ReviewUnit> = {}): ReviewUnit {
  return {
    id: "unit-1",
    file: {
      path: "src/auth.ts",
      oldPath: null,
      status: "modified",
      language: "typescript",
      commentableLines: [10, 11, 12],
    },
    diff: {
      hunks: [
        {
          oldStart: 8,
          oldLines: 5,
          newStart: 8,
          newLines: 5,
          lines: [
            { kind: "ctx", oldLine: 8, newLine: 8, position: 0, text: "export function check(" },
            { kind: "del", oldLine: 9, newLine: null, position: 1, text: "if (user) return true;" },
            { kind: "add", oldLine: null, newLine: 9, position: 2, text: "if (user != null) return true;" },
          ],
        },
      ],
      originalHunkCount: 1,
      includedHunkCount: 1,
      omittedHunkCount: 0,
      truncated: false,
    },
    symbol: {
      name: "check",
      kind: "function",
      container: "auth",
      startLine: 8,
      endLine: 14,
      changedLines: [9],
    },
    context: [
      {
        id: "ctx-1",
        kind: "definition",
        file: "src/auth.ts",
        startLine: 1,
        endLine: 7,
        text: "import { User } from './user';",
        score: 0.9,
        tokens: 12,
        reason: "defines User used below",
      },
    ],
    rules: [rule({ id: "no-truthy-auth", text: "Never use truthiness for auth checks." })],
    ...overrides,
  };
}

function rawFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Null dereference on name",
    severity: "high",
    category: "null-handling",
    file: "src/auth.ts",
    line: 9,
    description: "name may be null at runtime; trim would throw.",
    confidence: 0.9,
    evidence: [{ file: "src/auth.ts", startLine: 9, endLine: 9, quote: "name.trim()" }],
    introducedByPr: true,
    ...overrides,
  };
}

function configWith(llm: Record<string, number> = {}): ResolvedConfig {
  return ConfigFileSchema.parse({ llm });
}

// Mirrors the OpenCodeProvider incomplete envelope message shape (P4-02
// precedent: reason preserved in the message, never JSON-repaired).
function incompleteError(reason: string): ReviewerError {
  return new ReviewerError({ code: "PROVIDER_FAILED", message: `provider response incomplete: ${reason}` });
}

describe("review output repair policy", () => {
  test("accepts empty findings without repair", async () => {
    const provider = new FakeProvider([{ respond: { findings: [] } }]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    await expect(engine.review([unit()], configWith())).resolves.toEqual([]);
    expect(provider.calls).toHaveLength(1);
  });

  test("parses markdown-fenced json without repair", async () => {
    const provider = new FakeProvider([{ respond: '```json\n{"findings":[]}\n```' }]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    await expect(engine.review([unit()], configWith())).resolves.toEqual([]);
    expect(provider.calls).toHaveLength(1);
  });

  test("repairs malformed json exactly once", async () => {
    const provider = new FakeProvider([{ respond: "not json" }, { respond: { findings: [rawFinding()] } }]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    const findings = await engine.review([unit()], configWith());
    expect(findings).toHaveLength(1);
    expect(provider.calls).toHaveLength(2);
  });

  test("discards the unit when repair fails", async () => {
    const provider = new FakeProvider([{ respond: "garbage" }, { respond: "still garbage" }]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    await expect(engine.review([unit()], configWith())).resolves.toEqual([]);
    expect(provider.calls).toHaveLength(2);
  });

  test("marks the unit partial when repair throws", async () => {
    const provider = new FakeProvider([
      { respond: "not json" },
      { respond: new Error("socket hangup") },
    ]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    await expect(engine.review([unit()], configWith())).resolves.toEqual([]);
    expect(provider.calls).toHaveLength(2);
  });

  test("rejects model-supplied ids and keeps code-owned metadata", async () => {
    const provider = new FakeProvider([
      { respond: { findings: [rawFinding({ id: "m1", fingerprint: "deadbeef", headSha: "evil", origin: {} })] } },
      { respond: { findings: [rawFinding()] } },
    ]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN }, headSha: "head-abc" });
    const [finding] = await engine.review([unit({ id: "u-9" })], configWith());
    expect(provider.calls).toHaveLength(2);
    expect(finding!.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    expect(finding!.fingerprint).not.toBe("deadbeef");
    expect(finding!.origin).toEqual({ pass: "code-review-v1", unitId: "u-9" });
    expect(finding!.headSha).toBe("head-abc");
  });

  test("rejects malformed findings with one repair then partial", async () => {
    const variants: Record<string, unknown>[] = [
      (() => {
        const v = rawFinding();
        delete v["title"];
        return v;
      })(),
      rawFinding({ severity: "blocker" }),
      rawFinding({ category: "style" }),
      rawFinding({ confidence: 2 }),
      rawFinding({ confidence: -0.5 }),
      rawFinding({ evidence: [] }),
      rawFinding({ line: 0 }),
      rawFinding({ line: 10, endLine: 9 }),
      rawFinding({ title: "t".repeat(121) }),
      rawFinding({ unitRef: "u-1" }),
    ];
    for (const invalid of variants) {
      const provider = new FakeProvider([{ respond: { findings: [invalid] } }, { respond: { findings: [invalid] } }]);
      const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
      await expect(engine.review([unit()], configWith())).resolves.toEqual([]);
      expect(provider.calls).toHaveLength(2);
    }
  });

  test("never repairs provider refusals", async () => {
    const provider = new FakeProvider([
      { respond: new ReviewerError({ code: "PROVIDER_FAILED", message: "provider refused the request: no" }) },
    ]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    await expect(engine.review([unit()], configWith())).resolves.toEqual([]);
    expect(provider.calls).toHaveLength(1);
  });

  test("escalates the output cap once on incomplete max_output_tokens", async () => {
    const provider = new FakeProvider([
      { respond: incompleteError("max_output_tokens") },
      { respond: { findings: [rawFinding()] } },
    ]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    const findings = await engine.review([unit()], configWith({ max_output_tokens: 1000 }));
    expect(findings).toHaveLength(1);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]?.maxTokens).toBe(1000);
    expect(provider.calls[1]?.maxTokens).toBe(2000);
    expect(provider.calls[1]?.user).not.toContain("was invalid");
  });

  test("marks the unit partial when the escalated cap is incomplete again", async () => {
    const provider = new FakeProvider([
      { respond: incompleteError("max_output_tokens") },
      { respond: incompleteError("max_output_tokens") },
    ]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    await expect(engine.review([unit()], configWith({ max_output_tokens: 1000 }))).resolves.toEqual([]);
    expect(provider.calls).toHaveLength(2);
  });

  test("does not escalate incomplete for other reasons", async () => {
    const provider = new FakeProvider([{ respond: incompleteError("content_filter") }]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    await expect(engine.review([unit()], configWith())).resolves.toEqual([]);
    expect(provider.calls).toHaveLength(1);
  });

  test("does not escalate when already at the output cap", async () => {
    const provider = new FakeProvider([{ respond: incompleteError("max_output_tokens") }]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    await expect(
      engine.review([unit()], configWith({ max_output_tokens: MAX_LLM_MAX_OUTPUT_TOKENS })),
    ).resolves.toEqual([]);
    expect(provider.calls).toHaveLength(1);
  });

  test("attributes each response to its originating unit with no unitRef", async () => {
    const provider = new FakeProvider([
      { respond: { findings: [rawFinding({ title: "first bug" })] } },
      { respond: { findings: [rawFinding({ title: "second bug" })] } },
    ]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    const findings = await engine.review(
      [unit({ id: "u-1" }), unit({ id: "u-2" })],
      configWith({ max_concurrent_requests: 1 }),
    );
    expect(findings.map((finding) => finding.origin.unitId)).toEqual(["u-1", "u-2"]);
    for (const call of provider.calls) {
      expect(call.user).not.toContain("unitRef");
    }
  });

  test("keeps one session id across the incomplete escalation", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const queue = [
      new Response(JSON.stringify({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      new Response(
        JSON.stringify({
          status: "completed",
          model: FIXED_MODEL_ID,
          output_text: JSON.stringify({ findings: [rawFinding()] }),
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ];
    const fetchFn = (async (url: unknown, init?: RequestInit): Promise<Response> => {
      seen.push({ url: String(url), init: init ?? {} });
      const next = queue.shift();
      if (next === undefined) throw new Error("fetch mock exhausted");
      return next;
    }) as unknown as typeof fetch;
    const provider = new OpenCodeProvider({ env: { ...GATE }, version: "0.1.0", fetchFn });
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...GATE } });
    const findings = await engine.review([unit()], configWith());
    expect(findings).toHaveLength(1);
    expect(seen).toHaveLength(2);
    const sessions = seen.map((call) => (call.init.headers as Record<string, string>)["x-opencode-session"]);
    expect(sessions[0]).toMatch(/^ses_/);
    expect(sessions[1]).toBe(sessions[0]);
    const caps = seen.map(
      (call) => (JSON.parse(String(call.init.body)) as Record<string, unknown>)["max_output_tokens"],
    );
    expect(caps).toEqual([32768, 65536]);
  });
});
