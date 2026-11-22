import { describe, expect, test } from "bun:test";
import type { ConventionAdvisoryUnit } from "../../../src/types/conventions.ts";
import { packAdvisoryBatches } from "../../../src/conventions/packer.ts";
import { measureAdvisoryRequest } from "../../../src/conventions/packer.ts";
import type { InferredConvention } from "../../../src/types/conventions.ts";
import {
  MAX_ADVISORY_INPUT_TOKENS_PER_REQUEST,
  MAX_ADVISORY_REQUESTS_PER_RUN,
  MAX_ADVISORY_UNITS_PER_REQUEST,
  MAX_ADVISORY_UNITS_PER_RUN,
  MAX_CONVENTION_SUMMARY_TOKENS_PER_REQUEST,
} from "../../../src/conventions/constants.ts";
import { countAdvisoryTokens } from "../../../src/conventions/token-budget.ts";

function unit(overrides: Partial<ConventionAdvisoryUnit> = {}): ConventionAdvisoryUnit {
  return {
    unitId: "unit-1",
    path: "src/a.ts",
    language: "typescript",
    symbol: { name: "f", kind: "function", signature: "f(): number", side: "head", startLine: 1 },
    diffHunks: [{ baseStartLine: 1, headStartLine: 1, lines: ["+return 2;"] }],
    changedSymbolSource: "export function f(): number {\n  return 2;\n}",
    ...overrides,
  };
}

function convention(overrides: Partial<InferredConvention> = {}): InferredConvention {
  return {
    id: "inf-0000000000000001",
    detector: "naming-exports",
    detectorVersion: 1,
    pattern: "Modules predominantly use named exports.",
    evidence: [],
    matchingFiles: 9,
    eligibleFiles: 10,
    sampledFiles: 10,
    supportRatio: 0.9,
    ...overrides,
  };
}

describe("p6-03 packer batching", () => {
  test("packs three units per request up to fifteen", () => {
    const units = Array.from({ length: 7 }, (_, index) => unit({ unitId: `unit-${index + 1}` }));
    const result = packAdvisoryBatches({ units, conventions: [convention()] });
    expect(result.batches).toHaveLength(3);
    expect(result.batches[0]?.units.map((entry) => entry.unitId)).toEqual(["unit-1", "unit-2", "unit-3"]);
    expect(result.batches[1]?.units.map((entry) => entry.unitId)).toEqual(["unit-4", "unit-5", "unit-6"]);
    expect(result.batches[2]?.units.map((entry) => entry.unitId)).toEqual(["unit-7"]);
    expect(result.skippedUnits).toBe(0);
  });

  test("caps at fifteen units and five requests", () => {
    const units = Array.from({ length: 20 }, (_, index) =>
      unit({
        unitId: `unit-${String(index + 1).padStart(2, "0")}`,
        path: `src/${String(index + 1).padStart(2, "0")}.ts`,
      }),
    );
    const result = packAdvisoryBatches({ units, conventions: [convention()] });
    expect(result.batches).toHaveLength(MAX_ADVISORY_REQUESTS_PER_RUN);
    for (const batch of result.batches) {
      expect(batch.units.length).toBeLessThanOrEqual(MAX_ADVISORY_UNITS_PER_REQUEST);
    }
    const packed = result.batches.reduce((sum, batch) => sum + batch.units.length, 0);
    expect(packed).toBe(MAX_ADVISORY_UNITS_PER_RUN);
    expect(result.skippedUnits).toBe(5);
  });

  test("every request measures under budget", () => {
    const big = unit({
      unitId: "big",
      changedSymbolSource: `${"const x = 1;\n".repeat(200)}`,
      diffHunks: [{ baseStartLine: 1, headStartLine: 1, lines: [`+${"y".repeat(1200)}`] }],
    });
    const units = [big, ...Array.from({ length: 5 }, (_, index) => unit({ unitId: `unit-${index + 1}` }))];
    const result = packAdvisoryBatches({
      units,
      conventions: [convention(), convention({ id: "inf-0000000000000002" })],
    });
    expect(result.batches.length).toBeGreaterThan(0);
    for (const batch of result.batches) {
      expect(measureAdvisoryRequest(batch)).toBeLessThanOrEqual(MAX_ADVISORY_INPUT_TOKENS_PER_REQUEST);
    }
  });

  test("truncates summaries to eight records and 600 tokens", () => {
    const conventions = Array.from({ length: 12 }, (_, index) =>
      convention({
        id: `inf-${String(index + 1).padStart(16, "0")}`,
        pattern: `Pattern statement number ${index + 1} with padding ${"p".repeat(60)}.`,
        matchingFiles: 20 - index,
        eligibleFiles: 20,
        supportRatio: (20 - index) / 20,
      }),
    );
    const result = packAdvisoryBatches({ units: [unit()], conventions });
    expect(result.batches).toHaveLength(1);
    const summaries = result.batches[0]?.conventions ?? [];
    expect(summaries.length).toBeLessThanOrEqual(8);
    expect(countAdvisoryTokens(JSON.stringify(summaries))).toBeLessThanOrEqual(
      MAX_CONVENTION_SUMMARY_TOKENS_PER_REQUEST,
    );
    expect(summaries[0]?.pattern).toContain("number 1");
  });

  test("summaries carry no evidence or source locations", () => {
    const withEvidence: InferredConvention = {
      ...convention(),
      evidence: [{ kind: "source-span", file: "src/secret.ts", startLine: 3, endLine: 9 }],
    };
    const result = packAdvisoryBatches({ units: [unit()], conventions: [withEvidence] });
    const serialized = JSON.stringify(result.batches[0]?.conventions ?? []);
    expect(serialized).not.toContain("evidence");
    expect(serialized).not.toContain("secret.ts");
    expect(serialized).not.toContain("source-span");
    expect(Object.keys(result.batches[0]?.conventions[0] ?? {}).sort()).toEqual(
      ["detector", "eligibleFiles", "matchingFiles", "pattern", "supportRatio"].sort(),
    );
  });

  test("packs units when no conventions survive", () => {
    const result = packAdvisoryBatches({ units: [unit(), unit({ unitId: "unit-2" })], conventions: [] });
    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]?.units).toHaveLength(2);
    expect(result.batches[0]?.conventions).toEqual([]);
  });

  test("packing is deterministic across input permutations", () => {
    const units = Array.from({ length: 9 }, (_, index) => unit({ unitId: `unit-${index + 1}` }));
    const conventions = Array.from({ length: 4 }, (_, index) =>
      convention({ id: `inf-${String(index + 1).padStart(16, "0")}` }),
    );
    const first = packAdvisoryBatches({ units, conventions });
    const second = packAdvisoryBatches({ units: [...units].reverse(), conventions: [...conventions].reverse() });
    expect(second).toEqual(first);
  });
});
