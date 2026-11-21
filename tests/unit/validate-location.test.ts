import { describe, expect, test } from "bun:test";
import type { ChangedFile, ChangedSymbol, DiffHunk, DiffLine, Finding, ReviewUnit } from "../../src/types/index.ts";
import { FakeValidationSnapshotReader } from "../../src/validate/snapshot.ts";
import { LOCATION_RELOCATION_RADIUS, validateLocation } from "../../src/validate/location.ts";

const HEAD = "c".repeat(40);
const BASE = "d".repeat(40);

function diffLine(kind: DiffLine["kind"], oldLine: number | null, newLine: number | null): DiffLine {
  return { kind, oldLine, newLine, position: newLine ?? oldLine ?? 0, text: "code" };
}

function hunk(lines: DiffLine[], newStart = 1): DiffHunk {
  return { oldStart: 1, oldLines: lines.length, newStart, newLines: lines.length, lines };
}

function testSymbol(overrides?: Partial<ChangedSymbol>): ChangedSymbol {
  return { name: "render", kind: "function", startLine: 1, endLine: 50, changedLines: [10, 11], ...overrides };
}

function testFile(overrides?: Partial<ChangedFile>): ChangedFile {
  return {
    path: "src/a.ts",
    oldPath: null,
    status: "modified",
    language: "typescript",
    hunks: [],
    commentableLines: [],
    symbols: [testSymbol()],
    ...overrides,
  };
}

function testUnit(symbol?: ChangedSymbol): ReviewUnit {
  const active = symbol ?? testSymbol();
  return {
    id: "unit-1",
    file: { path: "src/a.ts", oldPath: null, status: "modified", language: "typescript", commentableLines: [] },
    diff: { hunks: [], originalHunkCount: 0, includedHunkCount: 0, omittedHunkCount: 0, truncated: false },
    symbol: active,
    context: [],
    rules: [],
  };
}

function testFinding(line: number): Finding {
  return {
    id: "finding-1",
    fingerprint: "fp-1",
    headSha: HEAD,
    origin: { pass: "test", unitId: "unit-1" },
    title: "Null dereference on name",
    severity: "high",
    category: "null-handling",
    file: "src/a.ts",
    line,
    description: "name may be null at runtime.",
    confidence: 0.9,
    evidence: [{ file: "src/a.ts", startLine: line, endLine: line, quote: "q" }],
    introducedByPr: true,
    symbol: "render",
  };
}

/** Head snapshot with exactly `count` lines; line i holds `line-i`. */
function headText(count: number): string {
  return Array.from({ length: count }, (_, index) => `line-${index + 1}`).join("\n");
}

function readerWithHead(text: string): FakeValidationSnapshotReader {
  const bytes = new TextEncoder().encode(text).length;
  return new FakeValidationSnapshotReader({
    headSha: HEAD,
    mergeBase: BASE,
    script: { head: { "src/a.ts": { status: "ok", text, bytes } } },
  });
}

function readerWithHeadResult(result: { status: "not_found"; reason: string }): FakeValidationSnapshotReader {
  return new FakeValidationSnapshotReader({
    headSha: HEAD,
    mergeBase: BASE,
    script: { head: { "src/a.ts": result } },
  });
}

function addedHunk(): DiffHunk {
  return hunk([diffLine("add", null, 10), diffLine("add", null, 11)], 10);
}

describe("location line guard (P5-03)", () => {
  test("non-positive line is rejected without a snapshot read", async () => {
    const reader = readerWithHead(headText(30));
    const result = await validateLocation({
      finding: testFinding(0),
      unit: testUnit(),
      changedFile: testFile(),
      canonicalPath: "src/a.ts",
      reader,
    });
    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({ name: "location_line", passed: false });
    expect(reader.reads).toEqual([]);
  });

  test("fractional line is rejected without a snapshot read", async () => {
    const reader = readerWithHead(headText(30));
    const result = await validateLocation({
      finding: testFinding(1.5),
      unit: testUnit(),
      changedFile: testFile(),
      canonicalPath: "src/a.ts",
      reader,
    });
    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({ name: "location_line", passed: false });
    expect(reader.reads).toEqual([]);
  });

  test("relocation radius constant is the ADR 0028 default", () => {
    expect(LOCATION_RELOCATION_RADIUS).toBe(5);
  });
});

describe("head-side target resolution (P5-03)", () => {
  test("added line resolves to an added RIGHT target", async () => {
    const file = testFile({ hunks: [addedHunk()], commentableLines: [10, 11] });
    const result = await validateLocation({
      finding: testFinding(10),
      unit: testUnit(),
      changedFile: file,
      canonicalPath: "src/a.ts",
      reader: readerWithHead(headText(30)),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({ file: "src/a.ts", line: 10, side: "RIGHT", kind: "added" });
    }
  });

  test("commentable context line resolves to a context target, never added", async () => {
    const file = testFile({
      hunks: [hunk([diffLine("ctx", 19, 20), diffLine("ctx", 20, 21), diffLine("add", null, 22)], 20)],
      commentableLines: [20, 21, 22],
    });
    const result = await validateLocation({
      finding: testFinding(20),
      unit: testUnit(testSymbol({ changedLines: [22] })),
      changedFile: file,
      canonicalPath: "src/a.ts",
      reader: readerWithHead(headText(30)),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.kind).toBe("context");
      expect(result.target.line).toBe(20);
      expect(result.target.side).toBe("RIGHT");
    }
  });

  test("context target with nearby added evidence stays eligible", async () => {
    const file = testFile({
      hunks: [hunk([diffLine("ctx", 19, 20), diffLine("add", null, 21)], 20)],
      commentableLines: [20, 21],
    });
    const result = await validateLocation({
      finding: testFinding(20),
      unit: testUnit(testSymbol({ changedLines: [21] })),
      changedFile: file,
      canonicalPath: "src/a.ts",
      reader: readerWithHead(headText(30)),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.target.kind).toBe("context");
  });

  test("uncommentable line near a same-symbol change relocates", async () => {
    const file = testFile({ hunks: [addedHunk()], commentableLines: [10, 11] });
    const result = await validateLocation({
      finding: testFinding(8),
      unit: testUnit(),
      changedFile: file,
      canonicalPath: "src/a.ts",
      reader: readerWithHead(headText(30)),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({ file: "src/a.ts", line: 10, side: "RIGHT", kind: "relocated", sourceLine: 8 });
    }
  });

  test("line beyond the radius is rejected", async () => {
    const file = testFile({ hunks: [addedHunk()], commentableLines: [10, 11] });
    const result = await validateLocation({
      finding: testFinding(4),
      unit: testUnit(),
      changedFile: file,
      canonicalPath: "src/a.ts",
      reader: readerWithHead(headText(30)),
    });
    expect(result.ok).toBe(false);
    expect(result.checks.some((check) => check.name === "head_comment_target" && !check.passed)).toBe(true);
  });

  test("radius boundary accepts distance 5 and rejects distance 6", async () => {
    const file = testFile({ hunks: [addedHunk()], commentableLines: [10, 11] });
    const near = await validateLocation({
      finding: testFinding(5),
      unit: testUnit(),
      changedFile: file,
      canonicalPath: "src/a.ts",
      reader: readerWithHead(headText(30)),
    });
    expect(near.ok).toBe(true);
    if (near.ok) expect(near.target.line).toBe(10);
    const far = await validateLocation({
      finding: testFinding(3),
      unit: testUnit(),
      changedFile: file,
      canonicalPath: "src/a.ts",
      reader: readerWithHead(headText(30)),
    });
    expect(far.ok).toBe(false);
  });

  test("relocation tie-break prefers the lower line", async () => {
    const file = testFile({
      hunks: [hunk([diffLine("add", null, 8), diffLine("add", null, 12)], 8)],
      commentableLines: [8, 12],
    });
    const result = await validateLocation({
      finding: testFinding(10),
      unit: testUnit(testSymbol({ changedLines: [8, 12] })),
      changedFile: file,
      canonicalPath: "src/a.ts",
      reader: readerWithHead(headText(30)),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.kind).toBe("relocated");
      expect(result.target.line).toBe(8);
    }
  });

  test("relocation never crosses to another symbol's changed lines", async () => {
    const file = testFile({
      hunks: [hunk([diffLine("add", null, 11)], 11)],
      commentableLines: [11, 30],
      symbols: [testSymbol(), testSymbol({ name: "other", changedLines: [11] })],
    });
    const result = await validateLocation({
      finding: testFinding(10),
      unit: testUnit(testSymbol({ changedLines: [30] })),
      changedFile: file,
      canonicalPath: "src/a.ts",
      reader: readerWithHead(headText(30)),
    });
    expect(result.ok).toBe(false);
  });

  test("rename canonical target uses the new head-side path", async () => {
    const file = testFile({
      path: "src/new.ts",
      oldPath: "src/old.ts",
      status: "renamed",
      hunks: [addedHunk()],
      commentableLines: [10, 11],
    });
    const reader = new FakeValidationSnapshotReader({
      headSha: HEAD,
      mergeBase: BASE,
      script: { head: { "src/new.ts": { status: "ok", text: headText(30), bytes: headText(30).length } } },
    });
    const result = await validateLocation({
      finding: testFinding(10),
      unit: testUnit(),
      changedFile: file,
      canonicalPath: "src/new.ts",
      reader,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.target.file).toBe("src/new.ts");
  });

  test("replacement hunk resolves the added side as an added target", async () => {
    const file = testFile({
      hunks: [hunk([diffLine("del", 20, null), diffLine("add", null, 20)], 20)],
      commentableLines: [20],
    });
    const result = await validateLocation({
      finding: testFinding(20),
      unit: testUnit(testSymbol({ changedLines: [20] })),
      changedFile: file,
      canonicalPath: "src/a.ts",
      reader: readerWithHead(headText(30)),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({ file: "src/a.ts", line: 20, side: "RIGHT", kind: "added" });
    }
  });

  test("relocation from a rename old path targets the new head-side path", async () => {
    const file = testFile({
      path: "src/new.ts",
      oldPath: "src/old.ts",
      status: "renamed",
      hunks: [addedHunk()],
      commentableLines: [10, 11],
    });
    const text = headText(30);
    const reader = new FakeValidationSnapshotReader({
      headSha: HEAD,
      mergeBase: BASE,
      script: { head: { "src/new.ts": { status: "ok", text, bytes: text.length } } },
    });
    const finding = testFinding(8);
    finding.file = "src/old.ts";
    const result = await validateLocation({
      finding,
      unit: testUnit(),
      changedFile: file,
      canonicalPath: "src/new.ts",
      reader,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({ file: "src/new.ts", line: 10, side: "RIGHT", kind: "relocated", sourceLine: 8 });
    }
  });

  test("line beyond head snapshot length is rejected when nothing relocates", async () => {
    const file = testFile({ hunks: [addedHunk()], commentableLines: [10, 11] });
    const result = await validateLocation({
      finding: testFinding(50),
      unit: testUnit(),
      changedFile: file,
      canonicalPath: "src/a.ts",
      reader: readerWithHead(headText(30)),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.inconclusive).toBe(false);
  });

  test("missing head snapshot is inconclusive, never accepted", async () => {
    const file = testFile({ hunks: [addedHunk()], commentableLines: [10, 11] });
    const result = await validateLocation({
      finding: testFinding(10),
      unit: testUnit(),
      changedFile: file,
      canonicalPath: "src/a.ts",
      reader: readerWithHeadResult({ status: "not_found", reason: "path is not in the head snapshot" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.inconclusive).toBe(true);
  });
});

describe("deletion anchors (P5-03)", () => {
  function pureDeletionFile(symbol: ChangedSymbol): ChangedFile {
    return testFile({
      hunks: [hunk([diffLine("del", 20, null)], 20)],
      commentableLines: [21],
      symbols: [symbol],
    });
  }

  test("deleted line resolves to a valid head anchor", async () => {
    const symbol = testSymbol({ changedLines: [], deletedLines: [20], anchorLine: 21 });
    const result = await validateLocation({
      finding: testFinding(20),
      unit: testUnit(symbol),
      changedFile: pureDeletionFile(symbol),
      canonicalPath: "src/a.ts",
      reader: readerWithHead(headText(30)),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({
        file: "src/a.ts",
        line: 21,
        side: "RIGHT",
        kind: "deletion-anchor",
        sourceLine: 20,
      });
    }
  });

  test("deleted line without an anchor is rejected", async () => {
    const symbol = testSymbol({ changedLines: [], deletedLines: [20], anchorLine: undefined });
    const result = await validateLocation({
      finding: testFinding(20),
      unit: testUnit(symbol),
      changedFile: pureDeletionFile(symbol),
      canonicalPath: "src/a.ts",
      reader: readerWithHead(headText(30)),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.inconclusive).toBe(false);
  });

  test("deleted line with a non-commentable anchor is rejected", async () => {
    const symbol = testSymbol({ changedLines: [], deletedLines: [20], anchorLine: 22 });
    const file = testFile({
      hunks: [hunk([diffLine("del", 20, null)], 20)],
      commentableLines: [21],
      symbols: [symbol],
    });
    const result = await validateLocation({
      finding: testFinding(20),
      unit: testUnit(symbol),
      changedFile: file,
      canonicalPath: "src/a.ts",
      reader: readerWithHead(headText(30)),
    });
    expect(result.ok).toBe(false);
  });

  test("fully deleted file has no head-side target and performs no snapshot read", async () => {
    const reader = readerWithHead(headText(30));
    const result = await validateLocation({
      finding: testFinding(10),
      unit: testUnit(),
      changedFile: testFile({ status: "deleted" }),
      canonicalPath: "src/a.ts",
      reader,
    });
    expect(result.ok).toBe(false);
    expect(reader.reads).toEqual([]);
  });
});
