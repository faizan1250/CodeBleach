import { describe, expect, test } from "bun:test";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import type { ResolvedConfig } from "../../src/config/schema.ts";
import { ReviewerError } from "../../src/core/errors.ts";
import type { Logger } from "../../src/core/logger.ts";
import { API_KEY_ENV, FIXED_MODEL_ID, TRAINING_OPT_IN_ENV } from "../../src/llm/constants.ts";
import { OpenCodeProvider } from "../../src/providers/opencode.ts";
import { FakeProvider } from "../../src/providers/fake.ts";
import { completeJsonWithStats, newJsonCallStats } from "../../src/providers/json.ts";
import type { LlmProvider, LlmRequest, LlmResponse } from "../../src/providers/types.ts";
import { ReviewEngineImpl } from "../../src/review/engine.ts";
import { RawReviewOutputSchema } from "../../src/types/finding.ts";
import type { ReviewUnit } from "../../src/types/context.ts";
import type { Rule } from "../../src/types/rules.ts";

const GATE = {
  [TRAINING_OPT_IN_ENV]: "true",
  [API_KEY_ENV]: "dummy-key",
};

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
    context: [],
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

function configWith(): ResolvedConfig {
  return ConfigFileSchema.parse({});
}

function configWithReviewTimeout(ms: number): ResolvedConfig {
  const base = configWith();
  return { ...base, llm: { ...base.llm, review_timeout_ms: ms } } as ResolvedConfig;
}

function engineFor(provider: LlmProvider): ReviewEngineImpl {
  return new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...GATE }, headSha: "head-abc" });
}

function abortError(): ReviewerError {
  return new ReviewerError({
    code: "PROVIDER_FAILED",
    message: "request aborted: test cancelled",
    retryable: false,
  });
}

/** Manual stub: every call parks until released; honors AbortSignal. */
class ManualProvider implements LlmProvider {
  readonly name = "manual";
  readonly capabilities = { structuredOutput: false, streaming: false };
  readonly calls: LlmRequest[] = [];
  private readonly pending: Array<{ resolve: (value: LlmResponse) => void; text: string }> = [];

  constructor(private readonly texts: string[] = []) {}

  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    const index = this.calls.length;
    this.calls.push(request);
    if (signal?.aborted === true) return Promise.reject(abortError());
    return new Promise<LlmResponse>((resolve, reject) => {
      const text = this.texts[index] ?? '{"findings":[]}';
      const entry = { resolve, text };
      this.pending.push(entry);
      signal?.addEventListener(
        "abort",
        () => {
          const at = this.pending.indexOf(entry);
          if (at !== -1) this.pending.splice(at, 1);
          reject(abortError());
        },
        { once: true },
      );
    });
  }

  resolveNext(): void {
    const next = this.pending.shift();
    if (next === undefined) throw new Error("nothing pending");
    next.resolve({ text: next.text, model: "manual" });
  }
}

/** Never resolves unless the signal aborts. */
class HangingProvider implements LlmProvider {
  readonly name = "hanging";
  readonly capabilities = { structuredOutput: false, streaming: false };
  readonly calls: LlmRequest[] = [];

  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    this.calls.push(request);
    if (signal?.aborted === true) return Promise.reject(abortError());
    return new Promise<LlmResponse>((_, reject) => {
      signal?.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  }
}

class SignalCaptureProvider implements LlmProvider {
  readonly name = "capture";
  readonly capabilities = { structuredOutput: false, streaming: false };
  readonly signals: Array<AbortSignal | undefined> = [];

  constructor(private readonly texts: string[]) {}

  complete(_request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    this.signals.push(signal);
    const text = this.texts[this.signals.length - 1] ?? '{"findings":[]}';
    return Promise.resolve({ text, model: "capture" });
  }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function okEnvelope(findings: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: "resp_1",
    model: FIXED_MODEL_ID,
    status: "completed",
    output_text: JSON.stringify({ findings }),
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function mockFetch(responses: Response[], calls: unknown[]): typeof fetch {
  const queue = [...responses];
  return (async (_url: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ init });
    const next = queue.shift();
    if (next === undefined) throw new Error("fetch mock exhausted");
    return next;
  }) as typeof fetch;
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("review stage deadline config", () => {
  test("defaults the overall review deadline to 600000ms", () => {
    expect(ConfigFileSchema.parse({}).llm.review_timeout_ms).toBe(600000);
  });

  test("rejects review deadlines outside 1000ms to 3600000ms", () => {
    expect(() => ConfigFileSchema.parse({ llm: { review_timeout_ms: 999 } })).toThrow();
    expect(() => ConfigFileSchema.parse({ llm: { review_timeout_ms: 3600001 } })).toThrow();
    expect(ConfigFileSchema.parse({ llm: { review_timeout_ms: 1000 } }).llm.review_timeout_ms).toBe(1000);
  });
});

describe("transport retry reporting", () => {
  test("reports zero retries on first-try success", async () => {
    const calls: unknown[] = [];
    const provider = new OpenCodeProvider({
      env: { ...GATE },
      fetchFn: mockFetch([jsonResponse(okEnvelope([]))], calls),
    });
    const response = await provider.complete({ system: "s", user: "u" });
    expect(response.retries).toBe(0);
    expect(calls).toHaveLength(1);
  });

  test("reports one retry after a single 500 recovery", async () => {
    const calls: unknown[] = [];
    const provider = new OpenCodeProvider({
      env: { ...GATE },
      fetchFn: mockFetch([jsonResponse({ error: "busy" }, 500), jsonResponse(okEnvelope([]))], calls),
      sleep: () => Promise.resolve(),
    });
    const response = await provider.complete({ system: "s", user: "u" });
    expect(response.text).toBe('{"findings":[]}');
    expect(response.retries).toBe(1);
    expect(calls).toHaveLength(2);
  });

  test("attaches the retry count to exhausted retryable errors", async () => {
    const calls: unknown[] = [];
    const provider = new OpenCodeProvider({
      env: { ...GATE },
      fetchFn: mockFetch(
        [jsonResponse({ error: "x" }, 500), jsonResponse({ error: "x" }, 500), jsonResponse({ error: "x" }, 500)],
        calls,
      ),
      maxRetries: 2,
      sleep: () => Promise.resolve(),
    });
    let retries: number | undefined;
    try {
      await provider.complete({ system: "s", user: "u" });
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewerError);
      retries = (error as ReviewerError).retries;
    }
    expect(retries).toBe(2);
    expect(calls).toHaveLength(3);
  });

  test("non-retryable 400 performs a single attempt", async () => {
    const calls: unknown[] = [];
    const provider = new OpenCodeProvider({
      env: { ...GATE },
      fetchFn: mockFetch([jsonResponse({ error: "bad" }, 400)], calls),
      sleep: () => Promise.resolve(),
    });
    try {
      await provider.complete({ system: "s", user: "u" });
      throw new Error("expected provider failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewerError);
      expect((error as ReviewerError).retryable).toBe(false);
      expect((error as ReviewerError).retries).toBeUndefined();
    }
    expect(calls).toHaveLength(1);
  });
});

describe("engine retry and repair accounting", () => {
  test("counts transport retries separately from requests and repairs", async () => {
    const calls: unknown[] = [];
    const provider = new OpenCodeProvider({
      env: { ...GATE },
      fetchFn: mockFetch([jsonResponse({ error: "busy" }, 500), jsonResponse(okEnvelope([rawFinding()]))], calls),
      sleep: () => Promise.resolve(),
    });
    const result = await engineFor(provider).review([unit()], configWith());
    expect(result.status).toBe("complete");
    expect(result.findings).toHaveLength(1);
    expect(result.usage.requests).toBe(1);
    expect(result.usage.retries).toBe(1);
    expect(result.usage.repairRequests).toBe(0);
    expect(calls).toHaveLength(2);
  });

  test("exhausted retries stay bounded and mark the unit retryable", async () => {
    const calls: unknown[] = [];
    const provider = new OpenCodeProvider({
      env: { ...GATE },
      fetchFn: mockFetch(
        [jsonResponse({ error: "x" }, 500), jsonResponse({ error: "x" }, 500), jsonResponse({ error: "x" }, 500)],
        calls,
      ),
      maxRetries: 2,
      sleep: () => Promise.resolve(),
    });
    const result = await engineFor(provider).review([unit()], configWith());
    expect(result.status).toBe("failed");
    expect(result.findings).toEqual([]);
    expect(result.usage.requests).toBe(1);
    expect(result.usage.retries).toBe(2);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("PROVIDER_FAILED");
    expect(result.diagnostics[0]?.retryable).toBe(true);
    expect(calls).toHaveLength(3);
  });

  test("keeps repair requests distinct from transport retries", async () => {
    const provider = new FakeProvider([{ respond: "not json", retries: 2 }, { respond: { findings: [rawFinding()] } }]);
    const result = await engineFor(provider).review([unit()], configWith());
    expect(result.status).toBe("complete");
    expect(result.findings).toHaveLength(1);
    expect(result.usage.requests).toBe(2);
    expect(result.usage.repairRequests).toBe(1);
    expect(result.usage.retries).toBe(2);
    expect(result.usage.incompleteRetries).toBe(0);
  });
});

describe("json signal threading", () => {
  test("forwards the abort signal to the initial and repair calls", async () => {
    const provider = new SignalCaptureProvider(["not json", JSON.stringify({ findings: [] })]);
    const controller = new AbortController();
    const stats = newJsonCallStats();
    const parsed = await completeJsonWithStats(
      provider,
      { system: "s", user: "u" },
      RawReviewOutputSchema,
      stats,
      controller.signal,
    );
    expect(parsed).toEqual({ findings: [] });
    expect(provider.signals).toHaveLength(2);
    expect(provider.signals[0]).toBe(controller.signal);
    expect(provider.signals[1]).toBe(controller.signal);
  });
});

describe("engine deadlines and cancellation", () => {
  test("pre-aborted caller makes zero provider calls", async () => {
    const provider = new FakeProvider([{ respond: { findings: [rawFinding()] } }]);
    const controller = new AbortController();
    controller.abort(new Error("caller gone"));
    const result = await engineFor(provider).review([unit({ id: "u-1" }), unit({ id: "u-2" })], configWith(), {
      signal: controller.signal,
    });
    expect(provider.calls).toHaveLength(0);
    expect(result.status).toBe("failed");
    expect(result.findings).toEqual([]);
    expect(result.unitsReviewed).toBe(0);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["REVIEW_CANCELLED", "REVIEW_CANCELLED"]);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.retryable).toBe(false);
    }
  });

  test("an already-expired stage deadline starts zero provider calls", async () => {
    const provider = new FakeProvider([{ respond: { findings: [rawFinding()] } }]);
    const result = await engineFor(provider).review([unit()], configWithReviewTimeout(0));
    expect(provider.calls).toHaveLength(0);
    expect(result.status).toBe("failed");
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("REVIEW_DEADLINE_EXCEEDED");
    expect(result.diagnostics[0]?.retryable).toBe(false);
  });

  test("a stage deadline during requests preserves completed findings", async () => {
    const provider = new ManualProvider([JSON.stringify({ findings: [rawFinding({ title: "kept" })] })]);
    const pending = engineFor(provider).review([unit({ id: "u-1" }), unit({ id: "u-2" }), unit({ id: "u-3" })], {
      ...configWithReviewTimeout(40),
      llm: { ...configWithReviewTimeout(40).llm, max_concurrent_requests: 1 },
    });
    await tick();
    provider.resolveNext();
    const result = await pending;
    expect(result.status).toBe("partial");
    expect(result.findings.map((finding) => finding.title)).toEqual(["kept"]);
    expect(result.unitsReviewed).toBe(1);
    expect(result.unitsFailed).toBe(2);
    expect(provider.calls).toHaveLength(2);
    expect(result.diagnostics.every((diagnostic) => diagnostic.code === "REVIEW_DEADLINE_EXCEEDED")).toBe(true);
  });

  test("mid-run caller abort preserves completed findings", async () => {
    const provider = new ManualProvider([JSON.stringify({ findings: [rawFinding({ title: "kept" })] })]);
    const controller = new AbortController();
    const pending = engineFor(provider).review(
      [unit({ id: "u-1" }), unit({ id: "u-2" })],
      { ...configWith(), llm: { ...configWith().llm, max_concurrent_requests: 1 } },
      { signal: controller.signal },
    );
    await tick();
    await tick();
    expect(provider.calls).toHaveLength(1);
    provider.resolveNext();
    await tick();
    await tick();
    expect(provider.calls).toHaveLength(2);
    controller.abort(new Error("caller gone"));
    const result = await pending;
    expect(result.status).toBe("partial");
    expect(result.findings.map((finding) => finding.title)).toEqual(["kept"]);
    expect(result.unitsReviewed).toBe(1);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("REVIEW_CANCELLED");
    expect(result.diagnostics[0]?.retryable).toBe(false);
  });

  test("the stage deadline wins over a retry-after backoff", async () => {
    const calls: unknown[] = [];
    const provider = new OpenCodeProvider({
      env: { ...GATE },
      fetchFn: mockFetch(
        [jsonResponse({ error: "slow" }, 429, { "Retry-After": "5" }), jsonResponse(okEnvelope([]))],
        calls,
      ),
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 200)),
    });
    const result = await engineFor(provider).review([unit()], configWithReviewTimeout(30));
    expect(calls).toHaveLength(1);
    expect(result.status).toBe("failed");
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("REVIEW_DEADLINE_EXCEEDED");
  });

  test("hanging requests abort without waiting out the per-request timeout", async () => {
    const provider = new HangingProvider();
    const started = Date.now();
    const result = await engineFor(provider).review([unit()], configWithReviewTimeout(40));
    expect(Date.now() - started).toBeLessThan(90000);
    expect(provider.calls).toHaveLength(1);
    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]?.code).toBe("REVIEW_DEADLINE_EXCEEDED");
  });
});
