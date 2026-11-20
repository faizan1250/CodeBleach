import { describe, expect, test } from "bun:test";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import type { ResolvedConfig } from "../../src/config/schema.ts";
import { ReviewerError } from "../../src/core/errors.ts";
import type { Logger } from "../../src/core/logger.ts";
import { FakeProvider } from "../../src/providers/fake.ts";
import type { LlmProvider, LlmRequest, LlmResponse } from "../../src/providers/types.ts";
import { ReviewEngineImpl } from "../../src/review/engine.ts";
import type { ReviewUnit } from "../../src/types/context.ts";
import type { Rule } from "../../src/types/rules.ts";

const OPT_IN = { CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING: "true" };

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

function engineFor(
  provider: LlmProvider,
  env: Record<string, string | undefined> = { ...OPT_IN },
): ReviewEngineImpl {
  return new ReviewEngineImpl({ provider, logger: nullLogger(), env, headSha: "head-abc" });
}

// Deterministic out-of-order completion: each call parks until released.
class DeferredProvider implements LlmProvider {
  readonly name = "deferred";
  readonly capabilities = { structuredOutput: false, streaming: false };
  readonly calls: LlmRequest[] = [];
  maxInFlight = 0;
  private inFlight = 0;
  private readonly pending: Array<{ text: string; resolve: (value: LlmResponse) => void }> = [];

  constructor(private readonly texts: string[]) {}

  complete(request: LlmRequest): Promise<LlmResponse> {
    const index = this.calls.length;
    this.calls.push(request);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const text = this.texts[index] ?? '{"findings":[]}';
    return new Promise<LlmResponse>((resolve) => {
      this.pending.push({ text, resolve });
    });
  }

  resolveNext(): void {
    const next = this.pending.shift();
    if (next === undefined) throw new Error("nothing pending");
    this.inFlight -= 1;
    next.resolve({ text: next.text, model: "deferred" });
  }

  resolveAllReverse(): void {
    const items = [...this.pending].reverse();
    this.pending.length = 0;
    for (const item of items) {
      this.inFlight -= 1;
      item.resolve({ text: item.text, model: "deferred" });
    }
  }
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("review engine orchestration", () => {
  test("sends one prompt-v1 request per unit and returns empty findings", async () => {
    const provider = new FakeProvider([{ respond: { findings: [] } }]);
    const findings = await engineFor(provider).review([unit()], configWith());
    expect(findings).toEqual([]);
    expect(provider.calls).toHaveLength(1);
    const call = provider.calls[0]!;
    expect(call.system).toContain("code-review-v1");
    expect(call.system).toContain("untrusted");
    const payload = JSON.parse(call.user.slice(call.user.indexOf("{"))) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(["reviewUnit"]);
    expect(call.model).toBeUndefined();
    expect(call.maxTokens).toBe(32768);
    expect(call.timeoutMs).toBe(90000);
  });

  test("attributes findings to the originating unit with code-owned metadata", async () => {
    const provider = new FakeProvider([
      { respond: { findings: [rawFinding()] } },
      { respond: { findings: [rawFinding()] } },
    ]);
    const engine = engineFor(provider);
    const input = unit();
    const [first] = await engine.review([input], configWith());
    expect(first!.symbol).toBe("check");
    expect(first!.origin).toEqual({ pass: "code-review-v1", unitId: input.id });
    expect(first!.headSha).toBe("head-abc");
    expect(first!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first!.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    const [second] = await engine.review([input], configWith());
    expect(second!.fingerprint).toBe(first!.fingerprint);
    expect(second!.id).not.toBe(first!.id);
  });

  test("keeps stable unit order when concurrent requests finish out of order", async () => {
    const texts = [1, 2, 3].map((n) =>
      JSON.stringify({ findings: [rawFinding({ title: `finding-${n}` })] }),
    );
    const provider = new DeferredProvider(texts);
    const pending = engineFor(provider).review(
      [unit({ id: "u-1" }), unit({ id: "u-2" }), unit({ id: "u-3" })],
      configWith({ max_concurrent_requests: 3 }),
    );
    await tick();
    await tick();
    expect(provider.calls).toHaveLength(3);
    provider.resolveAllReverse();
    const findings = await pending;
    expect(findings.map((finding) => finding.title)).toEqual(["finding-1", "finding-2", "finding-3"]);
    expect(findings.map((finding) => finding.origin.unitId)).toEqual(["u-1", "u-2", "u-3"]);
  });

  test("caps concurrent provider requests at the configured maximum", async () => {
    const provider = new DeferredProvider([]);
    const pending = engineFor(provider).review(
      [unit({ id: "u-1" }), unit({ id: "u-2" }), unit({ id: "u-3" }), unit({ id: "u-4" })],
      configWith({ max_concurrent_requests: 2 }),
    );
    await tick();
    await tick();
    expect(provider.calls).toHaveLength(2);
    provider.resolveNext();
    await tick();
    await tick();
    expect(provider.calls).toHaveLength(3);
    provider.resolveAllReverse();
    await pending;
    expect(provider.maxInFlight).toBeLessThanOrEqual(2);
  });

  test("skips over-budget units without provider calls", async () => {
    const big = unit({
      context: [
        {
          id: "ctx-big",
          kind: "definition",
          file: "src/auth.ts",
          startLine: 1,
          endLine: 500,
          text: "x".repeat(20000),
          score: 1,
          tokens: 6000,
          reason: "oversized",
        },
      ],
    });
    const provider = new FakeProvider([{ respond: { findings: [rawFinding()] } }]);
    const findings = await engineFor(provider).review([big], configWith());
    expect(provider.calls).toHaveLength(0);
    expect(findings).toEqual([]);
  });

  test("still reviews fitting units alongside an over-budget unit", async () => {
    const big = unit({
      id: "u-big",
      context: [
        {
          id: "ctx-big",
          kind: "definition",
          file: "src/auth.ts",
          startLine: 1,
          endLine: 500,
          text: "x".repeat(20000),
          score: 1,
          tokens: 6000,
          reason: "oversized",
        },
      ],
    });
    const provider = new FakeProvider([{ respond: { findings: [rawFinding()] } }]);
    const findings = await engineFor(provider).review([big, unit({ id: "u-small" })], configWith());
    expect(provider.calls).toHaveLength(1);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.origin.unitId).toBe("u-small");
  });

  test("preserves successful findings when another unit fails", async () => {
    const provider = new FakeProvider([
      { match: (request) => request.user.includes('"bad"'), respond: new Error("boom") },
      { respond: { findings: [rawFinding({ title: "good bug" })] } },
    ]);
    const good = unit({
      id: "u-good",
      symbol: { name: "good", kind: "function", startLine: 8, endLine: 14, changedLines: [9] },
    });
    const bad = unit({
      id: "u-bad",
      symbol: { name: "bad", kind: "function", startLine: 8, endLine: 14, changedLines: [9] },
    });
    const findings = await engineFor(provider).review([good, bad], configWith());
    expect(findings.map((finding) => finding.title)).toEqual(["good bug"]);
    expect(findings[0]!.origin.unitId).toBe("u-good");
  });

  test("refuses before any provider call without the training opt-in", async () => {
    const provider = new FakeProvider([{ respond: { findings: [] } }]);
    const engine = engineFor(provider, {});
    let code: string | undefined;
    try {
      await engine.review([unit()], configWith());
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewerError);
      code = (error as ReviewerError).code;
    }
    expect(code).toBe("CONFIG_INVALID");
    expect(provider.calls).toHaveLength(0);
  });

  test("returns empty without provider calls for zero units", async () => {
    const provider = new FakeProvider([{ respond: { findings: [] } }]);
    const findings = await engineFor(provider).review([], configWith());
    expect(findings).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });
});
