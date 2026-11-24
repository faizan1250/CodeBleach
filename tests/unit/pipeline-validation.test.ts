import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import { createLogger } from "../../src/core/logger.ts";
import { isAcceptedFinding } from "../../src/core/contracts.ts";
import { runPipeline } from "../../src/core/pipeline.ts";
import { ReviewerError } from "../../src/core/errors.ts";
import { stubPublisher } from "../../src/core/stubs.ts";
import { ValidationEngineImpl, createValidationEngine } from "../../src/validate/engine.ts";
import type { ValidationSnapshotReader } from "../../src/validate/snapshot.ts";
import type { DiffResult, Finding, ValidatedFinding } from "../../src/types/index.ts";
import { createFixtureEngines, emptyReviewResult } from "../fixtures/stubs.ts";

const config = ConfigFileSchema.parse({});

function logger() {
  return createLogger({ level: "error", runId: "p5-09" });
}

async function makeOutDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "codebleach-p509-"));
  const dir = join(base, "out");
  return { dir, cleanup: () => rm(base, { recursive: true, force: true }) };
}

function finding(id: string): Finding {
  return {
    id,
    fingerprint: `fp-${id}`,
    headSha: "head",
    origin: { pass: "test", unitId: "unit-1" },
    title: `finding ${id}`,
    severity: "high",
    category: "security",
    file: "src/a.ts",
    line: 1,
    description: `description ${id}`,
    confidence: 0.9,
    evidence: [{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "q" }],
    introducedByPr: true,
  };
}

function validatedAs(f: Finding, status: ValidatedFinding["status"]): ValidatedFinding {
  const base: ValidatedFinding = {
    finding: f,
    status,
    checks: [{ name: "schema", outcome: "passed", code: "evidence_bounds_ok" }],
  };
  if (status !== "accepted") return base;
  return {
    ...base,
    derivedTarget: { file: "src/a.ts", line: 1, side: "RIGHT", kind: "added" },
    derivedAttribution: {
      introducedByPr: true,
      basis: { kind: "added-lines", evidenceIndex: 0, file: "src/a.ts", lines: [1] },
    },
  };
}

describe("p5-09 pipeline validation wiring", () => {
  test("dry-run persists mixed outcomes and skips publish", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const [a, b, c] = [finding("a"), finding("b"), finding("c")];
      fixture.validation.validate = () =>
        Promise.resolve([validatedAs(a, "accepted"), validatedAs(b, "rejected"), validatedAs(c, "inconclusive")]);
      let publishCalls = 0;
      fixture.publisher.publish = () => {
        publishCalls += 1;
        return Promise.resolve({ published: 0, skipped: 0, failures: [], runFailures: [] });
      };
      const summary = await runPipeline(
        { ...fixture, logger: logger() },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: true, outDir: dir, runId: "p5-09-dryrun" },
      );
      expect(summary.status).toBe("completed");
      expect(summary.stages.map((stage) => [stage.name, stage.status])).toEqual([
        ["config", "completed"],
        ["diff", "completed"],
        ["context", "completed"],
        ["review", "completed"],
        ["validation", "completed"],
        ["publish", "skipped"],
      ]);
      expect(summary.stages.find((stage) => stage.name === "validation")?.count).toBe(1);
      expect(publishCalls).toBe(0);
      const artifact = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
      expect(artifact.validated).toHaveLength(3);
      expect(artifact.validationSummary).toMatchObject({ total: 3, accepted: 1, rejected: 1, inconclusive: 1 });
      expect(artifact.publishResult).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("isAcceptedFinding narrows mixed outcomes to accepted-only", () => {
    const [a, b, c] = [finding("a"), finding("b"), finding("c")];
    const mixed = [validatedAs(a, "accepted"), validatedAs(b, "rejected"), validatedAs(c, "inconclusive")];
    const accepted = mixed.filter(isAcceptedFinding);
    expect(accepted.map((item) => item.finding.id)).toEqual(["a"]);
    expect(accepted.every((item) => item.status === "accepted")).toBe(true);
  });

  test("non-dry-run passes only accepted findings to the publisher", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const [a, b, c] = [finding("a"), finding("b"), finding("c")];
      fixture.validation.validate = () =>
        Promise.resolve([validatedAs(a, "accepted"), validatedAs(b, "rejected"), validatedAs(c, "inconclusive")]);
      let published: ValidatedFinding[] = [];
      fixture.publisher.publish = (items) => {
        published = items;
        return Promise.resolve({ published: items.length, skipped: 0, failures: [], runFailures: [] });
      };
      const summary = await runPipeline(
        { ...fixture, logger: logger() },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: false,
          outDir: dir,
          runId: "p5-09-live",
          pr: { owner: "o", repo: "r", number: 1, baseSha: "base", headSha: "head" },
        },
      );
      expect(summary.status).toBe("completed");
      expect(published.map((item) => item.finding.id)).toEqual(["a"]);
      expect(published.every((item) => item.status === "accepted")).toBe(true);
      const artifact = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
      expect(artifact.publishResult).toMatchObject({ published: 1, skipped: 0 });
    } finally {
      await cleanup();
    }
  });

  test("non-dry-run reaches the publisher stub failure explicitly", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      fixture.publisher = stubPublisher;
      const error = await runPipeline(
        { ...fixture, logger: logger() },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: false,
          outDir: dir,
          runId: "p5-09-stub",
          pr: { owner: "o", repo: "r", number: 1, baseSha: "base", headSha: "head" },
        },
      ).then(
        () => null,
        (failure: unknown) => failure as ReviewerError,
      );
      expect(error).toBeInstanceOf(ReviewerError);
      expect((error as ReviewerError).code).toBe("NOT_IMPLEMENTED");
      const artifact = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
      expect(artifact.stages).toMatchObject([
        { name: "config", status: "completed" },
        { name: "diff", status: "completed" },
        { name: "context", status: "completed" },
        { name: "review", status: "completed" },
        { name: "validation", status: "completed" },
        { name: "publish", status: "failed" },
      ]);
      expect(artifact.error.code).toBe("NOT_IMPLEMENTED");
    } finally {
      await cleanup();
    }
  });

  test("validation failure fails the dry-run stage with a failed artifact", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const failure = new ReviewerError({ code: "INTERNAL", message: "validator exploded" });
      fixture.validation.validate = () => Promise.reject(failure);
      const error = await runPipeline(
        { ...fixture, logger: logger() },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: true, outDir: dir, runId: "p5-09-fail" },
      ).then(
        () => null,
        (caught: unknown) => caught as ReviewerError,
      );
      expect(error).toBe(failure);
      const artifact = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
      expect(artifact.status).toBe("failed");
      expect(artifact.error.code).toBe("INTERNAL");
      expect(artifact.stages).toMatchObject([
        { name: "config", status: "completed" },
        { name: "diff", status: "completed" },
        { name: "context", status: "completed" },
        { name: "review", status: "completed" },
        { name: "validation", status: "failed" },
      ]);
    } finally {
      await cleanup();
    }
  });

  test("empty findings validate to an empty coherent result", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      fixture.review.review = () => Promise.resolve({ ...emptyReviewResult(), findings: [] });
      fixture.validation.validate = () => Promise.resolve([]);
      const summary = await runPipeline(
        { ...fixture, logger: logger() },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: true, outDir: dir, runId: "p5-09-empty" },
      );
      expect(summary.status).toBe("completed");
      expect(summary.stages.find((stage) => stage.name === "validation")).toMatchObject({
        status: "completed",
        count: 0,
      });
      const artifact = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
      expect(artifact.validated).toEqual([]);
      expect(artifact.validationSummary).toMatchObject({ total: 0, accepted: 0, rejected: 0, inconclusive: 0 });
    } finally {
      await cleanup();
    }
  });

  test("partial review findings are still validated", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const partial = finding("partial");
      fixture.review.review = () =>
        Promise.resolve({ ...emptyReviewResult(), status: "partial" as const, findings: [partial] });
      let seen: Finding[] = [];
      fixture.validation.validate = (items) => {
        seen = items;
        return Promise.resolve([validatedAs(partial, "accepted")]);
      };
      await runPipeline(
        { ...fixture, logger: logger() },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: true, outDir: dir, runId: "p5-09-partial" },
      );
      expect(seen.map((item) => item.id)).toEqual(["partial"]);
      const artifact = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
      expect(artifact.reviewStatus).toBe("partial");
      expect(artifact.validated).toHaveLength(1);
      expect(artifact.validationSummary).toMatchObject({ total: 1, accepted: 1 });
    } finally {
      await cleanup();
    }
  });

  test("engine binds the reader to the run repo and SHAs and releases it", async () => {
    const head = "a".repeat(40);
    const base = "b".repeat(40);
    let seen: { repoDir: string; headSha: string; mergeBase: string } | undefined;
    let cleared = 0;
    const reader: ValidationSnapshotReader = {
      headSha: head,
      mergeBase: base,
      readHead: () => Promise.reject(new Error("unexpected snapshot read")),
      readBase: () => Promise.reject(new Error("unexpected snapshot read")),
      readAt: () => Promise.reject(new Error("unexpected snapshot read")),
      stats: () => ({ reads: 0, cacheHits: 0, entries: 0, cachedBytes: 0, gitCalls: 0 }),
      clear: () => {
        cleared += 1;
      },
    };
    const engine = createValidationEngine({
      repoDir: "/repo/wd",
      createReader: (input) => {
        seen = input;
        return reader;
      },
    });
    expect(engine).toBeInstanceOf(ValidationEngineImpl);
    const diff: DiffResult = { baseSha: base, headSha: head, mergeBase: base, files: [] };
    const badUnit = finding("orphan");
    const out = await engine.validate(
      [{ ...badUnit, headSha: head, origin: { pass: "test", unitId: "unknown-unit" } }],
      diff,
      [],
      config,
    );
    expect(seen).toEqual({ repoDir: "/repo/wd", headSha: head, mergeBase: base });
    expect(cleared).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe("rejected");
  });
});

describe("accepted-only publisher contract", () => {
  test("isAcceptedFinding requires the complete publish invariant", () => {
    const complete = validatedAs(finding("ok"), "accepted");
    expect(isAcceptedFinding(complete)).toBe(true);

    const incomplete: ValidatedFinding[] = [
      { ...complete, derivedTarget: undefined },
      { ...complete, derivedAttribution: undefined },
      { ...complete, derivedAttribution: { introducedByPr: false } },
      { ...complete, derivedAttribution: { introducedByPr: true } },
      {
        ...complete,
        derivedAttribution: {
          introducedByPr: true,
          basis: { kind: "added-lines", evidenceIndex: 0, file: "src/a.ts", lines: [] },
        },
      },
      { ...complete, derivedTarget: { file: "src/a.ts", line: 0, side: "RIGHT", kind: "added" } },
      { ...complete, status: "rejected" },
      { ...complete, status: "inconclusive" },
    ];
    for (const item of incomplete) expect(isAcceptedFinding(item)).toBe(false);
  });

  test("incomplete accepted fails the pipeline closed without publishing", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const bad = finding("bad");
      fixture.validation.validate = () =>
        Promise.resolve([
          {
            finding: bad,
            status: "accepted" as const,
            checks: [{ name: "schema", outcome: "passed" as const, code: "evidence_bounds_ok" as const }],
          },
        ]);
      let publishCalls = 0;
      fixture.publisher.publish = () => {
        publishCalls += 1;
        return Promise.resolve({ published: 0, skipped: 0, failures: [], runFailures: [] });
      };
      const error = await runPipeline(
        { ...fixture, logger: logger() },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: false,
          outDir: dir,
          runId: "p5-09-incomplete",
          pr: { owner: "o", repo: "r", number: 1, baseSha: "base", headSha: "head" },
        },
      ).then(
        () => null,
        (failure: unknown) => failure as ReviewerError,
      );
      expect(error).toBeInstanceOf(ReviewerError);
      expect((error as ReviewerError).code).toBe("INTERNAL");
      expect(publishCalls).toBe(0);
      const artifact = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
      expect(artifact.status).toBe("failed");
      expect(artifact.validationSummary).toBeNull();
      expect(artifact.publishResult).toBeNull();
      expect(artifact.stages.find((stage: { name: string }) => stage.name === "validation")).toMatchObject({
        status: "completed",
        count: 0,
      });
    } finally {
      await cleanup();
    }
  });
});
