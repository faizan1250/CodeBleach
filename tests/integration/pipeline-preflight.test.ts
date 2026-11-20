import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import type { ReviewEngine } from "../../src/core/contracts.ts";
import { createLogger } from "../../src/core/logger.ts";
import { runPipeline } from "../../src/core/pipeline.ts";
import { ok } from "../../src/core/result.ts";
import { API_KEY_ENV, TRAINING_OPT_IN_ENV } from "../../src/llm/constants.ts";
import { createFixtureEngines } from "../fixtures/stubs.ts";

const OPT_IN = { [TRAINING_OPT_IN_ENV]: "true" };
const CREDS = { ...OPT_IN, [API_KEY_ENV]: "dummy-key" };

function testLogger() {
  return createLogger({ level: "error", runId: "preflight-test" });
}

async function makeOutDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "codebleach-preflight-"));
  const dir = join(base, "out");
  return { dir, cleanup: () => rm(base, { recursive: true, force: true }) };
}

async function readArtifact(dir: string) {
  return JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
}

// Review stub that needs the model (flag omitted pins the fail-closed
// default): delegates to the canned fixture review once preflight passes.
function llmReview(fixture: ReturnType<typeof createFixtureEngines>): ReviewEngine {
  const inner = fixture.review.review;
  return { review: (units, config) => inner(units, config) };
}

describe("pipeline llm preflight", () => {
  test("missing opt-in fails before diff and context", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const promise = runPipeline(
        { ...fixture, review: llmReview(fixture), logger: testLogger() },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: true,
          outDir: dir,
          runId: "preflight-no-optin",
          env: {},
        },
      );
      await expect(promise).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(fixture.order).toEqual([]);
      const artifact = await readArtifact(dir);
      expect(artifact.status).toBe("failed");
      expect(artifact.error.code).toBe("CONFIG_INVALID");
      expect(artifact.error.message).toContain(TRAINING_OPT_IN_ENV);
      expect(artifact.stages).toEqual([{ name: "config", status: "completed", ms: expect.any(Number) }]);
    } finally {
      await cleanup();
    }
  });

  test("missing key fails before diff and context", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const promise = runPipeline(
        { ...fixture, review: llmReview(fixture), logger: testLogger() },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: true,
          outDir: dir,
          runId: "preflight-no-key",
          env: { ...OPT_IN },
        },
      );
      await expect(promise).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(fixture.order).toEqual([]);
      const artifact = await readArtifact(dir);
      expect(artifact.status).toBe("failed");
      expect(artifact.error.code).toBe("CONFIG_INVALID");
      expect(artifact.error.message).toContain(API_KEY_ENV);
      expect(artifact.stages.map((stage: { name: string }) => stage.name)).toEqual(["config"]);
    } finally {
      await cleanup();
    }
  });

  test("empty key fails like a missing key", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const promise = runPipeline(
        { ...fixture, review: llmReview(fixture), logger: testLogger() },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: true,
          outDir: dir,
          runId: "preflight-empty-key",
          env: { ...OPT_IN, [API_KEY_ENV]: "" },
        },
      );
      await expect(promise).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(fixture.order).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("non-exact opt-in values are rejected", async () => {
    for (const value of ["1", "True", "TRUE", "yes", " "]) {
      const { dir, cleanup } = await makeOutDir();
      try {
        const fixture = createFixtureEngines();
        const promise = runPipeline(
          { ...fixture, review: llmReview(fixture), logger: testLogger() },
          {
            repoDir: ".",
            baseSha: "base",
            headSha: "head",
            dryRun: true,
            outDir: dir,
            runId: "preflight-optin-exact",
            env: { [TRAINING_OPT_IN_ENV]: value, [API_KEY_ENV]: "dummy-key" },
          },
        );
        await expect(promise).rejects.toMatchObject({ code: "CONFIG_INVALID" });
        expect(fixture.order).toEqual([]);
      } finally {
        await cleanup();
      }
    }
  });

  test("unusable llm budgets fail before diff and context", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const valid = ConfigFileSchema.parse({});
      const config = {
        ...valid,
        llm: { ...valid.llm, max_review_unit_input_tokens: 1_000_000, max_output_tokens: 131_072 },
      };
      const promise = runPipeline(
        {
          ...fixture,
          review: llmReview(fixture),
          logger: testLogger(),
          loadConfig: ((_repoDir: string) => Promise.resolve(ok({ config, source: "defaults" as const }))) as typeof fixture.loadConfig,
        },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: true,
          outDir: dir,
          runId: "preflight-budgets",
          env: { ...CREDS },
        },
      );
      await expect(promise).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(fixture.order).toEqual([]);
      const artifact = await readArtifact(dir);
      expect(artifact.status).toBe("failed");
      expect(artifact.stages.map((stage: { name: string }) => stage.name)).toEqual(["config"]);
    } finally {
      await cleanup();
    }
  });

  test("default review engine (flag omitted) preflights: no creds, no context", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      let reviewCalls = 0;
      const promise = runPipeline(
        {
          ...fixture,
          review: {
            review: (units, config) => {
              reviewCalls += 1;
              return fixture.review.review(units, config);
            },
          },
          logger: testLogger(),
        },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: true,
          outDir: dir,
          runId: "preflight-default",
          env: {},
        },
      );
      await expect(promise).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(reviewCalls).toBe(0);
      expect(fixture.order).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("valid creds run the full pipeline with a default review engine", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      let reviewCalls = 0;
      const summary = await runPipeline(
        {
          ...fixture,
          review: {
            review: (units, config) => {
              reviewCalls += 1;
              return fixture.review.review(units, config);
            },
          },
          logger: testLogger(),
        },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: true,
          outDir: dir,
          runId: "preflight-ok",
          env: { ...CREDS },
        },
      );
      expect(summary.status).toBe("completed");
      expect(reviewCalls).toBe(1);
      expect(fixture.order).toEqual(["diff", "context", "review", "validation"]);
      expect(summary.stages.map((stage) => stage.name)).toEqual([
        "config",
        "diff",
        "context",
        "review",
        "validation",
        "publish",
      ]);
    } finally {
      await cleanup();
    }
  });

  test("offline review engine skips preflight without creds", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const summary = await runPipeline(
        { ...fixture, logger: testLogger() },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: true,
          outDir: dir,
          runId: "preflight-offline",
          env: {},
        },
      );
      expect(summary.status).toBe("completed");
      expect(fixture.order).toEqual(["diff", "context", "review", "validation"]);
    } finally {
      await cleanup();
    }
  });

  test("dry-run still requires preflight", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const promise = runPipeline(
        {
          ...fixture,
          review: { review: (units, config) => fixture.review.review(units, config) },
          logger: testLogger(),
        },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: true,
          outDir: dir,
          runId: "preflight-dryrun",
          env: { ...OPT_IN },
        },
      );
      await expect(promise).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(fixture.order).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
