import { describe, expect, test } from "bun:test";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import { ReviewerError } from "../../src/core/errors.ts";
import type { ChangedFile, DiffResult, Finding, ReviewUnit } from "../../src/types/index.ts";
import { FakeValidationSnapshotReader } from "../../src/validate/snapshot.ts";
import { createValidationEngine } from "../../src/validate/engine.ts";
import type { ValidationReaderInput } from "../../src/validate/engine.ts";

const HEAD = "c".repeat(40);
const BASE = "d".repeat(40);

function testChangedFile(): ChangedFile {
  return {
    path: "src/a.ts",
    oldPath: null,
    status: "modified",
    language: "typescript",
    hunks: [],
    commentableLines: [1],
    symbols: [{ name: "render", kind: "function", startLine: 1, endLine: 10, changedLines: [1] }],
  };
}

function testUnit(id = "unit-1"): ReviewUnit {
  const file = testChangedFile();
  return {
    id,
    file: {
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      language: file.language,
      commentableLines: [...file.commentableLines],
    },
    diff: { hunks: [], originalHunkCount: 0, includedHunkCount: 0, omittedHunkCount: 0, truncated: false },
    symbol: { name: "render", kind: "function", startLine: 1, endLine: 10, changedLines: [1] },
    context: [],
    rules: [],
  };
}

function testDiff(): DiffResult {
  return { baseSha: BASE, headSha: HEAD, mergeBase: BASE, files: [testChangedFile()] };
}

function headText(count: number): string {
  return Array.from({ length: count }, (_, index) => `line-${index + 1}`).join("\n");
}

function testAddedFile(): ChangedFile {
  return {
    ...testChangedFile(),
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [{ kind: "add" as const, oldLine: null, newLine: 1, position: 1, text: "code" }],
      },
    ],
  };
}

function testAddedDiff(): DiffResult {
  return { baseSha: BASE, headSha: HEAD, mergeBase: BASE, files: [testAddedFile()] };
}

function engineWithHeadText(text: string, readers: FakeValidationSnapshotReader[] = []) {
  return createValidationEngine({
    repoDir: "/repo",
    createReader: (input) => {
      const reader = new FakeValidationSnapshotReader({
        headSha: input.headSha,
        mergeBase: input.mergeBase,
        script: { head: { "src/a.ts": { status: "ok" as const, text, bytes: text.length } } },
      });
      readers.push(reader);
      return reader;
    },
  });
}

function testFinding(id: string = "finding-1"): Finding {
  return {
    id,
    fingerprint: `fp-${id}`,
    headSha: HEAD,
    origin: { pass: "test", unitId: "unit-1" },
    title: "Null dereference on name",
    severity: "high",
    category: "null-handling",
    file: "src/a.ts",
    line: 1,
    description: "name may be null at runtime.",
    confidence: 0.9,
    evidence: [{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "line-1" }],
    introducedByPr: true,
  };
}

describe("validation engine construction", () => {
  test("rejects an empty repoDir", () => {
    expect(() => createValidationEngine({ repoDir: "" })).toThrow(ReviewerError);
  });

  test("binds the configured repoDir without global state", () => {
    const inputs: ValidationReaderInput[] = [];
    const engine = createValidationEngine({
      repoDir: "/repo",
      createReader: (input) => {
        inputs.push(input);
        return new FakeValidationSnapshotReader({ headSha: input.headSha, mergeBase: input.mergeBase });
      },
    });
    expect((engine as { repoDir?: unknown }).repoDir).toBe("/repo");
    expect(inputs).toHaveLength(0);
  });
});

describe("validation engine provenance (P5-02)", () => {
  test("empty findings validate to an empty result", async () => {
    const engine = createValidationEngine({ repoDir: "/repo" });
    const result = await engine.validate([], testDiff(), [], ConfigFileSchema.parse({}));
    expect(result).toEqual([]);
  });

  test("findings with proven attribution are accepted with a recorded basis", async () => {
    const readers: FakeValidationSnapshotReader[] = [];
    const engine = engineWithHeadText(headText(10), readers);
    const config = ConfigFileSchema.parse({});
    const result = await engine.validate([testFinding("a"), testFinding("b")], testAddedDiff(), [testUnit()], config);
    expect(result).toHaveLength(2);
    for (const item of result) {
      expect(item.status).toBe("accepted");
      expect(item.checks).toHaveLength(16);
      expect(item.checks.every((check) => check.passed)).toBe(true);
      expect(item.checks.some((check) => check.name === "location_line")).toBe(true);
      expect(item.checks.some((check) => check.name === "head_comment_target")).toBe(true);
      expect(item.checks.some((check) => check.name === "evidence_bounds" && check.passed)).toBe(true);
      expect(item.checks.some((check) => check.name === "evidence_quote" && check.passed)).toBe(true);
      expect(item.checks.some((check) => check.name === "introduced_by_pr" && check.passed)).toBe(true);
      expect(item.derivedAttribution).toEqual({
        introducedByPr: true,
        basis: { kind: "added-lines", evidenceIndex: 0, file: "src/a.ts", lines: [1] },
      });
      expect("llmVerdict" in item).toBe(false);
    }
    expect(readers[0]?.reads).toEqual([
      { side: "head", path: "src/a.ts" },
      { side: "head", path: "src/a.ts" },
      { side: "head", path: "src/a.ts" },
      { side: "head", path: "src/a.ts" },
    ]);
  });

  test("model false with added evidence is accepted on code proof", async () => {
    const engine = engineWithHeadText(headText(10));
    const config = ConfigFileSchema.parse({});
    const finding = testFinding();
    finding.introducedByPr = false;
    const result = await engine.validate([finding], testAddedDiff(), [testUnit()], config);
    expect(result[0]?.status).toBe("accepted");
    expect(result[0]?.derivedAttribution?.introducedByPr).toBe(true);
    expect(result[0]?.derivedAttribution?.basis?.kind).toBe("added-lines");
  });

  test("model true with unchanged evidence is inconclusive, never accepted", async () => {
    const engine = engineWithHeadText(headText(10));
    const config = ConfigFileSchema.parse({});
    const finding = testFinding();
    finding.evidence = [{ file: "src/a.ts", startLine: 2, endLine: 2, quote: "line-2" }];
    const result = await engine.validate([finding], testAddedDiff(), [testUnit()], config);
    expect(result[0]?.status).toBe("inconclusive");
    expect(result[0]?.status).not.toBe("accepted");
    expect(result[0]?.checks.some((check) => check.name === "introduced_by_pr" && !check.passed)).toBe(true);
    expect(result[0]?.derivedAttribution).toEqual({ introducedByPr: false });
    expect("llmVerdict" in (result[0] ?? {})).toBe(false);
  });

  test("relocated target with context-only evidence is inconclusive", async () => {
    const engine = engineWithHeadText(headText(10));
    const config = ConfigFileSchema.parse({});
    const finding = testFinding();
    finding.line = 2;
    finding.evidence = [{ file: "src/a.ts", startLine: 2, endLine: 2, quote: "line-2" }];
    const result = await engine.validate([finding], testAddedDiff(), [testUnit()], config);
    expect(result[0]?.status).toBe("inconclusive");
    expect(result[0]?.checks.some((check) => check.name === "head_comment_target" && check.passed)).toBe(true);
    expect(result[0]?.checks.some((check) => check.name === "introduced_by_pr" && !check.passed)).toBe(true);
  });

  test("findings with failed provenance are rejected", async () => {
    const engine = createValidationEngine({ repoDir: "/repo" });
    const config = ConfigFileSchema.parse({});
    const result = await engine.validate([testFinding()], testDiff(), [], config);
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("rejected");
    expect(result[0]?.checks.some((check) => !check.passed)).toBe(true);
    expect("llmVerdict" in (result[0] ?? {})).toBe(false);
  });

  test("unproven paths never reach the snapshot reader", async () => {
    const readers: FakeValidationSnapshotReader[] = [];
    const engine = createValidationEngine({
      repoDir: "/repo",
      createReader: (input) => {
        const reader = new FakeValidationSnapshotReader({ headSha: input.headSha, mergeBase: input.mergeBase });
        readers.push(reader);
        return reader;
      },
    });
    const config = ConfigFileSchema.parse({});
    const finding = testFinding();
    finding.file = "/etc/passwd";
    const result = await engine.validate([finding], testDiff(), [testUnit()], config);
    expect(result[0]?.status).toBe("rejected");
    expect(readers).toHaveLength(1);
    expect(readers[0]?.reads).toEqual([]);
    expect(readers[0]?.cleared).toBe(1);
  });

  test("location failure rejects the finding", async () => {
    const engine = engineWithHeadText(headText(10));
    const config = ConfigFileSchema.parse({});
    const finding = testFinding();
    finding.line = 99;
    const result = await engine.validate([finding], testAddedDiff(), [testUnit()], config);
    expect(result[0]?.status).toBe("rejected");
    expect(result[0]?.checks.some((check) => check.name === "head_comment_target" && !check.passed)).toBe(true);
  });

  test("missing head snapshot is inconclusive, never accepted", async () => {
    const engine = createValidationEngine({
      repoDir: "/repo",
      createReader: (input) => {
        const reader = new FakeValidationSnapshotReader({
          headSha: input.headSha,
          mergeBase: input.mergeBase,
          script: { head: { "src/a.ts": { status: "not_found", reason: "path is not in the head snapshot" } } },
        });
        return reader;
      },
    });
    const result = await engine.validate([testFinding()], testAddedDiff(), [testUnit()], ConfigFileSchema.parse({}));
    expect(result[0]?.status).toBe("inconclusive");
  });

  test("fabricated evidence quote rejects the finding", async () => {
    const engine = engineWithHeadText(headText(10));
    const config = ConfigFileSchema.parse({});
    const finding = testFinding();
    finding.evidence = [{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "fabricated-quote" }];
    const result = await engine.validate([finding], testAddedDiff(), [testUnit()], config);
    expect(result[0]?.status).toBe("rejected");
    expect(result[0]?.checks.some((check) => check.name === "evidence_quote" && !check.passed)).toBe(true);
  });

  test("unavailable evidence snapshot is inconclusive, never accepted", async () => {
    const deletedLineFile: ChangedFile = {
      ...testAddedFile(),
      hunks: [
        ...testAddedFile().hunks,
        {
          oldStart: 5,
          oldLines: 1,
          newStart: 2,
          newLines: 0,
          lines: [{ kind: "del" as const, oldLine: 5, newLine: null, position: 5, text: "code" }],
        },
      ],
    };
    const anchorUnit: ReviewUnit = {
      ...testUnit(),
      symbol: {
        name: "render",
        kind: "function",
        startLine: 1,
        endLine: 10,
        changedLines: [1],
        deletedLines: [5],
        anchorLine: 1,
      },
    };
    const engine = createValidationEngine({
      repoDir: "/repo",
      createReader: (input) => {
        const text = headText(10);
        return new FakeValidationSnapshotReader({
          headSha: input.headSha,
          mergeBase: input.mergeBase,
          script: {
            head: { "src/a.ts": { status: "ok" as const, text, bytes: text.length } },
            base: { "src/a.ts": { status: "binary" as const, reason: "snapshot blob is binary content" } },
          },
        });
      },
    });
    const diff: DiffResult = { baseSha: BASE, headSha: HEAD, mergeBase: BASE, files: [deletedLineFile] };
    const finding = testFinding();
    finding.line = 5;
    finding.evidence = [{ file: "src/a.ts", startLine: 5, endLine: 5, quote: "old-code" }];
    const result = await engine.validate([finding], diff, [anchorUnit], ConfigFileSchema.parse({}));
    expect(result[0]?.status).toBe("inconclusive");
    expect(result[0]?.checks.some((check) => check.name === "evidence_quote" && !check.passed)).toBe(true);
  });

  test("deleted-line evidence with a valid anchor is accepted", async () => {
    const deletedLineFile: ChangedFile = {
      ...testAddedFile(),
      hunks: [
        ...testAddedFile().hunks,
        {
          oldStart: 5,
          oldLines: 1,
          newStart: 2,
          newLines: 0,
          lines: [{ kind: "del" as const, oldLine: 5, newLine: null, position: 5, text: "code" }],
        },
      ],
    };
    const anchorUnit: ReviewUnit = {
      ...testUnit(),
      symbol: {
        name: "render",
        kind: "function",
        startLine: 1,
        endLine: 10,
        changedLines: [1],
        deletedLines: [5],
        anchorLine: 1,
      },
    };
    const engine = createValidationEngine({
      repoDir: "/repo",
      createReader: (input) => {
        const head = headText(10);
        const baseLines = headText(10).split("\n");
        baseLines[4] = "old-code";
        const base = baseLines.join("\n");
        return new FakeValidationSnapshotReader({
          headSha: input.headSha,
          mergeBase: input.mergeBase,
          script: {
            head: { "src/a.ts": { status: "ok" as const, text: head, bytes: head.length } },
            base: { "src/a.ts": { status: "ok" as const, text: base, bytes: base.length } },
          },
        });
      },
    });
    const diff: DiffResult = { baseSha: BASE, headSha: HEAD, mergeBase: BASE, files: [deletedLineFile] };
    const finding = testFinding();
    finding.line = 5;
    finding.evidence = [{ file: "src/a.ts", startLine: 5, endLine: 5, quote: "old-code" }];
    const result = await engine.validate([finding], diff, [anchorUnit], ConfigFileSchema.parse({}));
    expect(result[0]?.status).toBe("accepted");
    expect(result[0]?.checks.some((check) => check.name === "introduced_by_pr" && check.passed)).toBe(true);
    expect(result[0]?.derivedAttribution).toEqual({
      introducedByPr: true,
      basis: { kind: "deleted-lines", evidenceIndex: 0, file: "src/a.ts", lines: [5] },
    });
  });

  test("deleted file has no head-side target and performs no snapshot read", async () => {
    const readers: FakeValidationSnapshotReader[] = [];
    const engine = createValidationEngine({
      repoDir: "/repo",
      createReader: (input) => {
        const reader = new FakeValidationSnapshotReader({
          headSha: input.headSha,
          mergeBase: input.mergeBase,
          script: { head: { "src/a.ts": { status: "ok", text: headText(10), bytes: headText(10).length } } },
        });
        readers.push(reader);
        return reader;
      },
    });
    const deleted: ChangedFile = { ...testChangedFile(), status: "deleted", hunks: [], commentableLines: [] };
    const diff: DiffResult = { baseSha: BASE, headSha: HEAD, mergeBase: BASE, files: [deleted] };
    const result = await engine.validate([testFinding()], diff, [testUnit()], ConfigFileSchema.parse({}));
    expect(result[0]?.status).toBe("rejected");
    expect(readers[0]?.reads).toEqual([]);
    expect(readers[0]?.cleared).toBe(1);
  });

  test("policy below threshold rejects a proven finding with a stable code", async () => {
    const engine = engineWithHeadText(headText(10));
    const config = ConfigFileSchema.parse({ review: { severity_threshold: "critical" } });
    const result = await engine.validate([testFinding()], testAddedDiff(), [testUnit()], config);
    expect(result[0]?.status).toBe("rejected");
    expect(result[0]?.checks).toHaveLength(15);
    expect(result[0]?.checks.some((check) => check.name === "severity_policy" && !check.passed)).toBe(true);
    expect(result[0]?.checks.some((check) => check.name === "introduced_by_pr" && check.passed)).toBe(true);
  });

  test("policy rejects a proven finding in a disabled category", async () => {
    const engine = engineWithHeadText(headText(10));
    const config = ConfigFileSchema.parse({ review: { categories: { bugs: false } } });
    const result = await engine.validate([testFinding()], testAddedDiff(), [testUnit()], config);
    expect(result[0]?.status).toBe("rejected");
    expect(result[0]?.checks.some((check) => check.name === "category_policy" && !check.passed)).toBe(true);
  });

  test("policy rejects a proven finding with an unknown rule id", async () => {
    const engine = engineWithHeadText(headText(10));
    const config = ConfigFileSchema.parse({});
    const finding = testFinding();
    finding.ruleId = "ghost-rule";
    const result = await engine.validate([finding], testAddedDiff(), [testUnit()], config);
    expect(result[0]?.status).toBe("rejected");
    expect(result[0]?.checks.some((check) => check.name === "rule_policy" && !check.passed)).toBe(true);
  });

  test("path override at the canonical path rejects a proven finding", async () => {
    const engine = engineWithHeadText(headText(10));
    const config = ConfigFileSchema.parse({
      path_overrides: [{ paths: ["src/**"], review: { severity_threshold: "critical" } }],
    });
    const result = await engine.validate([testFinding()], testAddedDiff(), [testUnit()], config);
    expect(result[0]?.status).toBe("rejected");
    expect(result[0]?.checks.some((check) => check.name === "severity_policy" && !check.passed)).toBe(true);
  });

  test("input findings are preserved, never mutated", async () => {
    const engine = createValidationEngine({ repoDir: "/repo" });
    const frozen: Finding = testFinding();
    Object.freeze(frozen.evidence);
    Object.freeze(frozen);
    const before = JSON.stringify(frozen);
    const result = await engine.validate([frozen], testDiff(), [], ConfigFileSchema.parse({}));
    expect(JSON.stringify(frozen)).toBe(before);
    expect(result[0]?.finding).toBe(frozen);
  });

  test("reader is bound per run to repoDir and diff SHAs, then cleared", async () => {
    const inputs: ValidationReaderInput[] = [];
    const readers: FakeValidationSnapshotReader[] = [];
    const engine = createValidationEngine({
      repoDir: "/repo",
      createReader: (input) => {
        inputs.push(input);
        const reader = new FakeValidationSnapshotReader({ headSha: input.headSha, mergeBase: input.mergeBase });
        readers.push(reader);
        return reader;
      },
    });
    await engine.validate([testFinding()], testDiff(), [], ConfigFileSchema.parse({}));
    await engine.validate([], testDiff(), [], ConfigFileSchema.parse({}));
    expect(inputs).toEqual([
      { repoDir: "/repo", headSha: HEAD, mergeBase: BASE },
      { repoDir: "/repo", headSha: HEAD, mergeBase: BASE },
    ]);
    expect(readers).toHaveLength(2);
    expect(readers[0]).not.toBe(readers[1]);
    for (const reader of readers) {
      expect(reader.cleared).toBe(1);
    }
  });

  test("reader construction failure fails the stage, never an empty success", async () => {
    const engine = createValidationEngine({
      repoDir: "/repo",
      createReader: () => {
        throw new ReviewerError({ code: "GIT_FAILED", message: "repo unreadable" });
      },
    });
    await expect(engine.validate([testFinding()], testDiff(), [], ConfigFileSchema.parse({}))).rejects.toThrow(
      ReviewerError,
    );
  });

  test("no provider or network dependency exists on the wiring path", async () => {
    const engine = createValidationEngine({ repoDir: "/repo" });
    const result = await engine.validate([testFinding()], testDiff(), [], ConfigFileSchema.parse({}));
    expect(result.every((item) => item.status !== "accepted")).toBe(true);
    expect(result.every((item) => !("llmVerdict" in item) || item.llmVerdict === undefined)).toBe(true);
  });
});
