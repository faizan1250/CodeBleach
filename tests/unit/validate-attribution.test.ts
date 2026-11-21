import { describe, expect, test } from "bun:test";
import type { ChangedFile, ChangedSymbol, DiffLine, Finding, ReviewUnit } from "../../src/types/index.ts";
import type { EvidenceSide } from "../../src/validate/evidence.ts";
import { validateAttribution } from "../../src/validate/attribution.ts";
import type { ResolvedTarget } from "../../src/validate/location.ts";

const HEAD = "c".repeat(40);

function diffLine(kind: DiffLine["kind"], oldLine: number | null, newLine: number | null): DiffLine {
  return { kind, oldLine, newLine, position: newLine ?? oldLine ?? 0, text: "code" };
}

function testSymbol(overrides?: Partial<ChangedSymbol>): ChangedSymbol {
  return { name: "render", kind: "function", startLine: 1, endLine: 50, changedLines: [1, 2, 3], ...overrides };
}

/** Primary file: lines 1-3 added head-side, lines 5-6 deleted old-side. */
function testFile(): ChangedFile {
  return {
    path: "src/a.ts",
    oldPath: null,
    status: "modified",
    language: "typescript",
    hunks: [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 3,
        lines: [diffLine("add", null, 1), diffLine("add", null, 2), diffLine("add", null, 3)],
      },
      {
        oldStart: 5,
        oldLines: 2,
        newStart: 4,
        newLines: 0,
        lines: [diffLine("del", 5, null), diffLine("del", 6, null)],
      },
    ],
    commentableLines: [1, 2, 3],
    symbols: [testSymbol({ changedLines: [1, 2, 3], deletedLines: [5, 6], anchorLine: 3 })],
  };
}

function testUnit(): ReviewUnit {
  return {
    id: "unit-1",
    file: { path: "src/a.ts", oldPath: null, status: "modified", language: "typescript", commentableLines: [1, 2, 3] },
    diff: { hunks: [], originalHunkCount: 0, includedHunkCount: 0, omittedHunkCount: 0, truncated: false },
    symbol: testSymbol({ changedLines: [1, 2, 3], deletedLines: [5, 6], anchorLine: 3 }),
    context: [],
    rules: [],
  };
}

function testFinding(evidence: Finding["evidence"], introducedByPr: boolean): Finding {
  return {
    id: "finding-1",
    fingerprint: "fp-1",
    headSha: HEAD,
    origin: { pass: "test", unitId: "unit-1" },
    title: "Null dereference on name",
    severity: "high",
    category: "null-handling",
    file: "src/a.ts",
    line: 1,
    description: "name may be null at runtime.",
    confidence: 0.9,
    evidence,
    introducedByPr,
    symbol: "render",
  };
}

function addedTarget(): ResolvedTarget {
  return { file: "src/a.ts", line: 1, side: "RIGHT", kind: "added" };
}

function inputFor(
  evidence: Finding["evidence"],
  sides: EvidenceSide[],
  introducedByPr: boolean,
  overrides?: { unit?: ReviewUnit; changedFile?: ChangedFile; target?: ResolvedTarget; canonicalPath?: string },
) {
  return {
    finding: testFinding(evidence, introducedByPr),
    unit: overrides?.unit ?? testUnit(),
    changedFile: overrides?.changedFile ?? testFile(),
    canonicalPath: overrides?.canonicalPath ?? "src/a.ts",
    target: overrides?.target ?? addedTarget(),
    sides,
  };
}

describe("attribution ignores the model boolean (P5-05)", () => {
  test("model true with unchanged evidence is not accepted", () => {
    const result = validateAttribution(
      inputFor([{ file: "src/a.ts", startLine: 10, endLine: 10, quote: "line-10" }], ["head"], true),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.inconclusive).toBe(true);
    expect(result.checks.some((check) => check.name === "introduced_by_pr" && check.outcome === "inconclusive")).toBe(
      true,
    );
  });

  test("model false with added evidence still passes on code proof", () => {
    const result = validateAttribution(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "line-1" }], ["head"], false),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.introducedByPr).toBe(true);
      expect(result.basis.kind).toBe("added-lines");
    }
  });
});

describe("attribution added-line basis (P5-05)", () => {
  test("head-side evidence intersecting added lines passes", () => {
    const result = validateAttribution(
      inputFor([{ file: "src/a.ts", startLine: 2, endLine: 2, quote: "line-2" }], ["head"], true),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.basis).toEqual({ kind: "added-lines", evidenceIndex: 0, file: "src/a.ts", lines: [2] });
    }
  });

  test("context-line target with added-line evidence passes", () => {
    const result = validateAttribution(
      inputFor([{ file: "src/a.ts", startLine: 3, endLine: 3, quote: "line-3" }], ["head"], true, {
        target: { file: "src/a.ts", line: 10, side: "RIGHT", kind: "context" },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.basis.kind).toBe("added-lines");
  });

  test("added line outside the originating symbol scope does not pass", () => {
    const file: ChangedFile = {
      ...testFile(),
      hunks: [
        ...testFile().hunks,
        {
          oldStart: 50,
          oldLines: 0,
          newStart: 50,
          newLines: 1,
          lines: [diffLine("add", null, 50)],
        },
      ],
    };
    const result = validateAttribution(
      inputFor([{ file: "src/a.ts", startLine: 50, endLine: 50, quote: "line-50" }], ["head"], true, {
        changedFile: file,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.inconclusive).toBe(true);
  });

  test("context-file evidence never confers an added basis", () => {
    const unit: ReviewUnit = {
      ...testUnit(),
      context: [
        {
          id: "ctx-1",
          kind: "callee",
          file: "src/helper.ts",
          startLine: 1,
          endLine: 1,
          text: "helper",
          score: 1,
          tokens: 10,
          reason: "callee",
        },
      ],
    };
    const result = validateAttribution(
      inputFor([{ file: "src/helper.ts", startLine: 1, endLine: 1, quote: "helper" }], ["head"], true, { unit }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.inconclusive).toBe(true);
  });
});

describe("attribution deleted-line basis (P5-05)", () => {
  test("old-side evidence intersecting deleted lines passes with an anchor", () => {
    const result = validateAttribution(
      inputFor([{ file: "src/a.ts", startLine: 5, endLine: 6, quote: "old-code" }], ["base"], true, {
        target: { file: "src/a.ts", line: 3, side: "RIGHT", kind: "deletion-anchor", sourceLine: 5 },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.basis).toEqual({ kind: "deleted-lines", evidenceIndex: 0, file: "src/a.ts", lines: [5, 6] });
    }
  });

  test("renamed old-path evidence maps to the deleted basis", () => {
    const file: ChangedFile = { ...testFile(), status: "renamed", oldPath: "src/old.ts", path: "src/a.ts" };
    const unit: ReviewUnit = {
      ...testUnit(),
      file: { ...testUnit().file, oldPath: "src/old.ts", status: "renamed" },
    };
    const result = validateAttribution(
      inputFor([{ file: "src/old.ts", startLine: 5, endLine: 5, quote: "old-code" }], ["base"], false, {
        changedFile: file,
        unit,
        target: { file: "src/a.ts", line: 3, side: "RIGHT", kind: "deletion-anchor", sourceLine: 5 },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.basis.kind).toBe("deleted-lines");
  });

  test("replacement hunk maps each verified side to its own basis", () => {
    const file: ChangedFile = {
      ...testFile(),
      hunks: [
        {
          oldStart: 7,
          oldLines: 1,
          newStart: 7,
          newLines: 1,
          lines: [diffLine("del", 7, null), diffLine("add", null, 7)],
        },
      ],
      commentableLines: [7],
      symbols: [testSymbol({ changedLines: [7], deletedLines: [7], anchorLine: 7 })],
    };
    const unit: ReviewUnit = {
      ...testUnit(),
      symbol: testSymbol({ changedLines: [7], deletedLines: [7], anchorLine: 7 }),
    };
    const head = validateAttribution(
      inputFor([{ file: "src/a.ts", startLine: 7, endLine: 7, quote: "new-code" }], ["head"], true, {
        changedFile: file,
        unit,
        target: { file: "src/a.ts", line: 7, side: "RIGHT", kind: "added" },
      }),
    );
    expect(head.ok).toBe(true);
    if (head.ok) expect(head.basis.kind).toBe("added-lines");
    const base = validateAttribution(
      inputFor([{ file: "src/a.ts", startLine: 7, endLine: 7, quote: "old-code" }], ["base"], true, {
        changedFile: file,
        unit,
        target: { file: "src/a.ts", line: 7, side: "RIGHT", kind: "deletion-anchor", sourceLine: 7 },
      }),
    );
    expect(base.ok).toBe(true);
    if (base.ok) expect(base.basis.kind).toBe("deleted-lines");
  });
});

describe("attribution ambiguity policy (P5-05)", () => {
  test("context-only evidence with no change linkage is inconclusive", () => {
    const file: ChangedFile = { ...testFile(), hunks: [], commentableLines: [10] };
    const unit: ReviewUnit = { ...testUnit(), symbol: testSymbol({ changedLines: [], deletedLines: undefined }) };
    const result = validateAttribution(
      inputFor([{ file: "src/a.ts", startLine: 10, endLine: 10, quote: "line-10" }], ["head"], true, {
        changedFile: file,
        unit,
        target: { file: "src/a.ts", line: 10, side: "RIGHT", kind: "context" },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.inconclusive).toBe(true);
  });

  test("side-count mismatch with evidence fails closed", () => {
    const result = validateAttribution(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "line-1" }], [], true),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.inconclusive).toBe(true);
  });
});
