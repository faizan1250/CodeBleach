import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_KEY_ENV, TRAINING_OPT_IN_ENV } from "../../src/llm/constants.ts";
import { createLogger } from "../../src/core/logger.ts";
import { runPipeline } from "../../src/core/pipeline.ts";
import type { Phase6PipelineDeps, ValidationOptions } from "../../src/core/contracts.ts";
import type { ResolvedConfig } from "../../src/config/schema.ts";
import type { DiffResult, Finding, ReviewUnit, ValidatedFinding } from "../../src/types/index.ts";
import type { PendingAdvisoryCandidate } from "../../src/types/conventions.ts";
import { createFixtureEngines } from "../fixtures/stubs.ts";

function testLogger() {
  return createLogger({ level: "error", runId: "p6-05-pipeline-test" });
}

function liveEnv(): Record<string, string | undefined> {
  return { [TRAINING_OPT_IN_ENV]: "true", [API_KEY_ENV]: "test-key" };
}

async function makeOutDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "codebleach-p6-05-"));
  const dir = join(base, "out");
  return { dir, cleanup: () => rm(base, { recursive: true, force: true }) };
}

function primaryShape(artifact: {
  findings: unknown;
  validated: unknown;
  validationSummary: unknown;
  units: unknown;
  diff: unknown;
  stages: Array<{ name: string; status: string; reason?: string; count?: number }>;
}) {
  return {
    findings: artifact.findings,
    validated: artifact.validated,
    validationSummary: artifact.validationSummary,
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

function advisoryFinding(id: string): Finding {
  return {
    id,
    fingerprint: `fp-${id}`,
    headSha: "head",
    origin: { pass: "convention-advisory", unitId: "unit-9" },
    title: `Convention observation ${id}`,
    severity: "low",
    category: "convention",
    file: "src/a.ts",
    line: 5,
    description: "The change diverges from the inferred repository convention.",
    confidence: 0.8,
    evidence: [{ file: "src/a.ts", startLine: 5, endLine: 6, quote: "q" }],
    introducedByPr: true,
    symbol: "f",
  };
}

function stubPhase6(input: {
  candidates: Finding[];
  buildThrows?: unknown;
  primaryValidate: (
    findings: Finding[],
    diff: DiffResult,
    units: ReviewUnit[],
    config: ResolvedConfig,
    options?: ValidationOptions | undefined,
  ) => Promise<ValidatedFinding[]>;
}): Phase6PipelineDeps & {
  calls: { builds: number; batches: number };
} {
  const calls = { builds: 0, batches: 0 };
  return {
    calls,
    conventions: {
      build: () => {
        calls.builds += 1;
        if (input.buildThrows !== undefined) return Promise.reject(input.buildThrows);
        return Promise.resolve({
          conventions: [
            {
              id: "inf-1",
              detector: "naming-exports",
              detectorVersion: 1,
              pattern: "Modules predominantly use named exports.",
              evidence: [],
              matchingFiles: 6,
              eligibleFiles: 6,
              sampledFiles: 6,
              supportRatio: 1,
            },
          ],
          diagnostics: { sampledFiles: 6, skippedFiles: 0, conventions: 1, codes: [] },
        });
      },
    },
    advisoryProjector: {
      project: () =>
        Promise.resolve({
          units: [
            {
              unitId: "unit-9",
              path: "src/a.ts",
              language: "typescript",
              symbol: { name: "f", kind: "function", signature: "f(): number", side: "head" as const, startLine: 5 },
              diffHunks: [{ baseStartLine: 5, headStartLine: 5, lines: ["+  return 3;"] }],
              changedSymbolSource: null,
            },
          ],
          skippedUnits: 0,
        }),
    },
    advisoryReview: {
      reviewBatch: (batch) => {
        calls.batches += 1;
        return Promise.resolve({
          candidates: batch.units.flatMap((unit) =>
            input.candidates
              .filter((candidate) => candidate.origin.unitId === unit.unitId)
              .map((candidate) => ({ unitId: unit.unitId, finding: candidate })),
          ),
          inputTokens: 10,
          outputTokens: 5,
          codes: [],
        });
      },
    },
    validation: {
      validatePrimaryWithHandoff: async (findings, diff, units, config, options) => {
        const validated = await input.primaryValidate(findings, diff, units, config, options);
        return {
          findings: validated,
          handoff: validated
            .filter((item) => item.status === "accepted")
            .map((item) => ({
              findingId: item.finding.id,
              headLocations: [{ path: "src/a.ts", startLine: 1, endLine: 1 }],
            })),
        };
      },
      validateAdvisoryCandidates: (findings) =>
        Promise.resolve(
          findings.map(
            (candidate): PendingAdvisoryCandidate => ({
              phase: "pending-advisory-resolution",
              findingId: candidate.id,
              pendingFields: {
                finding: candidate,
                checks: [],
                derivedAttribution: {
                  introducedByPr: true,
                  basis: { kind: "added-lines", evidenceIndex: 0, file: "src/a.ts", lines: [5] },
                },
                derivedTarget: { file: "src/a.ts", line: 5, side: "RIGHT", kind: "added" },
              },
              handoff: { findingId: candidate.id, headLocations: [{ path: "src/a.ts", startLine: 5, endLine: 6 }] },
            }),
          ),
        ),
      finalizeAdvisoryCandidates: (candidates) =>
        candidates.map((candidate) => ({ ...candidate.pendingFields, status: "accepted" as const })),
    },
  };
}

describe("p6-05 pipeline merge", () => {
  test("appends validated advisories after primaries", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const liveReview = { ...fixture.review, requiresLlm: true as const };
      const phase6 = stubPhase6({
        candidates: [advisoryFinding("a1")],
        primaryValidate: fixture.validation.validate.bind(fixture.validation),
      });
      await runPipeline(
        { ...fixture, review: liveReview, logger: testLogger(), phase6 },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: true,
          outDir: dir,
          runId: "run-merge",
          options: { conventionAdvisoryEnabled: true },
          env: liveEnv(),
        },
      );
      const artifact = JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as {
        validated: ValidatedFinding[];
        validationSummary: { accepted: number };
        stages: Array<{ name: string; status: string }>;
      };
      expect(artifact.stages.map((stage) => stage.status)).toEqual([
        "completed",
        "completed",
        "completed",
        "completed",
        "completed",
        "skipped",
      ]);
      expect(artifact.validated.map((item) => item.finding.id)).toEqual(["finding-1", "a1"]);
      expect(artifact.validated[1]?.finding.origin.pass).toBe("convention-advisory");
      expect(artifact.validationSummary.accepted).toBe(2);
      expect(phase6.calls).toEqual({ builds: 1, batches: 1 });
    } finally {
      await cleanup();
    }
  });

  test("failing phase6 bundle yields byte-identical primary output", async () => {
    const first = await makeOutDir();
    const second = await makeOutDir();
    try {
      const runOff = createFixtureEngines();
      await runPipeline(
        { ...runOff, logger: testLogger() },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: true, outDir: first.dir, runId: "run-same" },
      );
      const failing = createFixtureEngines();
      const liveReview = { ...failing.review, requiresLlm: true as const };
      const phase6 = stubPhase6({
        candidates: [],
        buildThrows: new Error("git exploded"),
        primaryValidate: failing.validation.validate.bind(failing.validation),
      });
      await runPipeline(
        { ...failing, review: liveReview, logger: testLogger(), phase6 },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: true,
          outDir: second.dir,
          runId: "run-same",
          options: { conventionAdvisoryEnabled: true },
          env: liveEnv(),
        },
      );
      const off = primaryShape(JSON.parse(await readFile(join(first.dir, "run.json"), "utf8")));
      const on = primaryShape(JSON.parse(await readFile(join(second.dir, "run.json"), "utf8")));
      expect(on).toEqual(off);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  test("offline review engine bypasses phase6 without calling it", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const phase6 = stubPhase6({
        candidates: [advisoryFinding("a1")],
        primaryValidate: fixture.validation.validate.bind(fixture.validation),
      });
      await runPipeline(
        { ...fixture, logger: testLogger(), phase6 },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: true,
          outDir: dir,
          runId: "run-offline",
          options: { conventionAdvisoryEnabled: true },
          env: liveEnv(),
        },
      );
      const artifact = JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as {
        validated: ValidatedFinding[];
      };
      expect(phase6.calls.builds).toBe(0);
      expect(artifact.validated.map((item) => item.finding.id)).toEqual(["finding-1"]);
    } finally {
      await cleanup();
    }
  });
});
