import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_KEY_ENV, TRAINING_OPT_IN_ENV } from "../../src/llm/constants.ts";
import { createLogger } from "../../src/core/logger.ts";
import { isConventionAdvisoryFinding } from "../../src/core/contracts.ts";
import { runPipeline } from "../../src/core/pipeline.ts";
import type { Phase6PipelineDeps, ValidationOptions } from "../../src/core/contracts.ts";
import type { ResolvedConfig } from "../../src/config/schema.ts";
import type {
  AcceptedValidatedFinding,
  DiffResult,
  Finding,
  ReviewUnit,
  ValidatedFinding,
} from "../../src/types/index.ts";
import type { PendingAdvisoryCandidate } from "../../src/types/conventions.ts";
import { createFixtureEngines } from "../fixtures/stubs.ts";

function logger() {
  return createLogger({ level: "error", runId: "advisory-publish-test" });
}

function liveEnv(): Record<string, string | undefined> {
  return { [TRAINING_OPT_IN_ENV]: "true", [API_KEY_ENV]: "test-key" };
}

async function makeOutDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "codebleach-adv-pub-"));
  const dir = join(base, "out");
  return { dir, cleanup: () => rm(base, { recursive: true, force: true }) };
}

function primaryFinding(id: string): Finding {
  return {
    id,
    fingerprint: `fp-${id}`,
    headSha: "head",
    origin: { pass: "test", unitId: "unit-1" },
    title: `primary ${id}`,
    severity: "high",
    category: "security",
    file: "src/a.ts",
    line: 1,
    description: `primary ${id}`,
    confidence: 0.9,
    evidence: [{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "q" }],
    introducedByPr: true,
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
  };
}

function acceptedFor(finding: Finding): ValidatedFinding {
  return {
    finding,
    status: "accepted",
    checks: [{ name: "schema", outcome: "passed", code: "evidence_bounds_ok" }],
    derivedTarget: { file: "src/a.ts", line: finding.line, side: "RIGHT", kind: "added" },
    derivedAttribution: {
      introducedByPr: true,
      basis: { kind: "added-lines", evidenceIndex: 0, file: "src/a.ts", lines: [finding.line] },
    },
  };
}

function stubPhase6(input: {
  candidates: Finding[];
  primaryValidate: (
    findings: Finding[],
    diff: DiffResult,
    units: ReviewUnit[],
    config: ResolvedConfig,
    options?: ValidationOptions | undefined,
  ) => Promise<ValidatedFinding[]>;
}): Phase6PipelineDeps {
  return {
    conventions: {
      build: () =>
        Promise.resolve({
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
        }),
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
      reviewBatch: (batch) =>
        Promise.resolve({
          candidates: batch.units.flatMap((unit) =>
            input.candidates
              .filter((candidate) => candidate.origin.unitId === unit.unitId)
              .map((candidate) => ({ unitId: unit.unitId, finding: candidate })),
          ),
          inputTokens: 10,
          outputTokens: 5,
          codes: [],
        }),
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

describe("advisory publish boundary", () => {
  test("marks only stamped advisories", () => {
    expect(isConventionAdvisoryFinding(acceptedFor(primaryFinding("p")))).toBe(false);
    expect(isConventionAdvisoryFinding(acceptedFor(advisoryFinding("a")))).toBe(true);
  });

  test("withholds advisories by default", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const primary = primaryFinding("p1");
      const advisory = advisoryFinding("a1");
      fixture.validation.validate = () => Promise.resolve([acceptedFor(primary), acceptedFor(advisory)]);
      let published: AcceptedValidatedFinding[] = [];
      fixture.publisher.publish = (items) => {
        published = items;
        return Promise.resolve({ published: items.length, skipped: 0, failures: [] });
      };
      await runPipeline(
        { ...fixture, logger: logger() },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: false, outDir: dir, runId: "adv-pub-default" },
      );
      expect(published.map((item) => item.finding.id)).toEqual(["p1"]);
      const artifact = JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as {
        schemaVersion: number;
        validated: ValidatedFinding[];
        publishResult: { published: number };
      };
      expect(artifact.schemaVersion).toBe(2);
      expect(artifact.validated.map((item) => item.finding.id).sort()).toEqual(["a1", "p1"]);
      expect(artifact.publishResult.published).toBe(1);
      expect(artifact).not.toHaveProperty("advisoryPublish");
    } finally {
      await cleanup();
    }
  });

  test("publishes advisories with explicit opt-in", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const primary = primaryFinding("p1");
      const advisory = advisoryFinding("a1");
      fixture.validation.validate = () => Promise.resolve([acceptedFor(primary), acceptedFor(advisory)]);
      let published: AcceptedValidatedFinding[] = [];
      fixture.publisher.publish = (items) => {
        published = items;
        return Promise.resolve({ published: items.length, skipped: 0, failures: [] });
      };
      await runPipeline(
        { ...fixture, logger: logger() },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: false,
          outDir: dir,
          runId: "adv-pub-optin",
          options: { conventionAdvisoryPublishEnabled: true },
        },
      );
      expect(published.map((item) => item.finding.id).sort()).toEqual(["a1", "p1"]);
      const artifact = JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as {
        publishResult: { published: number };
      };
      expect(artifact.publishResult.published).toBe(2);
    } finally {
      await cleanup();
    }
  });

  test("phase6 generation without publish opt-in still withholds", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const liveReview = { ...fixture.review, requiresLlm: true as const };
      const phase6 = stubPhase6({
        candidates: [advisoryFinding("a1")],
        primaryValidate: fixture.validation.validate.bind(fixture.validation),
      });
      let published: AcceptedValidatedFinding[] = [];
      const capturing = {
        ...fixture,
        review: liveReview,
        logger: logger(),
        phase6,
        publisher: {
          publish: (items: AcceptedValidatedFinding[]) => {
            published = items;
            return Promise.resolve({ published: items.length, skipped: 0, failures: [] });
          },
        },
      };
      await runPipeline(capturing, {
        repoDir: ".",
        baseSha: "base",
        headSha: "head",
        dryRun: false,
        outDir: dir,
        runId: "adv-pub-phase6",
        options: { conventionAdvisoryEnabled: true },
        env: liveEnv(),
      });
      expect(published.map((item) => item.finding.id)).toEqual(["finding-1"]);
      const artifact = JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as {
        validated: ValidatedFinding[];
      };
      expect(artifact.validated.map((item) => item.finding.id).sort()).toEqual(["a1", "finding-1"]);
    } finally {
      await cleanup();
    }
  });

  test("phase6 generation with publish opt-in publishes both", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      const liveReview = { ...fixture.review, requiresLlm: true as const };
      const phase6 = stubPhase6({
        candidates: [advisoryFinding("a1")],
        primaryValidate: fixture.validation.validate.bind(fixture.validation),
      });
      let published: AcceptedValidatedFinding[] = [];
      const capturing = {
        ...fixture,
        review: liveReview,
        logger: logger(),
        phase6,
        publisher: {
          publish: (items: AcceptedValidatedFinding[]) => {
            published = items;
            return Promise.resolve({ published: items.length, skipped: 0, failures: [] });
          },
        },
      };
      await runPipeline(capturing, {
        repoDir: ".",
        baseSha: "base",
        headSha: "head",
        dryRun: false,
        outDir: dir,
        runId: "adv-pub-phase6-optin",
        options: { conventionAdvisoryEnabled: true, conventionAdvisoryPublishEnabled: true },
        env: liveEnv(),
      });
      expect(published.map((item) => item.finding.id).sort()).toEqual(["a1", "finding-1"]);
    } finally {
      await cleanup();
    }
  });
});
