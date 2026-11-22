import { describe, expect, test } from "bun:test";
import { ConventionAdvisoryUnitProjectorImpl } from "../../../src/conventions/projection.ts";
import { serializeConventionAdvisoryUnit } from "../../../src/conventions/projection.ts";
import type { AdvisorySnapshotTexts } from "../../../src/conventions/projection.ts";
import { MAX_ADVISORY_SYMBOL_SOURCE_TOKENS, MAX_ADVISORY_UNIT_TOKENS } from "../../../src/conventions/constants.ts";
import { countAdvisoryTokens } from "../../../src/conventions/token-budget.ts";
import type { DiffResult, ReviewUnit } from "../../../src/types/index.ts";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);

function diffResult(): DiffResult {
  return { baseSha: BASE_SHA, headSha: HEAD_SHA, mergeBase: BASE_SHA, files: [] };
}

function reviewUnit(overrides: Partial<ReviewUnit> = {}): ReviewUnit {
  return {
    id: "ctx-unit-1",
    file: {
      path: "src/a.ts",
      oldPath: null,
      status: "modified",
      language: "typescript",
      commentableLines: [10, 11, 12],
    },
    diff: {
      hunks: [
        {
          oldStart: 9,
          oldLines: 5,
          newStart: 9,
          newLines: 6,
          lines: [
            { kind: "ctx", oldLine: 9, newLine: 9, position: 1, text: "export function load(): string {" },
            { kind: "del", oldLine: 10, newLine: null, position: 2, text: "  return read();" },
            { kind: "add", oldLine: null, newLine: 10, position: 3, text: "  return read OrThrow();" },
            { kind: "ctx", oldLine: 11, newLine: 11, position: 4, text: "}" },
          ],
        },
      ],
      originalHunkCount: 1,
      includedHunkCount: 1,
      omittedHunkCount: 0,
      truncated: false,
    },
    symbol: {
      name: "load",
      kind: "function",
      startLine: 9,
      endLine: 11,
      changedLines: [10],
    },
    context: [],
    rules: [],
    ...overrides,
  };
}

const HEAD_TEXT = `import { readOrThrow } from "./reader";\n\nexport function load(): string {\n  return readOrThrow();\n}\n\nexport function other(): number {\n  return 1;\n}\n`;

function memorySnapshot(texts: { head?: string | null; base?: string | null }): AdvisorySnapshotTexts {
  return {
    readHeadText: async (_path: string) => texts.head ?? null,
    readBaseText: async (_path: string) => texts.base ?? null,
  };
}

function projectorFor(texts: { head?: string | null; base?: string | null }): ConventionAdvisoryUnitProjectorImpl {
  return new ConventionAdvisoryUnitProjectorImpl({ snapshot: memorySnapshot(texts) });
}

describe("p6-03 lean projection", () => {
  test("projects small unit with complete symbol source", async () => {
    const projector = projectorFor({ head: HEAD_TEXT });
    const result = await projector.project({ units: [reviewUnit()], diff: diffResult() });
    expect(result.skippedUnits).toBe(0);
    expect(result.units).toHaveLength(1);
    const projected = result.units[0];
    expect(projected?.unitId).toBe("ctx-unit-1");
    expect(projected?.path).toBe("src/a.ts");
    expect(projected?.language).toBe("typescript");
    expect(projected?.symbol.name).toBe("load");
    expect(projected?.symbol.kind).toBe("function");
    expect(projected?.symbol.side).toBe("head");
    expect(projected?.symbol.signature).toContain("load");
    expect(projected?.changedSymbolSource).toBe("function load(): string {\n  return readOrThrow();\n}");
    const hunkLines = (projected?.diffHunks ?? []).flatMap((hunk) => hunk.lines);
    expect(hunkLines).toContain("+  return read OrThrow();");
    expect(hunkLines).toContain("-  return read();");
  });

  test("trims unchanged context to two lines per side", async () => {
    const lines = [
      "  line one;",
      "  line two;",
      "  line three;",
      "  line four;",
      "+  changed;",
      "  after one;",
      "  after two;",
      "  after three;",
    ];
    const projector = projectorFor({ head: HEAD_TEXT });
    const result = await projector.project({
      units: [
        reviewUnit({
          diff: {
            hunks: [
              {
                oldStart: 1,
                oldLines: 8,
                newStart: 1,
                newLines: 8,
                lines: lines.map((text, index) => ({
                  kind: text.startsWith("+") ? ("add" as const) : ("ctx" as const),
                  oldLine: text.startsWith("+") ? null : index + 1,
                  newLine: index + 1,
                  position: index + 1,
                  text: text.startsWith("+") ? text.slice(1) : text,
                })),
              },
            ],
            originalHunkCount: 1,
            includedHunkCount: 1,
            omittedHunkCount: 0,
            truncated: false,
          },
        }),
      ],
      diff: diffResult(),
    });
    const hunkLines = (result.units[0]?.diffHunks ?? []).flatMap((hunk) => hunk.lines);
    expect(hunkLines).toContain("+  changed;");
    expect(hunkLines).not.toContain("   line one;");
    expect(hunkLines).not.toContain("   line two;");
    expect(hunkLines).toContain("   line three;");
    expect(hunkLines).toContain("   line four;");
    expect(hunkLines).toContain("   after one;");
    expect(hunkLines).toContain("   after two;");
    expect(hunkLines).not.toContain("   after three;");
  });

  test("withholds oversized symbol source but keeps hunks", async () => {
    const body = `${"  step();\n".repeat(600)}`;
    const big = `export function heavy(): void {\n${body}}\n`;
    const projector = projectorFor({ head: `${big}\nexport function other(): void {}\n` });
    const result = await projector.project({
      units: [
        reviewUnit({
          id: "ctx-heavy",
          symbol: { name: "heavy", kind: "function", startLine: 1, endLine: 602, changedLines: [2] },
        }),
      ],
      diff: diffResult(),
    });
    expect(result.units).toHaveLength(1);
    expect(result.skippedUnits).toBe(0);
    expect(result.units[0]?.changedSymbolSource).toBeNull();
    const hunkLines = (result.units[0]?.diffHunks ?? []).flatMap((hunk) => hunk.lines);
    expect(hunkLines.some((line) => line.startsWith("+") || line.startsWith("-"))).toBe(true);
  });

  test("skips unit exceeding the per-unit budget", async () => {
    const projector = projectorFor({ head: HEAD_TEXT });
    const result = await projector.project({
      units: [
        reviewUnit({
          id: "ctx-giant",
          diff: {
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: [{ kind: "add", oldLine: null, newLine: 1, position: 1, text: "z".repeat(6000) }],
              },
            ],
            originalHunkCount: 1,
            includedHunkCount: 1,
            omittedHunkCount: 0,
            truncated: false,
          },
        }),
      ],
      diff: diffResult(),
    });
    expect(result.units).toHaveLength(0);
    expect(result.skippedUnits).toBe(1);
  });

  test("projects deleted symbol from the base side", async () => {
    const baseText = `export function gone(): string {\n  return legacy();\n}\n`;
    const projector = projectorFor({ head: null, base: baseText });
    const result = await projector.project({
      units: [
        reviewUnit({
          id: "ctx-gone",
          symbol: { name: "gone", kind: "function", startLine: 1, endLine: 3, changedLines: [], deletedLines: [2] },
        }),
      ],
      diff: diffResult(),
    });
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.symbol.side).toBe("base");
    expect(result.units[0]?.changedSymbolSource).toBe("function gone(): string {\n  return legacy();\n}");
  });

  test("marks missing AST match with the unknown symbol marker", async () => {
    const projector = projectorFor({ head: HEAD_TEXT });
    const result = await projector.project({
      units: [
        reviewUnit({
          id: "ctx-missing",
          symbol: { name: "absent", kind: "function", startLine: 1, endLine: 2, changedLines: [1] },
        }),
      ],
      diff: diffResult(),
    });
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.symbol.name).toBe("unknown");
    expect(result.units[0]?.symbol.kind).toBe("unknown");
    expect(result.units[0]?.changedSymbolSource).toBeNull();
    const hunkLines = (result.units[0]?.diffHunks ?? []).flatMap((hunk) => hunk.lines);
    expect(hunkLines.some((line) => line.startsWith("+") || line.startsWith("-"))).toBe(true);
  });

  test("marks module and unsupported-language units unknown without source", async () => {
    const projector = projectorFor({ head: HEAD_TEXT });
    const result = await projector.project({
      units: [
        reviewUnit({
          id: "ctx-module",
          symbol: { name: "<module>", kind: "module", startLine: 1, endLine: 9, changedLines: [10] },
        }),
        reviewUnit({
          id: "ctx-lang",
          file: {
            path: "scripts/tool.py",
            oldPath: null,
            status: "modified",
            language: null,
            commentableLines: [3],
          },
          symbol: { name: "tool", kind: "function", startLine: 1, endLine: 5, changedLines: [3] },
        }),
      ],
      diff: diffResult(),
    });
    expect(result.units).toHaveLength(2);
    for (const projected of result.units) {
      expect(projected.symbol.name).toBe("unknown");
      expect(projected.symbol.kind).toBe("unknown");
      expect(projected.changedSymbolSource).toBeNull();
    }
    expect(result.units[1]?.language).toBe("unknown");
  });

  test("rejects control-character paths before snapshot reads", async () => {
    let reads = 0;
    const snapshot: AdvisorySnapshotTexts = {
      readHeadText: async (_path: string) => {
        reads += 1;
        return HEAD_TEXT;
      },
      readBaseText: async (_path: string) => {
        reads += 1;
        return null;
      },
    };
    const projector = new ConventionAdvisoryUnitProjectorImpl({ snapshot });
    const result = await projector.project({
      units: [
        reviewUnit({
          id: "ctx-bad",
          file: {
            path: "src/ba\nd.ts",
            oldPath: null,
            status: "modified",
            language: "typescript",
            commentableLines: [10],
          },
        }),
      ],
      diff: diffResult(),
    });
    expect(result.units).toHaveLength(0);
    expect(result.skippedUnits).toBe(1);
    expect(reads).toBe(0);
  });

  test("skips vacuous units without changed lines or source", async () => {
    const projector = projectorFor({ head: HEAD_TEXT });
    const result = await projector.project({
      units: [
        reviewUnit({
          id: "ctx-vacuous",
          symbol: { name: "absent", kind: "function", startLine: 1, endLine: 2, changedLines: [] },
          diff: {
            hunks: [
              {
                oldStart: 1,
                oldLines: 2,
                newStart: 1,
                newLines: 2,
                lines: [
                  { kind: "ctx", oldLine: 1, newLine: 1, position: 1, text: "  a;" },
                  { kind: "ctx", oldLine: 2, newLine: 2, position: 2, text: "  b;" },
                ],
              },
            ],
            originalHunkCount: 1,
            includedHunkCount: 1,
            omittedHunkCount: 0,
            truncated: false,
          },
        }),
      ],
      diff: diffResult(),
    });
    expect(result.units).toHaveLength(0);
    expect(result.skippedUnits).toBe(1);
  });

  test("degrades to hunks when the snapshot read fails", async () => {
    const snapshot: AdvisorySnapshotTexts = {
      readHeadText: async (_path: string) => {
        throw new Error("blob missing");
      },
      readBaseText: async (_path: string) => null,
    };
    const projector = new ConventionAdvisoryUnitProjectorImpl({ snapshot });
    const result = await projector.project({ units: [reviewUnit()], diff: diffResult() });
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.changedSymbolSource).toBeNull();
    expect(result.units[0]?.symbol.name).toBe("unknown");
  });

  test("projection order is deterministic across input permutations", async () => {
    const projector = projectorFor({ head: HEAD_TEXT });
    const first = reviewUnit({
      id: "ctx-1",
      file: {
        path: "src/b.ts",
        oldPath: null,
        status: "modified",
        language: "typescript",
        commentableLines: [10],
      },
    });
    const secondUnit = reviewUnit({
      id: "ctx-2",
      file: {
        path: "src/a.ts",
        oldPath: null,
        status: "modified",
        language: "typescript",
        commentableLines: [10],
      },
    });
    const firstResult = await projector.project({ units: [first, secondUnit], diff: diffResult() });
    const secondResult = await projector.project({ units: [secondUnit, first], diff: diffResult() });
    expect(secondResult).toEqual(firstResult);
    expect(firstResult.units.map((entry) => entry.unitId).sort()).toEqual(["ctx-1", "ctx-2"]);
  });

  test("serialized typical units stay under the unit ceiling", async () => {
    const projector = projectorFor({ head: HEAD_TEXT });
    const result = await projector.project({ units: [reviewUnit()], diff: diffResult() });
    const serialized = serializeConventionAdvisoryUnit(result.units[0]!);
    expect(countAdvisoryTokens(serialized)).toBeLessThanOrEqual(MAX_ADVISORY_UNIT_TOKENS);
    expect(countAdvisoryTokens(result.units[0]?.changedSymbolSource ?? "")).toBeLessThanOrEqual(
      MAX_ADVISORY_SYMBOL_SOURCE_TOKENS,
    );
  });

  test("serialized form carries no explicit rules", async () => {
    const projector = projectorFor({ head: HEAD_TEXT });
    const result = await projector.project({
      units: [reviewUnit({ rules: [{ id: "arch-001", kind: "architecture", text: "No logic in controllers." }] })],
      diff: diffResult(),
    });
    const serialized = serializeConventionAdvisoryUnit(result.units[0]!);
    expect(serialized).not.toContain("arch-001");
    expect(serialized).not.toContain("No logic in controllers.");
  });
});
