import { describe, expect, test } from "bun:test";
import type { ChangedFile, ChangedSymbol, DiffHunk, DiffLine, Finding, ReviewUnit } from "../../src/types/index.ts";
import type { SnapshotReadResult } from "../../src/validate/snapshot.ts";
import { FakeValidationSnapshotReader } from "../../src/validate/snapshot.ts";
import {
  EVIDENCE_MAX_ITEMS,
  EVIDENCE_MAX_LINE_SPAN,
  EVIDENCE_MAX_QUOTE_CHARS,
  EVIDENCE_SEARCH_RADIUS,
  validateEvidence,
} from "../../src/validate/evidence.ts";

const HEAD = "c".repeat(40);
const BASE = "d".repeat(40);

function diffLine(kind: DiffLine["kind"], oldLine: number | null, newLine: number | null): DiffLine {
  return { kind, oldLine, newLine, position: newLine ?? oldLine ?? 0, text: "code" };
}

function hunk(lines: DiffLine[], newStart = 1): DiffHunk {
  return { oldStart: 1, oldLines: lines.length, newStart, newLines: lines.length, lines };
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
      hunk([diffLine("add", null, 1), diffLine("add", null, 2), diffLine("add", null, 3)], 1),
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

function testFinding(evidence: Finding["evidence"]): Finding {
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
    introducedByPr: true,
    symbol: "render",
  };
}

function ok(text: string): SnapshotReadResult {
  return { status: "ok", text, bytes: new TextEncoder().encode(text).length };
}

function readerFor(script: { head?: Record<string, SnapshotReadResult>; base?: Record<string, SnapshotReadResult> }) {
  return new FakeValidationSnapshotReader({ headSha: HEAD, mergeBase: BASE, script });
}

function inputFor(
  evidence: Finding["evidence"],
  reader: FakeValidationSnapshotReader,
  overrides?: { unit?: ReviewUnit; changedFile?: ChangedFile; canonicalPath?: string },
) {
  return {
    finding: testFinding(evidence),
    unit: overrides?.unit ?? testUnit(),
    changedFile: overrides?.changedFile ?? testFile(),
    canonicalPath: overrides?.canonicalPath ?? "src/a.ts",
    reader,
  };
}

describe("evidence bounds (P5-04)", () => {
  test("bounds constants are positive integers", () => {
    for (const value of [
      EVIDENCE_MAX_ITEMS,
      EVIDENCE_MAX_QUOTE_CHARS,
      EVIDENCE_MAX_LINE_SPAN,
      EVIDENCE_SEARCH_RADIUS,
    ]) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  test("too many evidence items are rejected without a snapshot read", async () => {
    const evidence = Array.from({ length: EVIDENCE_MAX_ITEMS + 1 }, (_, index) => ({
      file: "src/a.ts",
      startLine: 1,
      endLine: 1,
      quote: `line-${index}`,
    }));
    const reader = readerFor({ head: { "src/a.ts": ok("line-1") } });
    const result = await validateEvidence(inputFor(evidence, reader));
    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({
      name: "evidence_bounds",
      outcome: "failed",
      code: "evidence_range_invalid",
    });
    expect(reader.reads).toEqual([]);
  });

  test("oversized quote is rejected without a snapshot read", async () => {
    const reader = readerFor({ head: { "src/a.ts": ok("line-1") } });
    const result = await validateEvidence(
      inputFor(
        [{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "x".repeat(EVIDENCE_MAX_QUOTE_CHARS + 1) }],
        reader,
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({
      name: "evidence_bounds",
      outcome: "failed",
      code: "evidence_range_invalid",
    });
    expect(reader.reads).toEqual([]);
  });

  test("over-span range is rejected without a snapshot read", async () => {
    const reader = readerFor({ head: { "src/a.ts": ok("line-1") } });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: EVIDENCE_MAX_LINE_SPAN + 1, quote: "line-1" }], reader),
    );
    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({
      name: "evidence_bounds",
      outcome: "failed",
      code: "evidence_range_invalid",
    });
    expect(reader.reads).toEqual([]);
  });

  test("inverted range is rejected without a snapshot read", async () => {
    const reader = readerFor({ head: { "src/a.ts": ok("line-1") } });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 3, endLine: 2, quote: "line-1" }], reader),
    );
    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({
      name: "evidence_bounds",
      outcome: "failed",
      code: "evidence_range_invalid",
    });
    expect(reader.reads).toEqual([]);
  });

  test("whitespace-only quote never passes and performs no read", async () => {
    const reader = readerFor({ head: { "src/a.ts": ok("line-1") } });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "   \t  " }], reader),
    );
    expect(result.ok).toBe(false);
    expect(reader.reads).toEqual([]);
  });
});

describe("head-side quote verification (P5-04)", () => {
  test("exact single-line quote passes", async () => {
    const reader = readerFor({ head: { "src/a.ts": ok("line-1\nline-2\nline-3") } });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 2, endLine: 2, quote: "line-2" }], reader),
    );
    expect(result).toMatchObject({ ok: true });
    expect(result.checks).toMatchObject([
      { name: "evidence_bounds", outcome: "passed", code: "evidence_bounds_ok" },
      { name: "evidence_quote", outcome: "passed", code: "evidence_quote_verified" },
    ]);
    expect(reader.reads).toEqual([{ side: "head", path: "src/a.ts" }]);
  });

  test("multi-line CRLF quote matches an LF snapshot", async () => {
    const reader = readerFor({ head: { "src/a.ts": ok("line-1\nline-2\nline-3") } });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 2, quote: "line-1\r\nline-2" }], reader),
    );
    expect(result.ok).toBe(true);
  });

  test("horizontal whitespace variation matches", async () => {
    const reader = readerFor({ head: { "src/a.ts": ok("const   x   =   1;") } });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "const x = 1;" }], reader),
    );
    expect(result.ok).toBe(true);
  });

  test("case mutation fails", async () => {
    const reader = readerFor({ head: { "src/a.ts": ok("const x = 1;") } });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "Const X = 1;" }], reader),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.inconclusive).toBe(false);
    expect(result.checks[1]).toMatchObject({
      name: "evidence_quote",
      outcome: "failed",
      code: "evidence_quote_not_found",
    });
  });

  test("punctuation mutation fails", async () => {
    const reader = readerFor({ head: { "src/a.ts": ok("const x = 1;") } });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "const x = 2;" }], reader),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.inconclusive).toBe(false);
  });

  test("quote outside the cited window fails", async () => {
    const text = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n");
    const reader = readerFor({ head: { "src/a.ts": ok(text) } });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "line-20" }], reader),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.inconclusive).toBe(false);
  });

  test("quote just inside the radius passes, just outside fails", async () => {
    const text = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n");
    const inside = readerFor({ head: { "src/a.ts": ok(text) } });
    const insideResult = await validateEvidence(
      inputFor(
        [{ file: "src/a.ts", startLine: 10, endLine: 10, quote: `line-${10 + EVIDENCE_SEARCH_RADIUS}` }],
        inside,
      ),
    );
    expect(insideResult.ok).toBe(true);

    const outside = readerFor({ head: { "src/a.ts": ok(text) } });
    const outsideResult = await validateEvidence(
      inputFor(
        [{ file: "src/a.ts", startLine: 10, endLine: 10, quote: `line-${10 + EVIDENCE_SEARCH_RADIUS + 1}` }],
        outside,
      ),
    );
    expect(outsideResult.ok).toBe(false);
    if (!outsideResult.ok) expect(outsideResult.inconclusive).toBe(false);
  });

  test("arbitrary unprovided file is rejected without a snapshot read", async () => {
    const reader = readerFor({ head: { "src/a.ts": ok("line-1") } });
    const result = await validateEvidence(
      inputFor([{ file: "src/other.ts", startLine: 1, endLine: 1, quote: "line-1" }], reader),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.inconclusive).toBe(false);
    expect(reader.reads).toEqual([]);
  });
});

describe("old-side quote verification (P5-04)", () => {
  test("deleted-line quote is verified against mergeBase, never head", async () => {
    const reader = readerFor({
      head: { "src/a.ts": ok("line-1\nline-2\nline-3") },
      base: { "src/a.ts": ok("old-1\nold-2\nold-3\nold-4\nold-5\nold-6") },
    });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 5, endLine: 6, quote: "old-5\nold-6" }], reader),
    );
    expect(result.ok).toBe(true);
    expect(reader.reads).toEqual([{ side: "base", path: "src/a.ts" }]);
  });

  test("head-side text does not validate deleted-line evidence", async () => {
    const reader = readerFor({
      head: { "src/a.ts": ok("line-1\nline-2\nline-3") },
      base: { "src/a.ts": ok("old-1\nold-2\nold-3\nold-4\nold-5\nold-6") },
    });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 5, endLine: 5, quote: "line-1" }], reader),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.inconclusive).toBe(false);
    expect(reader.reads).toEqual([{ side: "base", path: "src/a.ts" }]);
  });

  test("new-side quote is verified against headSha, never base", async () => {
    const reader = readerFor({
      head: { "src/a.ts": ok("line-1\nline-2\nline-3") },
      base: { "src/a.ts": ok("old-1\nold-2\nold-3") },
    });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 2, endLine: 2, quote: "line-2" }], reader),
    );
    expect(result.ok).toBe(true);
    expect(reader.reads).toEqual([{ side: "head", path: "src/a.ts" }]);
  });

  test("rename old-path evidence reads the old side at mergeBase", async () => {
    const renamed: ChangedFile = { ...testFile(), status: "renamed", oldPath: "src/old.ts" };
    const unit: ReviewUnit = {
      ...testUnit(),
      file: { ...testUnit().file, path: "src/a.ts", oldPath: "src/old.ts", status: "renamed" },
    };
    const reader = readerFor({ base: { "src/old.ts": ok("old-1\nold-2\nold-3\nold-4\nold-5\nold-6") } });
    const result = await validateEvidence(
      inputFor([{ file: "src/old.ts", startLine: 5, endLine: 5, quote: "old-5" }], reader, {
        unit,
        changedFile: renamed,
        canonicalPath: "src/a.ts",
      }),
    );
    expect(result.ok).toBe(true);
    expect(reader.reads).toEqual([{ side: "base", path: "src/old.ts" }]);
  });
});

describe("side ambiguity (P5-04)", () => {
  test("identical text on both sides with overlapping metadata is inconclusive", async () => {
    const both: ChangedFile = {
      ...testFile(),
      hunks: [hunk([diffLine("del", 1, null), diffLine("add", null, 1)], 1)],
    };
    const reader = readerFor({ head: { "src/a.ts": ok("same") }, base: { "src/a.ts": ok("same") } });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "same" }], reader, { changedFile: both }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.inconclusive).toBe(true);
  });

  test("replacement content resolves to the matching side", async () => {
    const both: ChangedFile = {
      ...testFile(),
      hunks: [hunk([diffLine("del", 1, null), diffLine("add", null, 1)], 1)],
    };
    const reader = readerFor({ head: { "src/a.ts": ok("new-text") }, base: { "src/a.ts": ok("old-text") } });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "old-text" }], reader, { changedFile: both }),
    );
    expect(result.ok).toBe(true);
    expect(reader.reads).toEqual([
      { side: "head", path: "src/a.ts" },
      { side: "base", path: "src/a.ts" },
    ]);
  });
});

describe("context-file evidence (P5-04)", () => {
  function unitWithContext(text: string): ReviewUnit {
    const unit = testUnit();
    return {
      ...unit,
      context: [
        {
          id: "ctx-1",
          kind: "definition",
          file: "src/helper.ts",
          startLine: 1,
          endLine: 1,
          text,
          score: 1,
          tokens: 10,
          reason: "definition",
        },
      ],
    };
  }

  test("context quote is revalidated against the head snapshot", async () => {
    const reader = readerFor({
      head: { "src/a.ts": ok("line-1\nline-2\nline-3"), "src/helper.ts": ok("helper-body") },
    });
    const result = await validateEvidence(
      inputFor([{ file: "src/helper.ts", startLine: 1, endLine: 1, quote: "helper-body" }], reader, {
        unit: unitWithContext("helper-body"),
      }),
    );
    expect(result.ok).toBe(true);
    expect(reader.reads).toEqual([{ side: "head", path: "src/helper.ts" }]);
  });

  test("stale context text fails against the head snapshot", async () => {
    const reader = readerFor({
      head: { "src/a.ts": ok("line-1\nline-2\nline-3"), "src/helper.ts": ok("changed-body") },
    });
    const result = await validateEvidence(
      inputFor([{ file: "src/helper.ts", startLine: 1, endLine: 1, quote: "helper-body" }], reader, {
        unit: unitWithContext("helper-body"),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.inconclusive).toBe(false);
  });
});

describe("unavailable snapshots (P5-04)", () => {
  const cases: { status: SnapshotReadResult; name: string }[] = [
    { status: { status: "not_found", reason: "path is not in the head snapshot" }, name: "missing blob" },
    { status: { status: "binary", reason: "snapshot blob is binary content" }, name: "binary blob" },
    { status: { status: "unsupported", reason: "not a regular file" }, name: "unsupported object" },
    { status: { status: "size_limit", reason: "snapshot blob exceeds the cap" }, name: "oversized blob" },
    { status: { status: "timeout", reason: "snapshot blob read timed out" }, name: "read timeout" },
    { status: { status: "aborted", reason: "snapshot read aborted" }, name: "cancelled read" },
  ];

  for (const { status, name } of cases) {
    test(`${name} is inconclusive, never a pass`, async () => {
      const reader = readerFor({ head: { "src/a.ts": status } });
      const result = await validateEvidence(
        inputFor([{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "line-1" }], reader),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.inconclusive).toBe(true);
    });
  }
});

describe("verified locations (post-5 hardening)", () => {
  test("exact match records side, path, and the cited range", async () => {
    const reader = readerFor({ head: { "src/a.ts": ok("line-1\nline-2\nline-3") } });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 2, endLine: 2, quote: "line-2" }], reader),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.locations).toEqual([{ side: "head", path: "src/a.ts", startLine: 2, endLine: 2 }]);
    }
  });

  test("moved-by-one quote resolves to the actual lines", async () => {
    const text = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n");
    const reader = readerFor({ head: { "src/a.ts": ok(text) } });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 10, endLine: 10, quote: "line-11" }], reader),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.locations).toEqual([{ side: "head", path: "src/a.ts", startLine: 11, endLine: 11 }]);
    }
  });

  test("shifted multi-line quote resolves to the actual range", async () => {
    const text = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n");
    const reader = readerFor({ head: { "src/a.ts": ok(text) } });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 2, endLine: 3, quote: "line-3\nline-4" }], reader),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.locations).toEqual([{ side: "head", path: "src/a.ts", startLine: 3, endLine: 4 }]);
    }
  });

  test("max-distance neighborhood quote passes at its actual lines", async () => {
    const text = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n");
    const reader = readerFor({ head: { "src/a.ts": ok(text) } });
    const result = await validateEvidence(
      inputFor(
        [{ file: "src/a.ts", startLine: 10, endLine: 10, quote: `line-${10 + EVIDENCE_SEARCH_RADIUS}` }],
        reader,
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.locations).toEqual([
        {
          side: "head",
          path: "src/a.ts",
          startLine: 10 + EVIDENCE_SEARCH_RADIUS,
          endLine: 10 + EVIDENCE_SEARCH_RADIUS,
        },
      ]);
    }
  });

  test("quote past the neighborhood fails instead of attributing nearby lines", async () => {
    const text = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n");
    const reader = readerFor({ head: { "src/a.ts": ok(text) } });
    const result = await validateEvidence(
      inputFor(
        [{ file: "src/a.ts", startLine: 10, endLine: 10, quote: `line-${10 + EVIDENCE_SEARCH_RADIUS + 1}` }],
        reader,
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.inconclusive).toBe(false);
  });

  test("short generic quote with multiple neighborhood matches is inconclusive", async () => {
    const reader = readerFor({ head: { "src/a.ts": ok("a\nx\nx\nx\nb") } });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "x" }], reader),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.inconclusive).toBe(true);
      expect(result.checks.some((check) => check.code === "evidence_side_ambiguous")).toBe(true);
    }
  });

  test("exact match is unaffected by the same quote on nearby lines", async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`);
    lines[9] = "dup";
    lines[10] = "dup";
    lines[11] = "dup";
    const reader = readerFor({ head: { "src/a.ts": ok(lines.join("\n")) } });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 11, endLine: 11, quote: "dup" }], reader),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.locations).toEqual([{ side: "head", path: "src/a.ts", startLine: 11, endLine: 11 }]);
    }
  });

  test("off-range cite of a quote repeated on nearby lines is inconclusive", async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`);
    lines[9] = "dup";
    lines[10] = "dup";
    lines[11] = "dup";
    const reader = readerFor({ head: { "src/a.ts": ok(lines.join("\n")) } });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 9, endLine: 9, quote: "dup" }], reader),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.inconclusive).toBe(true);
      expect(result.checks.some((check) => check.code === "evidence_side_ambiguous")).toBe(true);
    }
  });

  test("cited added range with the quote on an unchanged line verifies off-range", async () => {
    const text = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join("\n");
    const reader = readerFor({ head: { "src/a.ts": ok(text) } });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 2, quote: "line-5" }], reader),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.locations).toEqual([{ side: "head", path: "src/a.ts", startLine: 5, endLine: 5 }]);
    }
  });

  test("replacement quote matching one side records that side's actual range", async () => {
    const both: ChangedFile = {
      ...testFile(),
      hunks: [hunk([diffLine("del", 1, null), diffLine("add", null, 1)], 1)],
    };
    const reader = readerFor({ head: { "src/a.ts": ok("new-text") }, base: { "src/a.ts": ok("old-text") } });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "old-text" }], reader, { changedFile: both }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.locations).toEqual([{ side: "base", path: "src/a.ts", startLine: 1, endLine: 1 }]);
    }
  });

  test("identical text on both sides stays inconclusive with the ambiguity code", async () => {
    const both: ChangedFile = {
      ...testFile(),
      hunks: [hunk([diffLine("del", 1, null), diffLine("add", null, 1)], 1)],
    };
    const reader = readerFor({ head: { "src/a.ts": ok("same") }, base: { "src/a.ts": ok("same") } });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "same" }], reader, { changedFile: both }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.inconclusive).toBe(true);
      expect(result.checks.some((check) => check.code === "evidence_side_ambiguous")).toBe(true);
    }
  });

  test("redacted secret verifies consistently on both sides", async () => {
    const reader = readerFor({ head: { "src/a.ts": ok('const password = "hunter2";\nconst a = 1;') } });
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 1, quote: 'const password = "hunter2";' }], reader),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.locations).toEqual([{ side: "head", path: "src/a.ts", startLine: 1, endLine: 1 }]);
    }
  });

  test("multi-evidence records each side and range in order", async () => {
    const reader = readerFor({
      head: { "src/a.ts": ok("line-1\nline-2\nline-3") },
      base: { "src/a.ts": ok("old-1\nold-2\nold-3\nold-4\nold-5\nold-6") },
    });
    const result = await validateEvidence(
      inputFor(
        [
          { file: "src/a.ts", startLine: 2, endLine: 2, quote: "line-2" },
          { file: "src/a.ts", startLine: 5, endLine: 6, quote: "old-5\nold-6" },
        ],
        reader,
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.locations).toEqual([
        { side: "head", path: "src/a.ts", startLine: 2, endLine: 2 },
        { side: "base", path: "src/a.ts", startLine: 5, endLine: 6 },
      ]);
    }
  });
});
