import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../src/core/logger.ts";
import { runPipeline } from "../../src/core/pipeline.ts";
import type { Phase6PipelineDeps } from "../../src/core/contracts.ts";
import type { ReviewerError } from "../../src/core/errors.ts";
import { createFixtureEngines } from "../fixtures/stubs.ts";

function testLogger() {
  return createLogger({ level: "error", runId: "p6-00-flag-test" });
}

async function makeOutDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "codebleach-p6-00-"));
  const dir = join(base, "out");
  return { dir, cleanup: () => rm(base, { recursive: true, force: true }) };
}

function primaryShape(artifact: {
  findings: unknown;
  validated: unknown;
  units: unknown;
  diff: unknown;
  stages: Array<{ name: string; status: string; reason?: string; count?: number }>;
}) {
  return {
    findings: artifact.findings,
    validated: artifact.validated,
    units: artifact.units,
    diff: artifact.diff,
    stages: artifact.stages.map((stage) => ({
      name: stage.name,
      status: stage.status,
      ...(stage.reason === undefined ? {} : { reason: stage.reason }),
      ...(stage.count === undefined ? {} : { count: stage.count }),
    })),
  };
}

function uncalledPhase6(): Phase6PipelineDeps {
  const uncalled = (): Promise<never> => Promise.reject(new Error("phase6 orchestration must not run in P6-00"));
  return {
    conventions: { build: uncalled },
    advisoryProjector: { project: uncalled },
    advisoryReview: { reviewBatch: uncalled },
    validation: {
      validatePrimaryWithHandoff: uncalled,
      validateAdvisoryCandidates: uncalled,
      finalizeAdvisoryCandidates: () => {
        throw new Error("phase6 orchestration must not run in P6-00");
      },
    },
  };
}

describe("p6-00 convention advisory flag", () => {
  test("flag absent and flag false produce identical primary output", async () => {
    const first = await makeOutDir();
    const second = await makeOutDir();
    try {
      await runPipeline(
        { ...createFixtureEngines(), logger: testLogger() },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: true, outDir: first.dir, runId: "run-same" },
      );
      await runPipeline(
        { ...createFixtureEngines(), logger: testLogger() },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: true,
          outDir: second.dir,
          runId: "run-same",
          options: { conventionAdvisoryEnabled: false },
        },
      );
      const off = primaryShape(JSON.parse(await readFile(join(first.dir, "run.json"), "utf8")));
      const explicitOff = primaryShape(JSON.parse(await readFile(join(second.dir, "run.json"), "utf8")));
      expect(explicitOff).toEqual(off);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  test("flag enabled without a phase6 bundle is a preflight composition error", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const promise = runPipeline(
        { ...fixture, logger: testLogger() },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: true,
          outDir: dir,
          runId: "run-flag-on",
          options: { conventionAdvisoryEnabled: true },
        },
      );
      await expect(promise).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(fixture.order).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("flag enabled with a bundle waits for P6-05 orchestration", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const promise = runPipeline(
        { ...createFixtureEngines(), logger: testLogger(), phase6: uncalledPhase6() },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: true,
          outDir: dir,
          runId: "run-flag-bundle",
          options: { conventionAdvisoryEnabled: true },
        },
      );
      let code: string | undefined;
      try {
        await promise;
      } catch (error) {
        code = (error as ReviewerError).code;
      }
      expect(code).toBe("NOT_IMPLEMENTED");
    } finally {
      await cleanup();
    }
  });
});
