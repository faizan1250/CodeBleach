import { describe, expect, test } from "bun:test";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import type { ResolvedConfig } from "../../src/config/schema.ts";
import type { Phase6PipelineDeps } from "../../src/core/contracts.ts";
import { createLogger } from "../../src/core/logger.ts";
import type { DiffResult, Finding, ValidatedFinding } from "../../src/types/index.ts";
import type {
  ConventionAdvisoryUnit,
  InferredConvention,
  PendingAdvisoryCandidate,
  PrimaryValidationResult,
} from "../../src/types/conventions.ts";
import { mergePhase6Advisory, runPhase6AdvisoryPass } from "../../src/core/phase6.ts";

const HEAD = "c".repeat(40);
const BASE = "d".repeat(40);

function config(): ResolvedConfig {
  return ConfigFileSchema.parse({});
}

function diff(): DiffResult {
  return { baseSha: BASE, headSha: HEAD, mergeBase: BASE, files: [] };
}

function convention(id: string): InferredConvention {
  return {
    id,
    detector: "naming-exports",
    detectorVersion: 1,
    pattern: "Modules predominantly use named exports.",
    evidence: [],
    matchingFiles: 6,
    eligibleFiles: 6,
    sampledFiles: 6,
    supportRatio: 1,
  };
}

function leanUnit(id: string, path = "src/a.ts"): ConventionAdvisoryUnit {
  return {
    unitId: id,
    path,
    language: "typescript",
    symbol: { name: "f", kind: "function", signature: "f(): number", side: "head", startLine: 1 },
    diffHunks: [{ baseStartLine: 1, headStartLine: 1, lines: ["+  return 2;"] }],
    changedSymbolSource: "export function f(): number {\n  return 2;\n}",
  };
}

function advisoryFinding(id: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id,
    fingerprint: `fp-${id}`,
    headSha: HEAD,
    origin: { pass: "convention-advisory", unitId: "unit-1" },
    title: `Convention observation ${id}`,
    severity: "low",
    category: "convention",
    file: "src/a.ts",
    line: 2,
    description: "The change diverges from the inferred repository convention.",
    confidence: 0.8,
    evidence: [{ file: "src/a.ts", startLine: 2, endLine: 2, quote: "return 2;" }],
    introducedByPr: true,
    symbol: "f",
    ...overrides,
  };
}

function acceptedPrimary(id: string): ValidatedFinding {
  const owned = advisoryFinding(id, { origin: { pass: "code-review-v1", unitId: "unit-1" }, category: "bug" });
  return {
    finding: owned,
    status: "accepted",
    checks: [],
    derivedAttribution: {
      introducedByPr: true,
      basis: { kind: "added-lines", evidenceIndex: 0, file: "src/a.ts", lines: [2] },
    },
    derivedTarget: { file: "src/a.ts", line: 2, side: "RIGHT", kind: "added" },
  };
}

function pendingFor(unitFinding: Finding, startLine: number, endLine: number): PendingAdvisoryCandidate {
  return {
    phase: "pending-advisory-resolution",
    findingId: unitFinding.id,
    pendingFields: {
      finding: unitFinding,
      checks: [],
      derivedAttribution: {
        introducedByPr: true,
        basis: { kind: "added-lines", evidenceIndex: 0, file: "src/a.ts", lines: [2] },
      },
      derivedTarget: { file: "src/a.ts", line: 2, side: "RIGHT", kind: "added" },
    },
    handoff: { findingId: unitFinding.id, headLocations: [{ path: "src/a.ts", startLine, endLine }] },
  };
}

interface FakeConductors {
  calls: { builds: number; projects: number; batches: number };
  maxInFlight: number;
}

function fakeDeps(input: {
  conventions?: InferredConvention[];
  units?: ConventionAdvisoryUnit[];
  buildThrows?: unknown;
  projectThrows?: unknown;
  batchThrows?: unknown;
  headLocations?: Array<{ startLine: number; endLine: number }>;
  primary?: PrimaryValidationResult;
  conductors?: FakeConductors;
}): Phase6PipelineDeps {
  const conductors: FakeConductors = input.conductors ?? { calls: { builds: 0, projects: 0, batches: 0 }, maxInFlight: 0 };
  let inFlight = 0;
  const unitById = new Map((input.units ?? []).map((unit) => [unit.unitId, unit]));
  return {
    conventions: {
      build: () => {
        conductors.calls.builds += 1;
        if (input.buildThrows !== undefined) return Promise.reject(input.buildThrows);
        const conventions = input.conventions ?? [convention("inf-1")];
        return Promise.resolve({
          conventions,
          diagnostics: { sampledFiles: 6, skippedFiles: 0, conventions: conventions.length, codes: [] },
        });
      },
    },
    advisoryProjector: {
      project: () => {
        conductors.calls.projects += 1;
        if (input.projectThrows !== undefined) return Promise.reject(input.projectThrows);
        const units = input.units ?? [leanUnit("unit-1"), leanUnit("unit-2", "src/b.ts")];
        return Promise.resolve({ units, skippedUnits: 0 });
      },
    },
    advisoryReview: {
      reviewBatch: (batch) => {
        conductors.calls.batches += 1;
        if (input.batchThrows !== undefined) return Promise.reject(input.batchThrows);
        inFlight += 1;
        conductors.maxInFlight = Math.max(conductors.maxInFlight, inFlight);
        const candidates = batch.units.map((unit, index) => {
          const known = unitById.get(unit.unitId) ?? unit;
          void known;
          const locations = input.headLocations ?? [{ startLine: 20 + index * 10, endLine: 21 + index * 10 }];
          const location = locations[index % locations.length] ?? { startLine: 20, endLine: 21 };
          return {
            unitId: unit.unitId,
            finding: advisoryFinding(`cand-${unit.unitId}`, {
              file: unit.path,
              evidence: [{ file: unit.path, startLine: location.startLine, endLine: location.endLine, quote: "q" }],
            }),
          };
        });
        return Promise.resolve({ candidates, inputTokens: 100, outputTokens: 10, codes: [] }).finally(() => {
          inFlight -= 1;
        });
      },
    },
    validation: {
      validatePrimaryWithHandoff: () =>
        Promise.resolve(
          input.primary ?? { findings: [acceptedPrimary("p1")], handoff: [{ findingId: "p1", headLocations: [] }] },
        ),
      validateAdvisoryCandidates: (findings) =>
        Promise.resolve(
          findings.map((candidate, index) => pendingFor(candidate, 20 + index * 10, 21 + index * 10)),
        ),
      finalizeAdvisoryCandidates: (candidates) =>
        candidates.map((candidate) => ({ ...candidate.pendingFields, status: "accepted" as const })),
    },
  };
}

describe("phase6 advisory pass", () => {
  test("fans out one request per batch and returns gated findings in batch order", async () => {
    const conductors: FakeConductors = { calls: { builds: 0, projects: 0, batches: 0 }, maxInFlight: 0 };
    const units = [leanUnit("unit-1"), leanUnit("unit-2"), leanUnit("unit-3"), leanUnit("unit-4")];
    const deps = fakeDeps({ units, conductors });
    const result = await runPhase6AdvisoryPass({
      phase6: deps,
      repoDir: "/repo",
      diff: diff(),
      units: [],
      config: config(),
      logger: createLogger({ level: "error", runId: "p6-05-test" }),
    });
    expect(conductors.calls).toEqual({ builds: 1, projects: 1, batches: 2 });
    expect(result.findings.map((item) => item.id)).toEqual([
      "cand-unit-1",
      "cand-unit-2",
      "cand-unit-3",
      "cand-unit-4",
    ]);
    expect(result.diagnostics.batches).toBe(2);
    expect(result.diagnostics.inputTokens).toBe(200);
    expect(result.diagnostics.outputTokens).toBe(20);
  });

  test("runs at most two advisory requests concurrently", async () => {
    const conductors: FakeConductors = { calls: { builds: 0, projects: 0, batches: 0 }, maxInFlight: 0 };
    const units = Array.from({ length: 12 }, (_, index) => leanUnit(`unit-${index}`, `src/f${index}.ts`));
    const deps = fakeDeps({ units, conductors });
    await runPhase6AdvisoryPass({
      phase6: deps,
      repoDir: "/repo",
      diff: diff(),
      units: [],
      config: config(),
      logger: createLogger({ level: "error", runId: "p6-05-test" }),
    });
    expect(conductors.calls.batches).toBe(4);
    expect(conductors.maxInFlight).toBeLessThanOrEqual(2);
  });

  test("issues no advisory work when no convention survives", async () => {
    const conductors: FakeConductors = { calls: { builds: 0, projects: 0, batches: 0 }, maxInFlight: 0 };
    const deps = fakeDeps({ conventions: [], conductors });
    const result = await runPhase6AdvisoryPass({
      phase6: deps,
      repoDir: "/repo",
      diff: diff(),
      units: [],
      config: config(),
      logger: createLogger({ level: "error", runId: "p6-05-test" }),
    });
    expect(result.findings).toEqual([]);
    expect(conductors.calls).toEqual({ builds: 1, projects: 0, batches: 0 });
    expect(result.diagnostics.codes).toContain("advisory_skipped_no_conventions");
  });

  test("fails open to empty advisories when the convention build throws", async () => {
    const deps = fakeDeps({ buildThrows: new Error("git exploded") });
    const result = await runPhase6AdvisoryPass({
      phase6: deps,
      repoDir: "/repo",
      diff: diff(),
      units: [],
      config: config(),
      logger: createLogger({ level: "error", runId: "p6-05-test" }),
    });
    expect(result.findings).toEqual([]);
    expect(result.diagnostics.codes).toContain("advisory_conventions_failed");
  });

  test("fails open when projection or a batch throws and keeps other batches", async () => {
    const projected = fakeDeps({ projectThrows: new Error("snapshot exploded") });
    const projectedResult = await runPhase6AdvisoryPass({
      phase6: projected,
      repoDir: "/repo",
      diff: diff(),
      units: [],
      config: config(),
      logger: createLogger({ level: "error", runId: "p6-05-test" }),
    });
    expect(projectedResult.findings).toEqual([]);

    const batched = fakeDeps({ batchThrows: new Error("provider timeout") });
    const batchedResult = await runPhase6AdvisoryPass({
      phase6: batched,
      repoDir: "/repo",
      diff: diff(),
      units: [],
      config: config(),
      logger: createLogger({ level: "error", runId: "p6-05-test" }),
    });
    expect(batchedResult.findings).toEqual([]);
    expect(batchedResult.diagnostics.codes).toContain("advisory_batch_failed");
  });

  test("propagates caller abort instead of failing open", async () => {
    const deps = fakeDeps({ buildThrows: new Error("aborted build") });
    const controller = new AbortController();
    controller.abort();
    let thrown: unknown;
    try {
      await runPhase6AdvisoryPass({
        phase6: deps,
        diff: diff(),
        units: [],
        config: config(),
        signal: controller.signal,
        logger: createLogger({ level: "error", runId: "p6-05-test" }),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
  });

  test("drops boundary violations before validation", async () => {
    let validated: Finding[] = [];
    const units = [leanUnit("unit-1"), leanUnit("unit-2")];
    const deps = fakeDeps({ units });
    const validating: Phase6PipelineDeps = {
      ...deps,
      advisoryReview: {
        reviewBatch: () =>
          Promise.resolve({
            candidates: [
              { unitId: "unit-1", finding: advisoryFinding("good") },
              { unitId: "unit-2", finding: advisoryFinding("bad", { severity: "medium" }) },
            ],
            inputTokens: 0,
            outputTokens: 0,
            codes: [],
          }),
      },
      validation: {
        ...deps.validation,
        validateAdvisoryCandidates: (findings) => {
          validated = [...findings];
          return Promise.resolve(
            findings.map((candidate, index) => pendingFor(candidate, 30 + index * 10, 31 + index * 10)),
          );
        },
      },
    };
    const result = await runPhase6AdvisoryPass({
      phase6: validating,
      repoDir: "/repo",
      diff: diff(),
      units: [],
      config: config(),
      logger: createLogger({ level: "error", runId: "p6-05-test" }),
    });
    expect(result.diagnostics.boundaryRejected).toBe(1);
    expect(result.findings.map((item) => item.id)).toEqual(["good"]);
    const merged = await mergePhase6Advisory({
      phase6: validating,
      primary: { findings: [], handoff: [] },
      gated: { findings: result.findings, units: result.units },
      diff: diff(),
      config: config(),
      logger: createLogger({ level: "error", runId: "p6-05-test" }),
    });
    expect(validated.map((item) => item.id)).toEqual(["good"]);
    expect(merged.advisory.map((item) => item.finding.id)).toEqual(["good"]);
  });
});

describe("phase6 advisory merge", () => {
  test("appends advisories after primaries with merge metadata", async () => {
    const deps = fakeDeps({});
    const primary: PrimaryValidationResult = {
      findings: [acceptedPrimary("p1")],
      handoff: [{ findingId: "p1", headLocations: [] }],
    };
    const gated = {
      findings: [advisoryFinding("a1"), advisoryFinding("a2")],
      units: [leanUnit("unit-1"), leanUnit("unit-2")],
    };
    const merged = await mergePhase6Advisory({
      phase6: deps,
      primary,
      gated,
      diff: diff(),
      config: config(),
      logger: createLogger({ level: "error", runId: "p6-05-test" }),
    });
    expect(merged.advisory.map((item) => item.finding.id)).toEqual(["a1", "a2"]);
    expect(merged.advisory.every((item) => item.status === "accepted")).toBe(true);
    expect(merged.metadata.suppressed).toBe(0);
  });

  test("drops every advisory on invalid primary handoff and keeps primaries", async () => {
    const deps = fakeDeps({});
    const primary: PrimaryValidationResult = { findings: [acceptedPrimary("p1")], handoff: [] };
    const merged = await mergePhase6Advisory({
      phase6: deps,
      primary,
      gated: { findings: [advisoryFinding("a1")], units: [leanUnit("unit-1")] },
      diff: diff(),
      config: config(),
      logger: createLogger({ level: "error", runId: "p6-05-test" }),
    });
    expect(merged.advisory).toEqual([]);
    expect(merged.metadata.codes).toContain("primary_handoff_invalid");
  });

  test("fails open when advisory validation throws", async () => {
    const deps = fakeDeps({});
    const failing: Phase6PipelineDeps = {
      ...deps,
      validation: {
        ...deps.validation,
        validateAdvisoryCandidates: () => Promise.reject(new Error("validation exploded")),
      },
    };
    const primary: PrimaryValidationResult = {
      findings: [acceptedPrimary("p1")],
      handoff: [{ findingId: "p1", headLocations: [] }],
    };
    const merged = await mergePhase6Advisory({
      phase6: failing,
      primary,
      gated: { findings: [advisoryFinding("a1")], units: [leanUnit("unit-1")] },
      diff: diff(),
      config: config(),
      logger: createLogger({ level: "error", runId: "p6-05-test" }),
    });
    expect(merged.advisory).toEqual([]);
    expect(merged.diagnostics.codes).toContain("advisory_validation_failed");
  });
});
