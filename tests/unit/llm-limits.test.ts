import { describe, expect, test } from "bun:test";
import { ConfigFileSchema, type ResolvedConfig } from "../../src/config/schema.ts";
import { ReviewerError } from "../../src/core/errors.ts";
import type { Logger } from "../../src/core/logger.ts";
import { API_KEY_ENV, TRAINING_OPT_IN_ENV } from "../../src/llm/constants.ts";
import {
  CONTEXT_SAFETY_MARGIN_TOKENS,
  MODEL_CONTEXT_TOKENS,
  MODEL_MAX_INPUT_TOKENS,
  MODEL_MAX_OUTPUT_TOKENS,
  effectiveInputCeiling,
  resolveCatalogLimits,
  validateUnitBudgets,
} from "../../src/llm/limits.ts";
import { FakeProvider } from "../../src/providers/fake.ts";
import { OpenCodeProvider } from "../../src/providers/opencode.ts";
import { ReviewEngineImpl } from "../../src/review/engine.ts";
import { buildReviewPrompt } from "../../src/review/prompt.ts";
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

function neverFetch(): typeof fetch {
  return ((_url: unknown) => {
    throw new Error("fetch must not be called");
  }) as unknown as typeof fetch;
}

async function codeOf(promise: Promise<unknown>): Promise<ReviewerError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewerError);
    return error as ReviewerError;
  }
  throw new Error("expected ReviewerError");
}

describe("local hard limits", () => {
  test("effective ceiling reserves output plus margin from context", () => {
    expect(effectiveInputCeiling(32768, 64000)).toBe(
      Math.min(64000, MODEL_CONTEXT_TOKENS - 32768 - CONTEXT_SAFETY_MARGIN_TOKENS),
    );
    expect(effectiveInputCeiling(131072, 1000000)).toBeLessThanOrEqual(
      MODEL_CONTEXT_TOKENS - 131072 - CONTEXT_SAFETY_MARGIN_TOKENS,
    );
  });

  test("accepts budgets that fit with room to spare", () => {
    const result = validateUnitBudgets({ estimatedInputTokens: 1000, maxOutputTokens: 32768, inputBudget: 64000 });
    expect(result).toEqual({ ok: true, effectiveInputCeiling: 64000 });
  });

  test("rejects non-positive or non-integer budgets", () => {
    for (const input of [
      { estimatedInputTokens: 0, maxOutputTokens: 32768, inputBudget: 64000 },
      { estimatedInputTokens: -5, maxOutputTokens: 32768, inputBudget: 64000 },
      { estimatedInputTokens: Number.NaN, maxOutputTokens: 32768, inputBudget: 64000 },
      { estimatedInputTokens: 1000, maxOutputTokens: 1.5, inputBudget: 64000 },
      { estimatedInputTokens: 1000, maxOutputTokens: 32768, inputBudget: 0 },
    ]) {
      const result = validateUnitBudgets(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("INVALID_BUDGET");
    }
  });

  test("rejects output above the local hard ceiling", () => {
    const result = validateUnitBudgets({
      estimatedInputTokens: 1000,
      maxOutputTokens: MODEL_MAX_OUTPUT_TOKENS + 1,
      inputBudget: 64000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("OUTPUT_CEILING_EXCEEDED");
  });

  test("rejects input above the local hard ceiling", () => {
    const result = validateUnitBudgets({
      estimatedInputTokens: 1000,
      maxOutputTokens: 32768,
      inputBudget: MODEL_MAX_INPUT_TOKENS + 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INPUT_CEILING_EXCEEDED");
  });

  test("rejects budgets whose reserve exceeds context", () => {
    const result = validateUnitBudgets({
      estimatedInputTokens: 1000,
      maxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
      inputBudget: MODEL_MAX_INPUT_TOKENS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("BUDGET_EXCEEDS_CONTEXT");
  });
});

describe("catalog limit metadata", () => {
  test("accepts complete metadata", () => {
    expect(resolveCatalogLimits({ limit: { context: 200000, output: 65536 } })).toEqual({
      ok: true,
      limits: { contextTokens: 200000, maxOutputTokens: 65536 },
    });
  });

  test("falls back from context to input", () => {
    expect(resolveCatalogLimits({ limit: { input: 200000, output: 65536 } })).toEqual({
      ok: true,
      limits: { contextTokens: 200000, maxOutputTokens: 65536 },
    });
  });

  test("rejects missing or incomplete metadata", () => {
    for (const entry of [
      undefined,
      null,
      {},
      { limit: null },
      { limit: {} },
      { limit: { context: 200000 } },
      { limit: { output: 65536 } },
      { limit: { context: 0, output: 65536 } },
      { limit: { context: -1, output: 65536 } },
      { limit: { context: 200000, output: 0 } },
      { limit: { context: "big", output: 65536 } },
      { limit: { context: 200000, output: 65.5 } },
    ]) {
      const result = resolveCatalogLimits(entry);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("config load rejects impossible budgets", () => {
  test("accepts each ceiling individually with defaults elsewhere", () => {
    expect(ConfigFileSchema.parse({ llm: { max_output_tokens: MODEL_MAX_OUTPUT_TOKENS } }).llm.max_output_tokens).toBe(
      MODEL_MAX_OUTPUT_TOKENS,
    );
    expect(
      ConfigFileSchema.parse({ llm: { max_review_unit_input_tokens: MODEL_MAX_INPUT_TOKENS } }).llm
        .max_review_unit_input_tokens,
    ).toBe(MODEL_MAX_INPUT_TOKENS);
  });

  test("rejects zero output and unknown over-ceiling values", () => {
    expect(() => ConfigFileSchema.parse({ llm: { max_output_tokens: 0 } })).toThrow();
    expect(() => ConfigFileSchema.parse({ llm: { max_output_tokens: MODEL_MAX_OUTPUT_TOKENS + 1 } })).toThrow();
    expect(() =>
      ConfigFileSchema.parse({ llm: { max_review_unit_input_tokens: MODEL_MAX_INPUT_TOKENS + 1 } }),
    ).toThrow();
  });

  test("rejects input plus reserved output that cannot fit context", () => {
    expect(() =>
      ConfigFileSchema.parse({
        llm: { max_review_unit_input_tokens: MODEL_MAX_INPUT_TOKENS, max_output_tokens: MODEL_MAX_OUTPUT_TOKENS },
      }),
    ).toThrow();
  });
});

describe("engine pre-request enforcement", () => {
  test("reviews a unit exactly at the effective ceiling", async () => {
    const probe = buildReviewPrompt(unit(), configWith());
    expect(probe.estimatedInputTokens).toBeGreaterThan(1000);
    const provider = new FakeProvider([{ respond: { findings: [rawFinding()] } }]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    const { findings } = await engine.review(
      [unit()],
      configWith({ max_review_unit_input_tokens: probe.estimatedInputTokens }),
    );
    expect(findings).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
  });

  test("skips a unit one token over the ceiling with no provider call", async () => {
    const probe = buildReviewPrompt(unit(), configWith());
    expect(probe.estimatedInputTokens).toBeGreaterThan(1000);
    const provider = new FakeProvider([{ respond: { findings: [rawFinding()] } }]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    const result = await engine.review(
      [unit()],
      configWith({ max_review_unit_input_tokens: probe.estimatedInputTokens - 1 }),
    );
    expect(result.findings).toEqual([]);
    expect(provider.calls).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      stage: "prompt",
      code: "INPUT_BUDGET_EXCEEDED",
      retryable: false,
    });
  });

  test("sends the maximum output ceiling when configured", async () => {
    const provider = new FakeProvider([{ respond: { findings: [rawFinding()] } }]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    await engine.review([unit()], configWith({ max_output_tokens: MODEL_MAX_OUTPUT_TOKENS }));
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.maxTokens).toBe(MODEL_MAX_OUTPUT_TOKENS);
  });

  test("throws before any provider call when budgets cannot fit context", async () => {
    const base = configWith();
    const impossible: ResolvedConfig = {
      ...base,
      llm: {
        ...base.llm,
        max_review_unit_input_tokens: MODEL_MAX_INPUT_TOKENS,
        max_output_tokens: MODEL_MAX_OUTPUT_TOKENS,
      },
    };
    const provider = new FakeProvider([{ respond: { findings: [rawFinding()] } }]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    const error = await codeOf(engine.review([unit()], impossible));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(provider.calls).toHaveLength(0);
  });
});

describe("provider pre-request enforcement", () => {
  test("rejects maxTokens above the ceiling without a request", async () => {
    const provider = new OpenCodeProvider({ env: GATE, version: "0.1.0", fetchFn: neverFetch() });
    const error = await codeOf(provider.complete({ system: "s", user: "u", maxTokens: MODEL_MAX_OUTPUT_TOKENS + 1 }));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain(String(MODEL_MAX_OUTPUT_TOKENS));
  });

  test("rejects invalid maxTokens without a request", async () => {
    const provider = new OpenCodeProvider({ env: GATE, version: "0.1.0", fetchFn: neverFetch() });
    for (const maxTokens of [0, -10, 1.5, Number.NaN]) {
      const error = await codeOf(provider.complete({ system: "s", user: "u", maxTokens }));
      expect(error.code).toBe("CONFIG_INVALID");
    }
  });

  test("rejects prompts that cannot fit context without a request", async () => {
    const provider = new OpenCodeProvider({ env: GATE, version: "0.1.0", fetchFn: neverFetch() });
    // Estimator runs ~0.29 tokens/byte, so ~3.6 MB of text overflows the window.
    const error = await codeOf(provider.complete({ system: "s", user: "x".repeat(3_600_000), maxTokens: 32768 }));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("context ceiling");
  });

  test("sends the maximum output ceiling when it fits", async () => {
    const seen: string[] = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit): Promise<Response> => {
      seen.push(String(init?.body));
      return new Response(
        JSON.stringify({
          status: "completed",
          model: "m",
          output_text: "{}",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const provider = new OpenCodeProvider({ env: GATE, version: "0.1.0", fetchFn });
    await provider.complete({ system: "s", user: "u", maxTokens: MODEL_MAX_OUTPUT_TOKENS });
    expect(seen).toHaveLength(1);
    expect((JSON.parse(seen[0] as string) as Record<string, unknown>)["max_output_tokens"]).toBe(
      MODEL_MAX_OUTPUT_TOKENS,
    );
  });

  test("rejects malformed catalog metadata at construction", () => {
    for (const modelLimits of [{}, { limit: { context: 100 } }, { limit: { context: 0, output: 10 } }]) {
      expect(() => new OpenCodeProvider({ env: GATE, version: "0.1.0", modelLimits })).toThrow();
    }
  });

  test("tightens ceilings from valid catalog metadata but never widens them", async () => {
    const tightened = new OpenCodeProvider({
      env: GATE,
      version: "0.1.0",
      fetchFn: neverFetch(),
      modelLimits: { limit: { context: 200000, output: 1000 } },
    });
    const overTight = await codeOf(tightened.complete({ system: "s", user: "u", maxTokens: 2000 }));
    expect(overTight.code).toBe("CONFIG_INVALID");

    const widened = new OpenCodeProvider({
      env: GATE,
      version: "0.1.0",
      fetchFn: neverFetch(),
      modelLimits: { limit: { context: 999_999_999, output: 999_999_999 } },
    });
    const overLocal = await codeOf(
      widened.complete({ system: "s", user: "u", maxTokens: MODEL_MAX_OUTPUT_TOKENS + 1 }),
    );
    expect(overLocal.code).toBe("CONFIG_INVALID");
  });
});
