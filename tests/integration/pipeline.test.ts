import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../src/core/logger.ts";
import { runPipeline } from "../../src/core/pipeline.ts";
import { ReviewerError } from "../../src/core/errors.ts";
import { createFixtureEngines, failingLoadConfig } from "../fixtures/stubs.ts";

function testLogger() {
  return createLogger({ level: "error", runId: "pipeline-test" });
}

async function makeOutDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "codebleach-pipeline-"));
  const dir = join(base, "out");
  return { dir, cleanup: () => rm(base, { recursive: true, force: true }) };
}

async function readArtifact(dir: string) {
  return JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
}

describe("runPipeline", () => {
  test("runs stages in order with counts and skips publish on dry run", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const summary = await runPipeline(
        { ...fixture, logger: testLogger() },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: true, outDir: dir, runId: "run-test" },
      );
      expect(fixture.order).toEqual(["diff", "context", "review", "validation"]);
      expect(summary.status).toBe("completed");
      expect(summary.configSource).toBe("defaults");
      expect(summary.stages.map((stage) => [stage.name, stage.status])).toEqual([
        ["config", "completed"],
        ["diff", "completed"],
        ["context", "completed"],
        ["review", "completed"],
        ["validation", "completed"],
        ["publish", "skipped"],
      ]);
      expect(summary.stages.map((stage) => stage.count)).toEqual([undefined, 0, 1, 1, 1, undefined]);

      const artifact = await readArtifact(dir);
      expect(artifact.status).toBe("completed");
      expect(artifact.schemaVersion).toBe(1);
      expect(artifact.runId).toBe(summary.runId);
      expect(artifact.findings).toHaveLength(1);
      expect(artifact.validated).toHaveLength(1);
      expect(artifact.publishResult).toBeNull();
      expect(artifact.units[0]).toMatchObject({ id: "unit-1", file: { path: "src/a.ts" } });
      expect(artifact.findings[0]).toMatchObject({ id: "finding-1", file: "src/a.ts" });
      expect(artifact.validated[0]).toMatchObject({
        status: "accepted",
        finding: { id: "finding-1", file: "src/a.ts" },
      });
    } finally {
      await cleanup();
    }
  });

  test("publishes accepted findings when not dry run", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const summary = await runPipeline(
        { ...fixture, logger: testLogger() },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: false, outDir: dir, runId: "run-test" },
      );
      expect(fixture.order).toEqual(["diff", "context", "review", "validation", "publish"]);
      const artifact = await readArtifact(dir);
      expect(artifact.publishResult).toMatchObject({ published: 1, skipped: 0 });
      expect(summary.stages.at(-1)).toMatchObject({ name: "publish", status: "completed" });
    } finally {
      await cleanup();
    }
  });

  test("stage failure writes failed artifact and rethrows", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const failure = new ReviewerError({ code: "PROVIDER_FAILED", message: "llm down" });
      const fixture = createFixtureEngines({ failAt: "review", failure });
      const promise = runPipeline(
        { ...fixture, logger: testLogger() },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: true, outDir: dir, runId: "run-test" },
      );
      await expect(promise).rejects.toBe(failure);
      const artifact = await readArtifact(dir);
      expect(artifact.status).toBe("failed");
      expect(artifact.error).toMatchObject({ code: "PROVIDER_FAILED" });
      expect(artifact.stages).toMatchObject([
        { name: "config", status: "completed" },
        { name: "diff", status: "completed" },
        { name: "context", status: "completed" },
        { name: "review", status: "failed" },
      ]);
    } finally {
      await cleanup();
    }
  });

  test("config failure invokes no stage and writes failed artifact", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const promise = runPipeline(
        { ...fixture, logger: testLogger(), loadConfig: failingLoadConfig("CONFIG_INVALID") },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: true, outDir: dir, runId: "run-test" },
      );
      await expect(promise).rejects.toBeInstanceOf(ReviewerError);
      expect(fixture.order).toEqual([]);
      const artifact = await readArtifact(dir);
      expect(artifact.status).toBe("failed");
      expect(artifact.configSource).toBe("unavailable");
      expect(artifact.stages).toMatchObject([{ name: "config", status: "failed" }]);
    } finally {
      await cleanup();
    }
  });

  test("unexpected errors become INTERNAL with cause", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const boom = new Error("totally unexpected");
      fixture.diff.run = () => Promise.reject(boom);
      const promise = runPipeline(
        { ...fixture, logger: testLogger() },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: true, outDir: dir, runId: "run-test" },
      );
      try {
        await promise;
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewerError);
        expect((error as ReviewerError).code).toBe("INTERNAL");
        expect((error as ReviewerError).cause).toBe(boom);
      }
    } finally {
      await cleanup();
    }
  });

  test("artifact redacts secrets from stage outputs", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines({ secret: "ghp_supersecret999" });
      await runPipeline(
        { ...fixture, logger: testLogger() },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: true, outDir: dir, runId: "run-test" },
      );
      const text = await readFile(join(dir, "run.json"), "utf8");
      expect(text).not.toContain("ghp_supersecret999");
      expect(text).toContain("[REDACTED]");
    } finally {
      await cleanup();
    }
  });

  test("artifact redacts custom non-pattern secrets passed via input", async () => {
    const { dir, cleanup } = await makeOutDir();
    const secret = "zxqv-custom-9f8e7d6c5b4a";
    try {
      const fixture = createFixtureEngines({ secret });
      await runPipeline(
        { ...fixture, logger: testLogger() },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: true,
          outDir: dir,
          runId: "run-test",
          secrets: [secret],
        },
      );
      const text = await readFile(join(dir, "run.json"), "utf8");
      expect(text).not.toContain(secret);
      expect(text).toContain("[REDACTED]");
    } finally {
      await cleanup();
    }
  });

  test("records config as the first completed stage", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const summary = await runPipeline(
        { ...fixture, logger: testLogger() },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: true, outDir: dir, runId: "run-test" },
      );
      expect(summary.stages[0]).toMatchObject({ name: "config", status: "completed" });
      expect(typeof summary.stages[0]?.ms).toBe("number");
    } finally {
      await cleanup();
    }
  });

  test("persists running artifact immediately after config before diff", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      let configPersistedBeforeDiff = false;
      const origDiffRun = fixture.diff.run;
      fixture.diff.run = async (input) => {
        try {
          const artifact = await readArtifact(dir);
          configPersistedBeforeDiff =
            artifact.status === "running" &&
            artifact.configSource !== "unavailable" &&
            Array.isArray(artifact.stages) &&
            artifact.stages.length === 1 &&
            artifact.stages[0].name === "config" &&
            artifact.stages[0].status === "completed";
        } catch {
          configPersistedBeforeDiff = false;
        }
        return origDiffRun(input);
      };
      await runPipeline(
        { ...fixture, logger: testLogger() },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: true, outDir: dir, runId: "run-test" },
      );
      expect(configPersistedBeforeDiff).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("diff failure still persists config completed before the failure", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const failure = new ReviewerError({ code: "GIT_FAILED", message: "diff exploded" });
      const fixture = createFixtureEngines({ failAt: "diff", failure });
      const promise = runPipeline(
        { ...fixture, logger: testLogger() },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: true, outDir: dir, runId: "run-test" },
      );
      await expect(promise).rejects.toBe(failure);
      const artifact = await readArtifact(dir);
      expect(artifact.status).toBe("failed");
      expect(artifact.stages).toMatchObject([
        { name: "config", status: "completed" },
        { name: "diff", status: "failed" },
      ]);
      expect(artifact.configSource).not.toBe("unavailable");
    } finally {
      await cleanup();
    }
  });

  test("uses the caller-supplied runId in summary and artifact", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const input = {
        repoDir: ".",
        baseSha: "base",
        headSha: "head",
        dryRun: true,
        outDir: dir,
        runId: "run-abc-123",
      };
      const summary = await runPipeline({ ...fixture, logger: testLogger() }, input);
      expect(summary.runId).toBe("run-abc-123");
      const artifact = await readArtifact(dir);
      expect(artifact.runId).toBe("run-abc-123");
    } finally {
      await cleanup();
    }
  });

  test("every log line carries the same runId as the artifact", async () => {
    const { dir, cleanup } = await makeOutDir();
    const originalWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = ((chunk: unknown) => {
      captured += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      const fixture = createFixtureEngines();
      const logger = createLogger({ level: "info", runId: "run-log-1" });
      const input = {
        repoDir: ".",
        baseSha: "base",
        headSha: "head",
        dryRun: true,
        outDir: dir,
        runId: "run-log-1",
      };
      const summary = await runPipeline({ ...fixture, logger }, input);
      const artifact = await readArtifact(dir);
      const logRunIds = captured
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { runId?: unknown })
        .map((line) => line.runId);
      expect(logRunIds.length).toBeGreaterThan(0);
      expect(new Set(logRunIds).size).toBe(1);
      expect(logRunIds[0]).toBe("run-log-1");
      expect(summary.runId).toBe("run-log-1");
      expect(artifact.runId).toBe("run-log-1");
    } finally {
      process.stderr.write = originalWrite;
      await cleanup();
    }
  });
});
