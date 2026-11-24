import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../src/core/logger.ts";
import { runPipeline } from "../../src/core/pipeline.ts";
import { ReviewerError } from "../../src/core/errors.ts";
import type { PublishContext } from "../../src/core/contracts.ts";
import { createFixtureEngines } from "../fixtures/stubs.ts";

const PR = { owner: "o", repo: "r", number: 1, baseSha: "base", headSha: "head" };

async function makeOutDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "codebleach-p704-"));
  const dir = join(base, "out");
  return { dir, cleanup: () => rm(base, { recursive: true, force: true }) };
}

describe("p7-04 publish gating and reconcileStale", () => {
  test("live publish without PR metadata fails CONFIG_INVALID", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const error = await runPipeline(
        { ...fixture, logger: createLogger({ level: "error", runId: "p704-nopr" }) },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: false, outDir: dir, runId: "p704-nopr" },
      ).then(
        () => null,
        (failure: unknown) => failure as ReviewerError,
      );
      expect(error).toBeInstanceOf(ReviewerError);
      expect((error as ReviewerError).code).toBe("CONFIG_INVALID");
    } finally {
      await cleanup();
    }
  });

  test("dry-run without PR metadata skips publish", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      let publishCalls = 0;
      fixture.publisher.publish = () => {
        publishCalls += 1;
        return Promise.resolve({ published: 0, skipped: 0, failures: [], runFailures: [] });
      };
      const summary = await runPipeline(
        { ...fixture, logger: createLogger({ level: "error", runId: "p704-dryrun" }) },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: true, outDir: dir, runId: "p704-dryrun" },
      );
      expect(summary.status).toBe("completed");
      expect(publishCalls).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("complete run opens the reconcile gate", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      let seen: PublishContext | undefined;
      fixture.publisher.publish = (_items, _diff, _meta, context) => {
        seen = context;
        return Promise.resolve({ published: 0, skipped: 0, failures: [], runFailures: [] });
      };
      await runPipeline(
        { ...fixture, logger: createLogger({ level: "error", runId: "p704-open" }) },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: false, outDir: dir, runId: "p704-open", pr: PR },
      );
      expect(seen).toEqual({ reconcileStale: true });
    } finally {
      await cleanup();
    }
  });

  test("partial context closes the reconcile gate", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const orig = fixture.context.build;
      fixture.context.build = async (...args) => {
        const result = await orig(...args);
        return { ...result, status: "partial" as const };
      };
      let seen: PublishContext | undefined;
      fixture.publisher.publish = (_items, _diff, _meta, context) => {
        seen = context;
        return Promise.resolve({ published: 0, skipped: 0, failures: [], runFailures: [] });
      };
      await runPipeline(
        { ...fixture, logger: createLogger({ level: "error", runId: "p704-partial" }) },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: false, outDir: dir, runId: "p704-partial", pr: PR },
      );
      expect(seen).toEqual({ reconcileStale: false });
    } finally {
      await cleanup();
    }
  });

  test("inconclusive validation closes the reconcile gate", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      fixture.validation.validate = async () => [
        {
          finding: {
            id: "i",
            fingerprint: "fp-i",
            headSha: "head",
            origin: { pass: "test", unitId: "unit-1" },
            title: "t",
            severity: "high",
            category: "security",
            file: "src/a.ts",
            line: 1,
            description: "d",
            confidence: 0.9,
            evidence: [{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "q" }],
            introducedByPr: true,
          },
          status: "inconclusive" as const,
          checks: [{ name: "schema", outcome: "passed" as const, code: "evidence_bounds_ok" as const }],
        },
      ];
      let seen: PublishContext | undefined;
      fixture.publisher.publish = (_items, _diff, _meta, context) => {
        seen = context;
        return Promise.resolve({ published: 0, skipped: 0, failures: [], runFailures: [] });
      };
      await runPipeline(
        { ...fixture, logger: createLogger({ level: "error", runId: "p704-inc" }) },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: false, outDir: dir, runId: "p704-inc", pr: PR },
      );
      expect(seen).toEqual({ reconcileStale: false });
    } finally {
      await cleanup();
    }
  });

  test("failed review unit closes the reconcile gate", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const origReview = fixture.review.review;
      fixture.review.review = async (units, config, options) => {
        const result = await origReview(units, config, options);
        return { ...result, unitsFailed: 1, unitsReviewed: 0 };
      };
      let seen: PublishContext | undefined;
      fixture.publisher.publish = (_items, _diff, _meta, context) => {
        seen = context;
        return Promise.resolve({ published: 0, skipped: 0, failures: [], runFailures: [] });
      };
      await runPipeline(
        { ...fixture, logger: createLogger({ level: "error", runId: "p704-failed-unit" }) },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: false,
          outDir: dir,
          runId: "p704-failed-unit",
          pr: PR,
        },
      );
      expect(seen).toEqual({ reconcileStale: false });
    } finally {
      await cleanup();
    }
  });
});
