import { describe, expect, test } from "bun:test";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import type { ResolvedConfig } from "../../src/config/schema.ts";
import { ReviewerError } from "../../src/core/errors.ts";
import type { Logger } from "../../src/core/logger.ts";
import { FakeProvider } from "../../src/providers/fake.ts";
import {
  failReviewUnit,
  isIncompleteCapError,
  runReviewUnit,
  type UnitRunnerDeps,
} from "../../src/review/unit-runner.ts";
import { emptyReviewUsage } from "../../src/review/result.ts";
import type { ReviewUnit } from "../../src/types/context.ts";

function nullLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function depsFor(provider: FakeProvider, secrets: string[] = []): UnitRunnerDeps {
  return { provider, logger: nullLogger(), env: {}, secrets };
}

function unit(overrides: Partial<ReviewUnit> = {}): ReviewUnit {
  return {
    id: "unit-1",
    file: {
      path: "src/auth.ts",
      oldPath: null,
      status: "modified",
      language: "typescript",
      commentableLines: [9],
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
    symbol: { name: "check", kind: "function", startLine: 8, endLine: 14, changedLines: [9] },
    context: [],
    rules: [],
    ...overrides,
  };
}

function configWith(llm: Record<string, number> = {}): ResolvedConfig {
  return ConfigFileSchema.parse({ llm });
}

function ctx() {
  return {
    signal: new AbortController().signal,
    stopped: () => null,
    headSha: "head-abc",
    throwIfFatal: () => {},
  };
}

describe("runReviewUnit", () => {
  test("returns findings with accounted usage on success", async () => {
    const provider = new FakeProvider([{ respond: { findings: [] } }]);
    const outcome = await runReviewUnit(depsFor(provider), unit(), configWith(), ctx());
    expect(outcome.ok).toBe(true);
    expect(outcome.findings).toHaveLength(0);
    expect(outcome.usage.requests).toBe(1);
    expect(provider.calls).toHaveLength(1);
  });

  test("skips oversized units without calling the provider", async () => {
    const provider = new FakeProvider([{ respond: { findings: [] } }]);
    const outcome = await runReviewUnit(
      depsFor(provider),
      unit(),
      configWith({ max_review_unit_input_tokens: 1000 }),
      ctx(),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.diagnostics).toHaveLength(1);
    expect(outcome.diagnostics[0]).toMatchObject({ stage: "prompt", code: "INPUT_BUDGET_EXCEEDED" });
    expect(provider.calls).toHaveLength(0);
  });

  test("maps provider failure to a provider-stage diagnostic", async () => {
    const provider = new FakeProvider([
      { respond: new ReviewerError({ code: "PROVIDER_FAILED", message: "boom", retryable: true }) },
    ]);
    const outcome = await runReviewUnit(depsFor(provider), unit(), configWith(), ctx());
    expect(outcome.ok).toBe(false);
    expect(outcome.diagnostics).toHaveLength(1);
    expect(outcome.diagnostics[0]).toMatchObject({ stage: "provider", code: "PROVIDER_FAILED", retryable: true });
  });
});

describe("failReviewUnit", () => {
  test("redacts secret bytes from diagnostic text", () => {
    const outcome = failReviewUnit(
      depsFor(new FakeProvider([]), ["s3cr3t-key"]),
      unit(),
      new Error("request failed with s3cr3t-key inline"),
      emptyReviewUsage(),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.diagnostics[0]?.message).not.toContain("s3cr3t-key");
  });

  test("marks malformed model output as parse-stage", () => {
    const outcome = failReviewUnit(
      depsFor(new FakeProvider([])),
      unit(),
      new ReviewerError({ code: "PROVIDER_BAD_OUTPUT", message: "bad json" }),
      emptyReviewUsage(),
    );
    expect(outcome.diagnostics[0]).toMatchObject({ stage: "parse", code: "PROVIDER_BAD_OUTPUT" });
  });
});

describe("isIncompleteCapError", () => {
  test("matches only max_output_tokens incomplete failures", () => {
    expect(
      isIncompleteCapError(
        new ReviewerError({ code: "PROVIDER_FAILED", message: "x", incompleteReason: "max_output_tokens" }),
      ),
    ).toBe(true);
    expect(
      isIncompleteCapError(new ReviewerError({ code: "PROVIDER_FAILED", message: "x", incompleteReason: "unknown" })),
    ).toBe(false);
    expect(isIncompleteCapError(new Error("x"))).toBe(false);
  });
});
