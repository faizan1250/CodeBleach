import { describe, expect, test } from "bun:test";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import type { ResolvedConfig } from "../../src/config/schema.ts";
import { createAdvisoryReviewEngine, createRealReviewEngine } from "../../src/cli/commands/review.ts";
import { createLogger } from "../../src/core/logger.ts";
import type { Logger } from "../../src/core/logger.ts";
import { ReviewerError } from "../../src/core/errors.ts";
import { TRAINING_OPT_IN_ENV } from "../../src/llm/constants.ts";
import { RunConcurrencyLimiter } from "../../src/providers/limiter.ts";
import type { LlmProvider, LlmRequest, LlmResponse } from "../../src/providers/types.ts";
import { ConventionAdvisoryReviewEngineImpl } from "../../src/review/convention-engine.ts";
import { ReviewEngineImpl } from "../../src/review/engine.ts";
import type { ReviewUnit } from "../../src/types/context.ts";
import type { ConventionAdvisoryBatchInput, ConventionAdvisoryUnit } from "../../src/types/conventions.ts";

const OPT_IN_ENV = { [TRAINING_OPT_IN_ENV]: "true" };
const LIVE_ENV = { ...OPT_IN_ENV, OPENCODE_API_KEY: "test-key" };

function nullLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function config(): ResolvedConfig {
  return ConfigFileSchema.parse({});
}

const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

const EMPTY_JSON = '{"findings":[]}';

interface DeferredInner {
  provider: LlmProvider;
  calls: () => number;
  peak: () => number;
  releaseOne: () => void;
  releaseAll: () => void;
}

// Inner provider that blocks every complete() on a manual gate, tracking
// concurrent executions. Never touches the network.
function deferredInner(text: string = EMPTY_JSON): DeferredInner {
  let calls = 0;
  let inflight = 0;
  let peak = 0;
  const waiters: Array<() => void> = [];
  const provider: LlmProvider = {
    name: "deferred",
    capabilities: { structuredOutput: false, streaming: false },
    complete: (_request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> => {
      calls += 1;
      inflight += 1;
      peak = Math.max(peak, inflight);
      return new Promise<LlmResponse>((resolve, reject) => {
        if (signal?.aborted === true) {
          inflight -= 1;
          reject(signal.reason ?? new Error("aborted"));
          return;
        }
        const onAbort = (): void => {
          inflight -= 1;
          reject(signal?.reason ?? new Error("aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        waiters.push(() => {
          signal?.removeEventListener("abort", onAbort);
          inflight -= 1;
          resolve({ text, model: "deferred" });
        });
      });
    },
  };
  return {
    provider,
    calls: () => calls,
    peak: () => peak,
    releaseOne: () => waiters.shift()?.(),
    releaseAll: () => {
      let next = waiters.shift();
      while (next !== undefined) {
        next();
        next = waiters.shift();
      }
    },
  };
}

// Queued limiter waiters enter the inner provider only after earlier holders
// release, so a single releaseAll never finishes the run. Pump until every
// promise settles; a stall means a permit leaked and must fail, not hang.
async function drain(inner: DeferredInner, pending: Promise<unknown> | Promise<unknown>[]): Promise<void> {
  const all = Promise.all(Array.isArray(pending) ? pending : [pending]);
  let settled = false;
  void all.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let index = 0; index < 1000 && !settled; index += 1) {
    inner.releaseAll();
    await tick();
  }
  if (!settled) throw new Error("drain stalled: a limiter permit leaked");
  await all;
}

function reviewUnit(id: string): ReviewUnit {
  return {
    id,
    file: { path: `src/${id}.ts`, oldPath: null, status: "modified", language: "typescript", commentableLines: [1] },
    diff: { hunks: [], originalHunkCount: 0, includedHunkCount: 0, omittedHunkCount: 0, truncated: false },
    symbol: { name: "f", kind: "function", startLine: 1, endLine: 2, changedLines: [1] },
    context: [],
    rules: [],
  };
}

function advisoryUnit(unitId: string): ConventionAdvisoryUnit {
  return {
    unitId,
    path: "src/a.ts",
    language: "typescript",
    symbol: { name: "f", kind: "function", signature: "f(): number", side: "head", startLine: 1 },
    diffHunks: [
      { baseStartLine: 1, headStartLine: 1, lines: [" export function f(): number {", "+  return 2;", " }"] },
    ],
    changedSymbolSource: "export function f(): number {\n  return 2;\n}",
  };
}

function advisoryBatch(count: number): ConventionAdvisoryBatchInput {
  const units = Array.from({ length: count }, (_, index) => advisoryUnit(`limiter-unit-${index}`));
  return {
    units,
    conventions: [
      {
        detector: "naming-exports",
        pattern: "Modules predominantly use named exports.",
        matchingFiles: 9,
        eligibleFiles: 10,
        supportRatio: 0.9,
      },
    ],
  };
}

describe("run-scoped shared limiter", () => {
  test("caps concurrent calls at the limit", async () => {
    const limiter = new RunConcurrencyLimiter(2);
    const inner = deferredInner();
    const wrapped = limiter.wrap(inner.provider);
    const pending = Array.from({ length: 5 }, () => wrapped.complete({ system: "s", user: "u" }));
    await tick();
    expect(inner.calls()).toBe(2);
    expect(inner.peak()).toBe(2);
    await drain(inner, pending);
    expect(inner.calls()).toBe(5);
    expect(inner.peak()).toBe(2);
  });

  test("mixed primary and advisory providers share one ceiling", async () => {
    const limiter = new RunConcurrencyLimiter(3);
    const inner = deferredInner();
    const primary = limiter.wrap(inner.provider);
    const advisory = limiter.wrap(inner.provider);
    const pending = [
      ...Array.from({ length: 4 }, () => primary.complete({ system: "primary", user: "u" })),
      ...Array.from({ length: 2 }, () => advisory.complete({ system: "advisory", user: "u" })),
    ];
    await tick();
    expect(inner.calls()).toBe(3);
    expect(inner.peak()).toBeLessThanOrEqual(3);
    await drain(inner, pending);
    expect(inner.calls()).toBe(6);
    expect(inner.peak()).toBe(3);
  });

  test("limit 1 serializes primary and advisory globally", async () => {
    const limiter = new RunConcurrencyLimiter(1);
    const inner = deferredInner();
    const order: string[] = [];
    const tracked = (label: string): Promise<string> =>
      limiter
        .wrap(inner.provider)
        .complete({ system: label, user: "u" })
        .then(() => {
          order.push(label);
          return label;
        });
    const pending = [tracked("primary-1"), tracked("advisory-1"), tracked("primary-2")];
    await tick();
    expect(inner.calls()).toBe(1);
    expect(inner.peak()).toBe(1);
    inner.releaseOne();
    await tick();
    inner.releaseOne();
    await tick();
    inner.releaseOne();
    expect(await Promise.all(pending)).toEqual(["primary-1", "advisory-1", "primary-2"]);
    expect(order).toEqual(["primary-1", "advisory-1", "primary-2"]);
    expect(inner.peak()).toBe(1);
  });

  test("limit 4 admits four concurrent calls", async () => {
    const limiter = new RunConcurrencyLimiter(4);
    const inner = deferredInner();
    const wrapped = limiter.wrap(inner.provider);
    const pending = Array.from({ length: 6 }, () => wrapped.complete({ system: "s", user: "u" }));
    await tick();
    expect(inner.calls()).toBe(4);
    expect(inner.peak()).toBe(4);
    await drain(inner, pending);
    expect(inner.peak()).toBe(4);
  });

  test("aborted wait never acquires and cleans the queue", async () => {
    const limiter = new RunConcurrencyLimiter(1);
    const inner = deferredInner();
    const wrapped = limiter.wrap(inner.provider);
    const first = wrapped.complete({ system: "s", user: "u" });
    await tick();
    expect(inner.calls()).toBe(1);
    const controller = new AbortController();
    const queued = wrapped.complete({ system: "s", user: "u" }, controller.signal);
    await tick();
    expect(inner.calls()).toBe(1);
    controller.abort();
    const failure = await queued.then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ReviewerError);
    expect((failure as ReviewerError).code).toBe("PROVIDER_FAILED");
    expect(inner.calls()).toBe(1);
    const third = wrapped.complete({ system: "s", user: "u" });
    await tick();
    expect(inner.calls()).toBe(1);
    await drain(inner, [first, third]);
    expect(inner.calls()).toBe(2);
  });

  test("pre-aborted signal never acquires", async () => {
    const limiter = new RunConcurrencyLimiter(2);
    const inner = deferredInner();
    const controller = new AbortController();
    controller.abort();
    const failure = await limiter
      .wrap(inner.provider)
      .complete({ system: "s", user: "u" }, controller.signal)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(ReviewerError);
    expect(inner.calls()).toBe(0);
  });

  test("rejected call releases its permit", async () => {
    let calls = 0;
    let inflight = 0;
    let peak = 0;
    const flaky: LlmProvider = {
      name: "flaky",
      capabilities: { structuredOutput: false, streaming: false },
      complete: async (): Promise<LlmResponse> => {
        calls += 1;
        inflight += 1;
        peak = Math.max(peak, inflight);
        await tick();
        inflight -= 1;
        if (calls === 1) throw new ReviewerError({ code: "PROVIDER_FAILED", message: "boom" });
        return { text: EMPTY_JSON, model: "flaky" };
      },
    };
    const wrapped = new RunConcurrencyLimiter(1).wrap(flaky);
    const settled = await Promise.allSettled(
      Array.from({ length: 4 }, () => wrapped.complete({ system: "s", user: "u" })),
    );
    expect(settled.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(3);
    expect(calls).toBe(4);
    expect(peak).toBe(1);
  });

  test("release is idempotent", async () => {
    const limiter = new RunConcurrencyLimiter(1);
    const release = await limiter.acquire();
    release();
    release();
    const second = limiter.acquire();
    const third = limiter.acquire();
    const winner = await Promise.race([second.then((fn) => fn), tick().then(() => null)]);
    expect(winner).not.toBeNull();
    let thirdSettled = false;
    void third.then(() => {
      thirdSettled = true;
    });
    await tick();
    expect(thirdSettled).toBe(false);
    (winner as () => void)();
    const thirdRelease = await third;
    expect(typeof thirdRelease).toBe("function");
    thirdRelease();
  });

  test("limiters are run-scoped, never shared across runs", async () => {
    const first = new RunConcurrencyLimiter(1);
    const second = new RunConcurrencyLimiter(1);
    const blocked = deferredInner();
    const free = deferredInner();
    const held = first.wrap(blocked.provider).complete({ system: "s", user: "u" });
    await tick();
    await tick();
    expect(blocked.calls()).toBe(1);
    const otherPending = second.wrap(free.provider).complete({ system: "s", user: "u" });
    await tick();
    await tick();
    expect(free.calls()).toBe(1);
    free.releaseAll();
    const other = await otherPending;
    expect(other.text).toBe(EMPTY_JSON);
    expect(free.calls()).toBe(1);
    blocked.releaseAll();
    await held;
  });

  test("clamps degenerate limits to 1", () => {
    expect(new RunConcurrencyLimiter(0).limit).toBe(1);
    expect(new RunConcurrencyLimiter(-3).limit).toBe(1);
    expect(new RunConcurrencyLimiter(Number.NaN).limit).toBe(1);
    expect(new RunConcurrencyLimiter(2.9).limit).toBe(2);
  });
});

describe("shared limiter through the review engines", () => {
  test("primary pool honors the shared limiter below its own cap", async () => {
    const limiter = new RunConcurrencyLimiter(2);
    const inner = deferredInner();
    const engine = new ReviewEngineImpl({
      provider: limiter.wrap(inner.provider),
      logger: nullLogger(),
      env: OPT_IN_ENV,
    });
    const units = Array.from({ length: 6 }, (_, index) => reviewUnit(`limiter-${index}`));
    const pending = engine.review(units, config());
    await tick();
    await tick();
    expect(inner.peak()).toBeLessThanOrEqual(2);
    await drain(inner, pending);
    const result = await pending;
    expect(result.status).toBe("complete");
    expect(result.unitsReviewed).toBe(6);
    expect(inner.peak()).toBeLessThanOrEqual(2);
  });

  test("primary and advisory engines share one ceiling end to end", async () => {
    const limiter = new RunConcurrencyLimiter(3);
    const inner = deferredInner();
    const primary = new ReviewEngineImpl({
      provider: limiter.wrap(inner.provider),
      logger: nullLogger(),
      env: OPT_IN_ENV,
    });
    const advisory = new ConventionAdvisoryReviewEngineImpl({
      provider: limiter.wrap(inner.provider),
      env: OPT_IN_ENV,
    });
    const units = Array.from({ length: 6 }, (_, index) => reviewUnit(`mixed-${index}`));
    const primaryPending = primary.review(units, config());
    const batchPending = [
      advisory.reviewBatch(advisoryBatch(2), config()),
      advisory.reviewBatch(advisoryBatch(2), config()),
      advisory.reviewBatch(advisoryBatch(2), config()),
    ];
    const pending: Array<Promise<unknown>> = [primaryPending, ...batchPending];
    await tick();
    await tick();
    expect(inner.peak()).toBeLessThanOrEqual(3);
    await drain(inner, pending);
    const reviewResult = await primaryPending;
    const batchResults = await Promise.all(batchPending);
    expect(reviewResult.status).toBe("complete");
    expect(batchResults).toHaveLength(3);
    expect(inner.peak()).toBeLessThanOrEqual(3);
  });

  test("live composition shares one limiter with separate sessions", async () => {
    const sessions: Array<string | null> = [];
    let fetchInflight = 0;
    let fetchPeak = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const fetchFn = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      sessions.push(init?.headers?.["x-opencode-session"] ?? null);
      fetchInflight += 1;
      fetchPeak = Math.max(fetchPeak, fetchInflight);
      try {
        await gate;
        return new Response(
          JSON.stringify({
            status: "completed",
            output_text: EMPTY_JSON,
            model: "m",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      } finally {
        fetchInflight -= 1;
      }
    }) as unknown as typeof fetch;
    const limiter = new RunConcurrencyLimiter(1);
    const primary = createRealReviewEngine({
      runId: "shared-run",
      version: "test",
      env: LIVE_ENV,
      secrets: [],
      logger: createLogger({ level: "error", runId: "limiter-composition" }),
      limiter,
      fetchFn,
    });
    const advisory = createAdvisoryReviewEngine({
      runId: "shared-run",
      version: "test",
      env: LIVE_ENV,
      limiter,
      fetchFn,
    });
    const primaryPending = primary.review([reviewUnit("composition")], config());
    const batchPending = advisory.reviewBatch(advisoryBatch(1), config());
    const pending: Array<Promise<unknown>> = [primaryPending, batchPending];
    await tick();
    await tick();
    expect(sessions).toHaveLength(1);
    expect(fetchPeak).toBe(1);
    releaseGate();
    await Promise.all(pending);
    expect(fetchPeak).toBe(1);
    expect(new Set(sessions)).toEqual(new Set(["ses_sharedrun", "ses_sharedrun-advisory"]));
    expect((await primaryPending).status).toBe("complete");
    expect((await batchPending).candidates).toEqual([]);
  });
});
