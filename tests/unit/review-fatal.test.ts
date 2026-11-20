import { describe, expect, test } from "bun:test";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import type { ResolvedConfig } from "../../src/config/schema.ts";
import { ReviewerError } from "../../src/core/errors.ts";
import type { Logger } from "../../src/core/logger.ts";
import { API_KEY_ENV, TRAINING_OPT_IN_ENV } from "../../src/llm/constants.ts";
import { OpenCodeProvider } from "../../src/providers/opencode.ts";
import type { LlmProvider, LlmRequest, LlmResponse } from "../../src/providers/types.ts";
import { ReviewEngineImpl } from "../../src/review/engine.ts";
import type { ReviewUnit } from "../../src/types/context.ts";
import type { Rule } from "../../src/types/rules.ts";

const OPT_IN = { [TRAINING_OPT_IN_ENV]: "true" };
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

function configWith(llm: Record<string, number> = {}): ResolvedConfig {
  return ConfigFileSchema.parse({ llm });
}

function engineFor(provider: LlmProvider, env: Record<string, string | undefined> = { ...OPT_IN }): ReviewEngineImpl {
  return new ReviewEngineImpl({ provider, logger: nullLogger(), env, headSha: "head-abc" });
}

function abortError(): ReviewerError {
  return new ReviewerError({
    code: "PROVIDER_FAILED",
    message: "request aborted: test cancelled",
    retryable: false,
  });
}

// Every call parks until released; optionally honors abort like a live provider.
class ParkedProvider implements LlmProvider {
  readonly name = "parked";
  readonly capabilities = { structuredOutput: false, streaming: false };
  readonly calls: LlmRequest[] = [];
  readonly signals: Array<AbortSignal | undefined> = [];
  private readonly pending: Array<{
    resolve: (value: LlmResponse) => void;
    reject: (reason: unknown) => void;
  }> = [];

  constructor(
    private readonly abortable = true,
    private readonly onAbort?: (() => void) | undefined,
  ) {}

  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    this.calls.push(request);
    this.signals.push(signal);
    if (signal?.aborted === true) return Promise.reject(abortError());
    return new Promise<LlmResponse>((resolve, reject) => {
      const entry = { resolve, reject };
      this.pending.push(entry);
      if (this.abortable) {
        signal?.addEventListener(
          "abort",
          () => {
            const at = this.pending.indexOf(entry);
            if (at !== -1) this.pending.splice(at, 1);
            this.onAbort?.();
            reject(abortError());
          },
          { once: true },
        );
      }
    });
  }

  pendingCount(): number {
    return this.pending.length;
  }

  resolveNext(text = '{"findings":[]}'): void {
    const next = this.pending.shift();
    if (next === undefined) throw new Error("nothing pending");
    next.resolve({ text, model: "parked" });
  }

  failNext(error: unknown): void {
    const next = this.pending.shift();
    if (next === undefined) throw new Error("nothing pending");
    next.reject(error);
  }
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function ticks(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await tick();
}

async function rejectsWith(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

describe("review fatal worker cancellation", () => {
  test("freezes provider calls when a sibling turns fatal", async () => {
    const provider = new ParkedProvider();
    const fatal = new ReviewerError({ code: "CONFIG_INVALID", message: "policy violation mid-run" });
    const units = Array.from({ length: 12 }, (_, index) => unit({ id: `u-${index + 1}` }));
    const pending = engineFor(provider).review(units, configWith({ max_concurrent_requests: 3 }));
    await ticks(3);
    expect(provider.calls).toHaveLength(3);
    expect(provider.pendingCount()).toBe(3);
    provider.failNext(fatal);
    expect(await rejectsWith(pending)).toBe(fatal);
    await ticks(3);
    expect(provider.calls).toHaveLength(3);
    expect(provider.pendingCount()).toBe(0);
  });

  test("cancels provider signals without touching the caller signal", async () => {
    const provider = new ParkedProvider();
    const fatal = new ReviewerError({ code: "CONFIG_INVALID", message: "policy violation mid-run" });
    const controller = new AbortController();
    const pending = engineFor(provider).review([unit({ id: "u-1" }), unit({ id: "u-2" })], configWith(), {
      signal: controller.signal,
    });
    await ticks(3);
    provider.failNext(fatal);
    expect(await rejectsWith(pending)).toBe(fatal);
    expect(controller.signal.aborted).toBe(false);
    expect(provider.signals).toHaveLength(2);
    for (const signal of provider.signals) expect(signal?.aborted).toBe(true);
  });

  test("discards a late success that lands after a fatal", async () => {
    const provider = new ParkedProvider(false);
    const fatal = new ReviewerError({ code: "CONFIG_INVALID", message: "policy violation mid-run" });
    const pending = engineFor(provider).review(
      [unit({ id: "u-bad" }), unit({ id: "u-ok" })],
      configWith({ max_concurrent_requests: 2 }),
    );
    await ticks(3);
    expect(provider.calls).toHaveLength(2);
    provider.failNext(fatal);
    await ticks(3);
    expect(provider.pendingCount()).toBe(1);
    provider.resolveNext(JSON.stringify({ findings: [rawFinding({ title: "late win" })] }));
    expect(await rejectsWith(pending)).toBe(fatal);
    await ticks(3);
    expect(provider.calls).toHaveLength(2);
  });

  test("keeps the first fatal when a second follows", async () => {
    const provider = new ParkedProvider();
    const first = new ReviewerError({ code: "CONFIG_INVALID", message: "first policy break" });
    const second = new ReviewerError({ code: "CONFIG_INVALID", message: "second policy break" });
    const pending = engineFor(provider).review(
      [unit({ id: "u-1" }), unit({ id: "u-2" })],
      configWith({ max_concurrent_requests: 2 }),
    );
    await ticks(3);
    provider.failNext(first);
    provider.failNext(second);
    expect(await rejectsWith(pending)).toBe(first);
    expect(provider.calls).toHaveLength(2);
  });

  test("clears the deadline timer only after workers settle", async () => {
    const events: string[] = [];
    const created = new Set<unknown>();
    type SetTimeoutFn = typeof globalThis.setTimeout;
    type ClearTimeoutFn = typeof globalThis.clearTimeout;
    const originalSetTimeout: SetTimeoutFn = globalThis.setTimeout.bind(globalThis);
    const originalClearTimeout: ClearTimeoutFn = globalThis.clearTimeout.bind(globalThis);
    globalThis.setTimeout = ((...args: Parameters<SetTimeoutFn>): ReturnType<SetTimeoutFn> => {
      const id = originalSetTimeout(...args);
      created.add(id);
      return id;
    }) as SetTimeoutFn;
    globalThis.clearTimeout = ((id: Parameters<ClearTimeoutFn>[0]): ReturnType<ClearTimeoutFn> => {
      if (created.has(id)) events.push("clear");
      return originalClearTimeout(id);
    }) as ClearTimeoutFn;
    try {
      const provider = new ParkedProvider(true, () => events.push("abort"));
      const fatal = new ReviewerError({ code: "CONFIG_INVALID", message: "policy violation mid-run" });
      const pending = engineFor(provider).review([unit({ id: "u-1" }), unit({ id: "u-2" })], configWith());
      await ticks(3);
      provider.failNext(fatal);
      expect(await rejectsWith(pending)).toBe(fatal);
      expect(events.filter((event) => event === "abort")).toHaveLength(2);
      expect(events[events.length - 1]).toBe("clear");
      expect(events.indexOf("abort")).toBeLessThan(events.indexOf("clear"));
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test("per-request timeouts stay partial without fataling the run", async () => {
    const fetchFn = ((_url: unknown, init?: RequestInit): Promise<Response> => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      });
    }) as typeof fetch;
    const provider = new OpenCodeProvider({ env: { ...GATE }, fetchFn, maxRetries: 0 });
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...GATE } });
    const result = await engine.review([unit()], configWith({ request_timeout_ms: 1000 }));
    expect(result.status).toBe("failed");
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("PROVIDER_FAILED");
    expect(result.diagnostics[0]?.message).toContain("timed out");
  });
});
