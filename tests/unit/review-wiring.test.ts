import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import type { ResolvedConfig } from "../../src/config/schema.ts";
import { runPipeline } from "../../src/core/pipeline.ts";
import { createLogger } from "../../src/core/logger.ts";
import { stubValidationEngine } from "../../src/core/stubs.ts";
import { ReviewerError } from "../../src/core/errors.ts";
import { createRealReviewEngine } from "../../src/cli/commands/review.ts";
import { FakeProvider } from "../../src/providers/fake.ts";
import { ReviewEngineImpl } from "../../src/review/engine.ts";
import { skippedReviewResult } from "../../src/review/result.ts";
import type { Logger } from "../../src/core/logger.ts";
import type { ReviewUnit } from "../../src/types/context.ts";
import { createFixtureEngines } from "../fixtures/stubs.ts";

function nullLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function wiringUnit(): ReviewUnit {
  return {
    id: "unit-1",
    file: {
      path: "src/a.ts",
      oldPath: null,
      status: "modified",
      language: "typescript",
      commentableLines: [1],
    },
    diff: {
      hunks: [],
      originalHunkCount: 0,
      includedHunkCount: 0,
      omittedHunkCount: 0,
      truncated: false,
    },
    symbol: { name: "f", kind: "function", startLine: 1, endLine: 2, changedLines: [1] },
    context: [],
    rules: [],
  };
}

function rawFinding(): Record<string, unknown> {
  return {
    title: "Null dereference on name",
    severity: "high",
    category: "null-handling",
    file: "src/a.ts",
    line: 1,
    description: "name may be null at runtime; trim would throw.",
    confidence: 0.9,
    evidence: [{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "q" }],
    introducedByPr: true,
  };
}

describe("p4-09 review wiring", () => {
  test("engine prefers per-call headSha for code-owned attribution", async () => {
    const provider = new FakeProvider([{ respond: { findings: [rawFinding()] } }]);
    const engine = new ReviewEngineImpl({
      provider,
      logger: nullLogger(),
      env: { CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING: "true" },
    });
    const config = ConfigFileSchema.parse({});
    const result = await engine.review([wiringUnit()], config, { headSha: "diff-head" });
    expect(result.status).toBe("complete");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.headSha).toBe("diff-head");
  });

  test("pipeline passes diff headSha to the review engine", async () => {
    const base = await mkdtemp(join(tmpdir(), "codebleach-wiring-"));
    try {
      const fixture = createFixtureEngines();
      let seen: unknown;
      const recording = {
        requiresLlm: false,
        review: (units: ReviewUnit[], config: ResolvedConfig, options?: { headSha?: string }) => {
          seen = options?.headSha;
          return fixture.review.review(units, config);
        },
      };
      await runPipeline(
        { ...fixture, review: recording, logger: createLogger({ level: "error", runId: "wiring" }) },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: true, outDir: base, runId: "wiring" },
      );
      expect(seen).toBe("head");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("skipped review never reaches validation and records skip reasons", async () => {
    const base = await mkdtemp(join(tmpdir(), "codebleach-wiring-"));
    try {
      const fixture = createFixtureEngines();
      let validationCalls = 0;
      const summary = await runPipeline(
        {
          ...fixture,
          review: { review: () => Promise.resolve(skippedReviewResult()), requiresLlm: false },
          validation: {
            validate: () => {
              validationCalls += 1;
              return Promise.resolve([]);
            },
          },
          logger: createLogger({ level: "error", runId: "wiring-skip" }),
        },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: true,
          outDir: base,
          runId: "wiring-skip",
        },
      );
      expect(validationCalls).toBe(0);
      expect(summary.status).toBe("completed");
      expect(summary.stages.map((stage) => [stage.name, stage.status, stage.reason])).toEqual([
        ["config", "completed", undefined],
        ["diff", "completed", undefined],
        ["context", "completed", undefined],
        ["review", "skipped", "no_llm_flag"],
        ["validation", "skipped", "review_skipped_no_llm"],
        ["publish", "skipped", "dry-run"],
      ]);
      const artifact = JSON.parse(await readFile(join(base, "run.json"), "utf8"));
      expect(artifact.reviewStatus).toBe("skipped");
      expect(artifact.findings).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("real engine with FakeProvider still fails at validation NOT_IMPLEMENTED without --dry-run", async () => {
    const base = await mkdtemp(join(tmpdir(), "codebleach-wiring-"));
    try {
      const fixture = createFixtureEngines();
      const provider = new FakeProvider([{ respond: { findings: [rawFinding()] } }]);
      const review = new ReviewEngineImpl({
        provider,
        logger: nullLogger(),
        env: { CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING: "true" },
      });
      let publishCalls = 0;
      const promise = runPipeline(
        {
          ...fixture,
          review,
          validation: stubValidationEngine,
          publisher: {
            publish: () => {
              publishCalls += 1;
              return Promise.resolve({ published: 0, skipped: 0, failures: [] });
            },
          },
          logger: nullLogger(),
        },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: false,
          outDir: base,
          runId: "wiring-real",
          env: { CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING: "true", OPENCODE_API_KEY: "dummy-key" },
        },
      );
      const error = await promise.then(
        () => null,
        (failure: unknown) => failure as ReviewerError,
      );
      expect(error).toBeInstanceOf(ReviewerError);
      expect((error as ReviewerError).code).toBe("NOT_IMPLEMENTED");
      expect(publishCalls).toBe(0);
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0]?.user).toContain("src/a.ts");
      const artifact = JSON.parse(await readFile(join(base, "run.json"), "utf8"));
      expect(artifact.reviewStatus).toBe("complete");
      expect(artifact.findings).toHaveLength(1);
      expect(artifact.findings[0]).toMatchObject({ file: "src/a.ts", headSha: "head" });
      expect(artifact.error.code).toBe("NOT_IMPLEMENTED");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("live dry-run with a failing validator fails instead of skipping validation", async () => {
    const base = await mkdtemp(join(tmpdir(), "codebleach-wiring-"));
    try {
      const fixture = createFixtureEngines();
      const provider = new FakeProvider([{ respond: { findings: [rawFinding()] } }]);
      const review = new ReviewEngineImpl({
        provider,
        logger: nullLogger(),
        env: { CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING: "true" },
      });
      let publishCalls = 0;
      const promise = runPipeline(
        {
          ...fixture,
          review,
          validation: stubValidationEngine,
          publisher: {
            publish: () => {
              publishCalls += 1;
              return Promise.resolve({ published: 0, skipped: 0, failures: [] });
            },
          },
          logger: nullLogger(),
        },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: true,
          outDir: base,
          runId: "wiring-dryrun",
          env: { CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING: "true", OPENCODE_API_KEY: "dummy-key" },
        },
      );
      const error = await promise.then(
        () => null,
        (failure: unknown) => failure as ReviewerError,
      );
      // P5-09: the transitional NOT_IMPLEMENTED tolerance is removed. A real
      // validator exists, so any validation failure fails the stage, dry-run
      // included. Findings stay in the artifact for audit; nothing publishes.
      expect(error).toBeInstanceOf(ReviewerError);
      expect((error as ReviewerError).code).toBe("NOT_IMPLEMENTED");
      expect(publishCalls).toBe(0);
      expect(provider.calls).toHaveLength(1);
      const artifact = JSON.parse(await readFile(join(base, "run.json"), "utf8"));
      expect(artifact.status).toBe("failed");
      expect(artifact.reviewStatus).toBe("complete");
      expect(artifact.findings).toHaveLength(1);
      expect(artifact.findings[0]).toMatchObject({ file: "src/a.ts", headSha: "head" });
      expect(artifact.validated).toEqual([]);
      expect(artifact.publishResult).toBeNull();
      expect(artifact.error.code).toBe("NOT_IMPLEMENTED");
      expect(artifact.stages.map((stage: { name: string; status: string }) => [stage.name, stage.status])).toEqual([
        ["config", "completed"],
        ["diff", "completed"],
        ["context", "completed"],
        ["review", "completed"],
        ["validation", "failed"],
      ]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("dry-run never suppresses real validation errors", async () => {
    const base = await mkdtemp(join(tmpdir(), "codebleach-wiring-"));
    try {
      const fixture = createFixtureEngines();
      let publishCalls = 0;
      const promise = runPipeline(
        {
          ...fixture,
          validation: {
            validate: () => Promise.reject(new ReviewerError({ code: "INTERNAL", message: "boom" })),
          },
          publisher: {
            publish: () => {
              publishCalls += 1;
              return Promise.resolve({ published: 0, skipped: 0, failures: [] });
            },
          },
          logger: nullLogger(),
        },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: true, outDir: base, runId: "wiring-dryrun-err" },
      );
      const error = await promise.then(
        () => null,
        (failure: unknown) => failure as ReviewerError,
      );
      expect(error).toBeInstanceOf(ReviewerError);
      expect((error as ReviewerError).code).toBe("INTERNAL");
      expect(publishCalls).toBe(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("dry-run still blocks at the training gate with zero provider calls", async () => {
    const provider = new FakeProvider([{ respond: { findings: [rawFinding()] } }]);
    const review = new ReviewEngineImpl({
      provider,
      logger: nullLogger(),
      env: { OPENCODE_API_KEY: "dummy-key" },
    });
    const config = ConfigFileSchema.parse({});
    const error = await review.review([wiringUnit()], config).then(
      () => null,
      (failure: unknown) => failure as ReviewerError,
    );
    expect(error).toBeInstanceOf(ReviewerError);
    expect((error as ReviewerError).code).toBe("CONFIG_INVALID");
    expect(provider.calls).toHaveLength(0);
  });

  test("no-llm dry-run never invokes the publisher and records zero requests", async () => {
    const base = await mkdtemp(join(tmpdir(), "codebleach-wiring-"));
    try {
      const fixture = createFixtureEngines();
      let publishCalls = 0;
      const summary = await runPipeline(
        {
          ...fixture,
          review: { review: () => Promise.resolve(skippedReviewResult()), requiresLlm: false },
          validation: stubValidationEngine,
          publisher: {
            publish: () => {
              publishCalls += 1;
              return Promise.resolve({ published: 0, skipped: 0, failures: [] });
            },
          },
          logger: nullLogger(),
        },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: true, outDir: base, runId: "wiring-nollm" },
      );
      expect(summary.status).toBe("completed");
      expect(publishCalls).toBe(0);
      const artifact = JSON.parse(await readFile(join(base, "run.json"), "utf8"));
      expect(artifact.reviewStatus).toBe("skipped");
      expect(artifact.reviewUsage.requests).toBe(0);
      expect(
        artifact.stages.map((stage: { name: string; status: string; reason?: string }) => [
          stage.name,
          stage.status,
          stage.reason,
        ]),
      ).toEqual([
        ["config", "completed", undefined],
        ["diff", "completed", undefined],
        ["context", "completed", undefined],
        ["review", "skipped", "no_llm_flag"],
        ["validation", "skipped", "review_skipped_no_llm"],
        ["publish", "skipped", "dry-run"],
      ]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("real engine composition blocks before fetch without an api key", async () => {
    let fetchCalls = 0;
    const engine = createRealReviewEngine({
      runId: "wiring-key",
      version: "0.1.0",
      env: { CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING: "true" },
      secrets: [],
      logger: nullLogger(),
      fetchFn: (async () => {
        fetchCalls += 1;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    const config = ConfigFileSchema.parse({});
    const error = await engine.review([wiringUnit()], config).then(
      () => null,
      (failure: unknown) => failure as ReviewerError,
    );
    expect(error).toBeInstanceOf(ReviewerError);
    expect((error as ReviewerError).code).toBe("CONFIG_INVALID");
    expect(fetchCalls).toBe(0);
  });

  test("real engine composition blocks before fetch without the training opt-in", async () => {
    let fetchCalls = 0;
    const engine = createRealReviewEngine({
      runId: "wiring-optin",
      version: "0.1.0",
      env: { OPENCODE_API_KEY: "dummy-key" },
      secrets: [],
      logger: nullLogger(),
      fetchFn: (async () => {
        fetchCalls += 1;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    const config = ConfigFileSchema.parse({});
    const error = await engine.review([wiringUnit()], config).then(
      () => null,
      (failure: unknown) => failure as ReviewerError,
    );
    expect(error).toBeInstanceOf(ReviewerError);
    expect((error as ReviewerError).code).toBe("CONFIG_INVALID");
    expect(fetchCalls).toBe(0);
  });
});
