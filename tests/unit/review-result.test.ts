import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigFileSchema, type ResolvedConfig } from "../../src/config/schema.ts";
import { API_KEY_ENV, FIXED_MODEL_ID } from "../../src/llm/constants.ts";
import { createLogger } from "../../src/core/logger.ts";
import { runPipeline } from "../../src/core/pipeline.ts";
import type { Logger } from "../../src/core/logger.ts";
import { OpenCodeProvider } from "../../src/providers/opencode.ts";
import { FakeProvider } from "../../src/providers/fake.ts";
import { ReviewEngineImpl } from "../../src/review/engine.ts";
import { CODE_REVIEW_PROMPT_VERSION } from "../../src/review/prompt.ts";
import { skippedReviewResult } from "../../src/review/result.ts";
import type { ReviewUnit } from "../../src/types/context.ts";
import type { Rule } from "../../src/types/rules.ts";
import { createFixtureEngines } from "../fixtures/stubs.ts";

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

describe("review build result", () => {
  test("completes with findings and code-owned metadata", async () => {
    const provider = new FakeProvider([{ respond: { findings: [rawFinding()] } }]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    const result = await engine.review([unit()], configWith());
    expect(result.status).toBe("complete");
    expect(result.findings).toHaveLength(1);
    expect(result.diagnostics).toEqual([]);
    expect(result.unitsSubmitted).toBe(1);
    expect(result.unitsReviewed).toBe(1);
    expect(result.unitsFailed).toBe(0);
    expect(result.promptVersion).toBe(CODE_REVIEW_PROMPT_VERSION);
    expect(result.promptHash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.model).toBe(FIXED_MODEL_ID);
    expect(result.usage.requests).toBe(1);
    expect(result.usage.repairRequests).toBe(0);
    expect(result.usage.incompleteRetries).toBe(0);
  });

  test("completes with no findings on empty model output", async () => {
    const provider = new FakeProvider([{ respond: { findings: [] } }]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    const result = await engine.review([unit()], configWith());
    expect(result.status).toBe("complete");
    expect(result.findings).toEqual([]);
    expect(result.unitsReviewed).toBe(1);
    expect(result.unitsFailed).toBe(0);
  });

  test("stays partial when one unit fails and keeps good findings", async () => {
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
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    const result = await engine.review([good, bad], configWith());
    expect(result.status).toBe("partial");
    expect(result.findings.map((finding) => finding.title)).toEqual(["good bug"]);
    expect(result.unitsSubmitted).toBe(2);
    expect(result.unitsReviewed).toBe(1);
    expect(result.unitsFailed).toBe(1);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ unitId: "u-bad", retryable: false });
  });

  test("fails when every unit fails", async () => {
    const provider = new FakeProvider([{ respond: new Error("down-1") }, { respond: new Error("down-2") }]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    const result = await engine.review([unit({ id: "u-1" }), unit({ id: "u-2" })], configWith());
    expect(result.status).toBe("failed");
    expect(result.findings).toEqual([]);
    expect(result.unitsSubmitted).toBe(2);
    expect(result.unitsReviewed).toBe(0);
    expect(result.unitsFailed).toBe(2);
    expect(result.diagnostics).toHaveLength(2);
  });

  test("skipped factory carries zero counts for the no-llm path", () => {
    const provider = new FakeProvider([{ respond: { findings: [rawFinding()] } }]);
    const result = skippedReviewResult();
    expect(result.status).toBe("skipped");
    expect(result.findings).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.unitsSubmitted).toBe(0);
    expect(result.unitsReviewed).toBe(0);
    expect(result.unitsFailed).toBe(0);
    expect(result.usage).toMatchObject({
      requests: 0,
      retries: 0,
      repairRequests: 0,
      incompleteRetries: 0,
      costKnown: false,
    });
    expect(result.promptVersion).toBe(CODE_REVIEW_PROMPT_VERSION);
    expect(result.model).toBe(FIXED_MODEL_ID);
    expect(provider.calls).toHaveLength(0);
  });

  test("aggregates known usage and provider cost", async () => {
    const provider = new FakeProvider([
      {
        respond: { findings: [rawFinding({ title: "bug-a" })] },
        usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 5 },
        costUsd: 0.001,
      },
      {
        respond: { findings: [rawFinding({ title: "bug-b" })] },
        usage: { inputTokens: 50, outputTokens: 10 },
        costUsd: 0.0005,
      },
    ]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    const result = await engine.review(
      [unit({ id: "u-1" }), unit({ id: "u-2" })],
      configWith({ max_concurrent_requests: 1 }),
    );
    expect(result.status).toBe("complete");
    expect(result.usage.inputTokens).toBe(150);
    expect(result.usage.outputTokens).toBe(30);
    expect(result.usage.reasoningTokens).toBe(5);
    expect(result.usage.totalTokens).toBe(180);
    expect(result.usage.costKnown).toBe(true);
    expect(result.usage.costUsd).toBeCloseTo(0.0015, 10);
  });

  test("leaves usage unknown when the provider reports none", async () => {
    const provider = new FakeProvider([{ respond: { findings: [rawFinding()] } }]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    const result = await engine.review([unit()], configWith());
    expect(result.usage.inputTokens).toBeUndefined();
    expect(result.usage.outputTokens).toBeUndefined();
    expect(result.usage.totalTokens).toBeUndefined();
    expect(result.usage.costKnown).toBe(false);
    expect(result.usage.costUsd).toBeUndefined();
  });

  test("keeps cost unknown when usage is known but cost is not reported", async () => {
    const provider = new FakeProvider([{ respond: { findings: [] }, usage: { inputTokens: 12, outputTokens: 3 } }]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    const result = await engine.review([unit()], configWith());
    expect(result.usage.inputTokens).toBe(12);
    expect(result.usage.costKnown).toBe(false);
    expect(result.usage.costUsd).toBeUndefined();
  });

  test("counts one repair request without failing the unit", async () => {
    const provider = new FakeProvider([
      { respond: "not json", usage: { inputTokens: 10, outputTokens: 2 } },
      { respond: { findings: [rawFinding()] }, usage: { inputTokens: 12, outputTokens: 4 } },
    ]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    const result = await engine.review([unit()], configWith());
    expect(result.status).toBe("complete");
    expect(result.findings).toHaveLength(1);
    expect(result.usage.requests).toBe(2);
    expect(result.usage.repairRequests).toBe(1);
    expect(result.usage.inputTokens).toBe(22);
    expect(result.usage.outputTokens).toBe(6);
  });

  test("counts the bounded incomplete retry without repair", async () => {
    const incomplete = { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
    const queue = [
      new Response(JSON.stringify(incomplete), {
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
    const fetchFn = (async (): Promise<Response> => {
      const next = queue.shift();
      if (next === undefined) throw new Error("fetch mock exhausted");
      return next;
    }) as unknown as typeof fetch;
    const provider = new OpenCodeProvider({
      env: { ...OPT_IN, [API_KEY_ENV]: "dummy-key" },
      version: "0.1.0",
      fetchFn,
    });
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    const result = await engine.review([unit()], configWith({ max_output_tokens: 1000 }));
    expect(result.status).toBe("complete");
    expect(result.findings).toHaveLength(1);
    expect(result.usage.requests).toBe(2);
    expect(result.usage.repairRequests).toBe(0);
    expect(result.usage.incompleteRetries).toBe(1);
    expect(result.usage.inputTokens).toBe(10);
  });

  test("marks exhausted incomplete output with a terminal diagnostic", async () => {
    const incomplete = { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
    const queue = [incomplete, incomplete].map(
      (body) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const fetchFn = (async (): Promise<Response> => {
      const next = queue.shift();
      if (next === undefined) throw new Error("fetch mock exhausted");
      return next;
    }) as unknown as typeof fetch;
    const provider = new OpenCodeProvider({
      env: { ...OPT_IN, [API_KEY_ENV]: "dummy-key" },
      version: "0.1.0",
      fetchFn,
    });
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    const result = await engine.review([unit()], configWith({ max_output_tokens: 1000 }));
    expect(result.status).toBe("failed");
    expect(result.findings).toEqual([]);
    expect(result.usage.incompleteRetries).toBe(1);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      stage: "provider",
      code: "REVIEW_OUTPUT_INCOMPLETE",
      unitId: "unit-1",
      retryable: false,
    });
  });

  test("records rejected findings as normalize diagnostics and keeps siblings", async () => {
    const provider = new FakeProvider([
      {
        respond: {
          findings: [rawFinding({ title: "good bug" }), rawFinding({ title: "bad path", file: "/abs/evil.ts" })],
        },
      },
    ]);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    const result = await engine.review([unit()], configWith());
    expect(result.status).toBe("complete");
    expect(result.findings.map((finding) => finding.title)).toEqual(["good bug"]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      stage: "normalize",
      code: "FINDING_REJECTED",
      unitId: "unit-1",
      retryable: false,
    });
    expect(JSON.stringify(result.diagnostics[0])).not.toContain("evil");
  });

  test("marks an over-budget unit partial with a prompt diagnostic", async () => {
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
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    const result = await engine.review(
      [big, unit({ id: "u-small" })],
      configWith({ max_review_unit_input_tokens: 2000 }),
    );
    expect(result.status).toBe("partial");
    expect(result.unitsSubmitted).toBe(2);
    expect(result.unitsReviewed).toBe(1);
    expect(result.unitsFailed).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      stage: "prompt",
      code: "INPUT_BUDGET_EXCEEDED",
      unitId: "u-big",
      retryable: false,
    });
    expect(provider.calls).toHaveLength(1);
  });

  test("redacts secret bytes from diagnostic messages", async () => {
    const secret = "zxqv-custom-9f8e7d6c5b4a";
    const provider = new FakeProvider([{ respond: new Error(`socket hung up on ${secret}`) }]);
    const engine = new ReviewEngineImpl({
      provider,
      logger: nullLogger(),
      env: { ...OPT_IN },
      secrets: [secret],
    });
    const result = await engine.review([unit()], configWith());
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result.diagnostics)).not.toContain(secret);
  });

  test("bounds diagnostics while keeping full failure counts", async () => {
    const steps = Array.from({ length: 105 }, () => ({ respond: new Error("down") }));
    const provider = new FakeProvider(steps);
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    const units = Array.from({ length: 105 }, (_, index) => unit({ id: `u-${index}` }));
    const result = await engine.review(units, configWith({ max_concurrent_requests: 5 }));
    expect(result.status).toBe("failed");
    expect(result.unitsFailed).toBe(105);
    expect(result.diagnostics.length).toBeLessThanOrEqual(100);
  });

  test("provider surfaces reasoning tokens and reported cost", async () => {
    const fetchFn = (async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          status: "completed",
          model: FIXED_MODEL_ID,
          output_text: "ok",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            output_tokens_details: { reasoning_tokens: 4 },
            cost: 0.002,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;
    const provider = new OpenCodeProvider({ env: { ...OPT_IN, [API_KEY_ENV]: "k" }, fetchFn });
    const res = await provider.complete({ system: "s", user: "u" });
    expect(res.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, reasoningTokens: 4 });
    expect(res.costUsd).toBe(0.002);
  });
});

describe("review run artifact", () => {
  async function makeOutDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
    const base = await mkdtemp(join(tmpdir(), "codebleach-p4-07-"));
    const dir = join(base, "out");
    return { dir, cleanup: () => rm(base, { recursive: true, force: true }) };
  }

  test("pipeline persists review status, usage, and diagnostics", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      await runPipeline(
        { ...fixture, logger: createLogger({ level: "error", runId: "p4-07" }) },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: true, outDir: dir, runId: "run-p4-07" },
      );
      const artifact = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
      expect(artifact.runId).toBe("run-p4-07");
      expect(artifact.reviewStatus).toBe("complete");
      expect(artifact.reviewPromptVersion).toBe("test-pass");
      expect(artifact.reviewModel).toBe("test-model");
      expect(artifact.reviewUnitsSubmitted).toBe(1);
      expect(artifact.reviewUnitsReviewed).toBe(1);
      expect(artifact.reviewUnitsFailed).toBe(0);
      expect(artifact.reviewUsage).toMatchObject({ requests: 1, costKnown: false });
      expect(artifact.reviewDiagnostics).toEqual([]);
      expect(artifact.findings).toHaveLength(1);
      const reviewStage = artifact.stages.find((stage: { name: string }) => stage.name === "review");
      expect(reviewStage.status).toBe("completed");
      expect(typeof reviewStage.ms).toBe("number");
    } finally {
      await cleanup();
    }
  });

  test("artifact carries no raw prompts or provider bodies", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      await runPipeline(
        { ...fixture, logger: createLogger({ level: "error", runId: "p4-07" }) },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: true, outDir: dir, runId: "run-p4-07" },
      );
      const text = await readFile(join(dir, "run.json"), "utf8");
      expect(text).not.toContain("untrusted repository data");
      expect(text).not.toContain("output_text");
    } finally {
      await cleanup();
    }
  });
});
