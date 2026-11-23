import { describe, expect, test } from "bun:test";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import type { ResolvedConfig } from "../../src/config/schema.ts";
import { ReviewerError } from "../../src/core/errors.ts";
import { TRAINING_OPT_IN_ENV } from "../../src/llm/constants.ts";
import { FakeProvider } from "../../src/providers/fake.ts";
import { ConventionAdvisoryReviewEngineImpl } from "../../src/review/convention-engine.ts";
import { CONVENTION_ADVISORY_PROMPT_VERSION } from "../../src/review/convention-prompt.ts";
import type { ConventionAdvisoryBatchInput, ConventionAdvisoryUnit } from "../../src/types/conventions.ts";
import { estimateTokens } from "../../src/utils/tokens.ts";

const OPT_IN_ENV = { [TRAINING_OPT_IN_ENV]: "true" };

function testConfig(): ResolvedConfig {
  return ConfigFileSchema.parse({});
}

function unit(overrides: Partial<ConventionAdvisoryUnit> & { unitId: string }): ConventionAdvisoryUnit {
  return {
    path: "src/a.ts",
    language: "typescript",
    symbol: { name: "f", kind: "function", signature: "f(): number", side: "head", startLine: 1 },
    diffHunks: [
      { baseStartLine: 1, headStartLine: 1, lines: [" export function f(): number {", "+  return 2;", " }"] },
    ],
    changedSymbolSource: "export function f(): number {\n  return 2;\n}",
    ...overrides,
  };
}

function batch(): ConventionAdvisoryBatchInput {
  return {
    units: [
      unit({ unitId: "unit-1", path: "src/a.ts" }),
      unit({
        unitId: "unit-2",
        path: "src/b.ts",
        symbol: { name: "g", kind: "function", signature: "g(): void", side: "head", startLine: 5 },
      }),
    ],
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

function rawFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Default export breaks the named-export convention",
    severity: "low",
    category: "convention",
    file: "src/a.ts",
    line: 2,
    description: "The change adds a default export where the repository uses named exports.",
    confidence: 0.5,
    evidence: [{ file: "src/a.ts", startLine: 2, endLine: 2, quote: "export default f;" }],
    introducedByPr: true,
    ...overrides,
  };
}

function responseFor(entries: Array<{ unitId: string; file: string; line: number }>): string {
  return JSON.stringify({
    findings: entries.map((entry) => ({
      unitId: entry.unitId,
      finding: rawFinding({ file: entry.file, line: entry.line }),
    })),
  });
}

describe("convention advisory engine happy path", () => {
  test("one provider call per batch with trusted provenance and deterministic order", async () => {
    const provider = new FakeProvider([
      {
        respond: responseFor([
          { unitId: "unit-2", file: "src/b.ts", line: 6 },
          { unitId: "unit-1", file: "src/a.ts", line: 2 },
        ]),
        usage: { inputTokens: 111, outputTokens: 22 },
      },
    ]);
    const engine = new ConventionAdvisoryReviewEngineImpl({
      provider,
      env: OPT_IN_ENV,
      headSha: "a".repeat(40),
    });
    const result = await engine.reviewBatch(batch(), testConfig());
    expect(provider.calls).toHaveLength(1);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.unitId)).toEqual(["unit-1", "unit-2"]);
    for (const candidate of result.candidates) {
      expect(candidate.finding.category).toBe("convention");
      expect(candidate.finding.severity).toBe("low");
      expect(candidate.finding.ruleId).toBeUndefined();
      expect(candidate.finding.origin).toEqual({ pass: "convention-advisory", unitId: candidate.unitId });
      expect(candidate.finding.headSha).toBe("a".repeat(40));
      expect(candidate.finding.id.length).toBeGreaterThan(0);
      expect(candidate.finding.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(result.candidates[0]?.finding.symbol).toBe("f");
    expect(result.candidates[1]?.finding.symbol).toBe("g");
    expect(result.inputTokens).toBe(111);
    expect(result.outputTokens).toBe(22);
    expect(result.codes).toEqual([]);
  });

  test("uses the advisory prompt version and the output token ceiling", async () => {
    const provider = new FakeProvider([{ respond: JSON.stringify({ findings: [] }) }]);
    const engine = new ConventionAdvisoryReviewEngineImpl({ provider, env: OPT_IN_ENV });
    const config = testConfig();
    await engine.reviewBatch(batch(), config);
    expect(provider.calls).toHaveLength(1);
    const request = provider.calls[0]!;
    expect(request.maxTokens).toBe(1200);
    expect(request.timeoutMs).toBe(config.llm.request_timeout_ms);
    expect(request.system).toContain(CONVENTION_ADVISORY_PROMPT_VERSION);
  });

  test("falls back to estimated output tokens when the provider reports no usage", async () => {
    const provider = new FakeProvider([{ respond: JSON.stringify({ findings: [] }) }]);
    const engine = new ConventionAdvisoryReviewEngineImpl({ provider, env: OPT_IN_ENV });
    const result = await engine.reviewBatch(batch(), testConfig());
    const request = provider.calls[0]!;
    expect(result.inputTokens).toBe(estimateTokens(`${request.system}\n${request.user}`));
    expect(result.outputTokens).toBe(estimateTokens(JSON.stringify({ findings: [] })));
  });

  test("assigns identifiers through the injected generator", async () => {
    const provider = new FakeProvider([{ respond: responseFor([{ unitId: "unit-1", file: "src/a.ts", line: 2 }]) }]);
    const engine = new ConventionAdvisoryReviewEngineImpl({
      provider,
      env: OPT_IN_ENV,
      generateId: () => "fixed-advisory-id",
    });
    const result = await engine.reviewBatch(
      { units: [unit({ unitId: "unit-1" })], conventions: batch().conventions },
      testConfig(),
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.finding.id).toBe("fixed-advisory-id");
  });
});

describe("convention advisory engine gating", () => {
  test("denied training gate performs no provider call", async () => {
    const provider = new FakeProvider([{ respond: JSON.stringify({ findings: [] }) }]);
    const engine = new ConventionAdvisoryReviewEngineImpl({ provider, env: {} });
    const promise = engine.reviewBatch(batch(), testConfig());
    await expect(promise).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(provider.calls).toHaveLength(0);
  });

  test("empty units skip without a provider call", async () => {
    const provider = new FakeProvider([{ respond: JSON.stringify({ findings: [] }) }]);
    const engine = new ConventionAdvisoryReviewEngineImpl({ provider, env: OPT_IN_ENV });
    const result = await engine.reviewBatch({ units: [], conventions: batch().conventions }, testConfig());
    expect(result.candidates).toEqual([]);
    expect(provider.calls).toHaveLength(0);
    expect(result.codes).toEqual(["advisory_skipped_no_units"]);
  });

  test("empty conventions skip without a provider call", async () => {
    const provider = new FakeProvider([{ respond: JSON.stringify({ findings: [] }) }]);
    const engine = new ConventionAdvisoryReviewEngineImpl({ provider, env: OPT_IN_ENV });
    const result = await engine.reviewBatch({ units: batch().units, conventions: [] }, testConfig());
    expect(result.candidates).toEqual([]);
    expect(provider.calls).toHaveLength(0);
    expect(result.codes).toEqual(["advisory_skipped_no_conventions"]);
  });

  test("oversized input fails closed before any provider call", async () => {
    const provider = new FakeProvider([{ respond: JSON.stringify({ findings: [] }) }]);
    const engine = new ConventionAdvisoryReviewEngineImpl({ provider, env: OPT_IN_ENV });
    const oversized = unit({ unitId: "big", changedSymbolSource: `${"x".repeat(8000)}\n` });
    const promise = engine.reviewBatch(
      { units: [oversized, oversized, oversized], conventions: batch().conventions },
      testConfig(),
    );
    await expect(promise).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(provider.calls).toHaveLength(0);
  });

  test("rejects batches larger than three units before any provider call", async () => {
    const provider = new FakeProvider([{ respond: JSON.stringify({ findings: [] }) }]);
    const engine = new ConventionAdvisoryReviewEngineImpl({ provider, env: OPT_IN_ENV });
    const units = [unit({ unitId: "u-1" }), unit({ unitId: "u-2" }), unit({ unitId: "u-3" }), unit({ unitId: "u-4" })];
    const promise = engine.reviewBatch({ units, conventions: batch().conventions }, testConfig());
    await expect(promise).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(provider.calls).toHaveLength(0);
  });

  test("rejects control-character paths before any provider call", async () => {
    const provider = new FakeProvider([{ respond: JSON.stringify({ findings: [] }) }]);
    const engine = new ConventionAdvisoryReviewEngineImpl({ provider, env: OPT_IN_ENV });
    const bad = unit({ unitId: "bad", path: "src/bad\u0007.ts" });
    const promise = engine.reviewBatch({ units: [bad], conventions: batch().conventions }, testConfig());
    await expect(promise).rejects.toBeInstanceOf(ReviewerError);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("convention advisory engine single-attempt failures", () => {
  test("transport failure propagates after exactly one provider call", async () => {
    const provider = new FakeProvider([
      { respond: new ReviewerError({ code: "PROVIDER_FAILED", message: "rate limited", retryable: true }) },
    ]);
    const engine = new ConventionAdvisoryReviewEngineImpl({ provider, env: OPT_IN_ENV });
    const promise = engine.reviewBatch(batch(), testConfig());
    await expect(promise).rejects.toMatchObject({ code: "PROVIDER_FAILED" });
    expect(provider.calls).toHaveLength(1);
  });

  test("malformed json drops the batch after exactly one provider call", async () => {
    const provider = new FakeProvider([{ respond: "not json at all" }]);
    const engine = new ConventionAdvisoryReviewEngineImpl({ provider, env: OPT_IN_ENV });
    const promise = engine.reviewBatch(batch(), testConfig());
    await expect(promise).rejects.toMatchObject({ code: "PROVIDER_BAD_OUTPUT" });
    expect(provider.calls).toHaveLength(1);
  });

  test.each([
    ["unknown unitId", [{ unitId: "nope", file: "src/a.ts", line: 2 }]],
    [
      "duplicate unitId",
      [
        { unitId: "unit-1", file: "src/a.ts", line: 2 },
        { unitId: "unit-1", file: "src/a.ts", line: 3 },
      ],
    ],
    [
      "two findings for one unit",
      [
        { unitId: "unit-1", file: "src/a.ts", line: 2 },
        { unitId: "unit-1", file: "src/a.ts", line: 2 },
      ],
    ],
  ])("%s drops the batch after exactly one provider call", async (_label, entries) => {
    const provider = new FakeProvider([{ respond: responseFor(entries) }]);
    const engine = new ConventionAdvisoryReviewEngineImpl({ provider, env: OPT_IN_ENV });
    const promise = engine.reviewBatch(batch(), testConfig());
    await expect(promise).rejects.toMatchObject({ code: "PROVIDER_BAD_OUTPUT" });
    expect(provider.calls).toHaveLength(1);
  });

  test("non-low severity drops the batch without coercion", async () => {
    const provider = new FakeProvider([
      { respond: JSON.stringify({ findings: [{ unitId: "unit-1", finding: rawFinding({ severity: "medium" }) }] }) },
    ]);
    const engine = new ConventionAdvisoryReviewEngineImpl({ provider, env: OPT_IN_ENV });
    const promise = engine.reviewBatch(
      { units: [unit({ unitId: "unit-1" })], conventions: batch().conventions },
      testConfig(),
    );
    await expect(promise).rejects.toMatchObject({ code: "PROVIDER_BAD_OUTPUT" });
    expect(provider.calls).toHaveLength(1);
  });

  test("non-convention category drops the batch without coercion", async () => {
    const provider = new FakeProvider([
      { respond: JSON.stringify({ findings: [{ unitId: "unit-1", finding: rawFinding({ category: "bug" }) }] }) },
    ]);
    const engine = new ConventionAdvisoryReviewEngineImpl({ provider, env: OPT_IN_ENV });
    const promise = engine.reviewBatch(
      { units: [unit({ unitId: "unit-1" })], conventions: batch().conventions },
      testConfig(),
    );
    await expect(promise).rejects.toMatchObject({ code: "PROVIDER_BAD_OUTPUT" });
    expect(provider.calls).toHaveLength(1);
  });

  test("present ruleId drops the batch", async () => {
    const provider = new FakeProvider([
      { respond: JSON.stringify({ findings: [{ unitId: "unit-1", finding: rawFinding({ ruleId: "no-x" }) }] }) },
    ]);
    const engine = new ConventionAdvisoryReviewEngineImpl({ provider, env: OPT_IN_ENV });
    const promise = engine.reviewBatch(
      { units: [unit({ unitId: "unit-1" })], conventions: batch().conventions },
      testConfig(),
    );
    await expect(promise).rejects.toMatchObject({ code: "PROVIDER_BAD_OUTPUT" });
    expect(provider.calls).toHaveLength(1);
  });

  test("model-supplied provenance keys drop the batch", async () => {
    const forged = {
      ...rawFinding(),
      origin: { pass: "primary", unitId: "unit-1" },
      id: "forged",
      fingerprint: "forged",
      headSha: "0".repeat(40),
    };
    const provider = new FakeProvider([
      { respond: JSON.stringify({ findings: [{ unitId: "unit-1", finding: forged }] }) },
    ]);
    const engine = new ConventionAdvisoryReviewEngineImpl({ provider, env: OPT_IN_ENV });
    const promise = engine.reviewBatch(
      { units: [unit({ unitId: "unit-1" })], conventions: batch().conventions },
      testConfig(),
    );
    await expect(promise).rejects.toMatchObject({ code: "PROVIDER_BAD_OUTPUT" });
    expect(provider.calls).toHaveLength(1);
  });

  test("sequential batches map one-to-one onto provider calls", async () => {
    const provider = new FakeProvider([
      { respond: JSON.stringify({ findings: [] }) },
      { respond: JSON.stringify({ findings: [] }) },
      { respond: JSON.stringify({ findings: [] }) },
    ]);
    const engine = new ConventionAdvisoryReviewEngineImpl({ provider, env: OPT_IN_ENV });
    const config = testConfig();
    await engine.reviewBatch(batch(), config);
    await engine.reviewBatch(batch(), config);
    await engine.reviewBatch(batch(), config);
    expect(provider.calls).toHaveLength(3);
  });
});
