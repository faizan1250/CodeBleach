import { describe, expect, test } from "bun:test";
import type { ChangedFile, ChangedSymbol, DiffResult, Finding, ReviewUnit } from "../../src/types/index.ts";
import { validateFindingProvenance } from "../../src/validate/provenance.ts";

const HEAD = "c".repeat(40);
const BASE = "d".repeat(40);
const OTHER = "e".repeat(40);

function testSymbol(name = "render"): ChangedSymbol {
  return { name, kind: "function", startLine: 1, endLine: 50, changedLines: [10, 11] };
}

function testFile(overrides?: Partial<ChangedFile>): ChangedFile {
  return {
    path: "src/a.ts",
    oldPath: null,
    status: "modified",
    language: "typescript",
    hunks: [],
    commentableLines: [10, 11],
    symbols: [testSymbol()],
    ...overrides,
  };
}

function testDiff(files: ChangedFile[] = [testFile()]): DiffResult {
  return { baseSha: BASE, headSha: HEAD, mergeBase: BASE, files };
}

function testUnit(id = "unit-1", file: ChangedFile = testFile(), contextFiles: string[] = []): ReviewUnit {
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
    symbol: testSymbol(),
    context: contextFiles.map((path, index) => ({
      id: `ctx-${index}`,
      kind: "caller" as const,
      file: path,
      startLine: 1,
      endLine: 2,
      text: "caller",
      score: 1,
      tokens: 1,
      reason: "test",
    })),
    rules: [],
  };
}

function testFinding(overrides?: Partial<Finding>): Finding {
  return {
    id: "finding-1",
    fingerprint: "fp-1",
    headSha: HEAD,
    origin: { pass: "test", unitId: "unit-1" },
    title: "Null dereference on name",
    severity: "high",
    category: "null-handling",
    file: "src/a.ts",
    line: 10,
    description: "name may be null at runtime.",
    confidence: 0.9,
    evidence: [{ file: "src/a.ts", startLine: 10, endLine: 11, quote: "q" }],
    introducedByPr: true,
    symbol: "render",
    ...overrides,
  };
}

function failedNames(result: { checks: { name: string; outcome: string }[] }): string[] {
  return result.checks.filter((c) => c.outcome !== "passed").map((c) => c.name);
}

describe("finding provenance (P5-02)", () => {
  test("valid changed file passes with head-side canonical path", () => {
    const result = validateFindingProvenance(testFinding(), testDiff(), [testUnit()]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonicalPath).toBe("src/a.ts");
      expect(result.viaOldPath).toBe(false);
      expect(result.changedFile.path).toBe("src/a.ts");
      expect(result.unit.id).toBe("unit-1");
    }
    expect(failedNames(result)).toEqual([]);
  });

  test("mismatched head SHA fails", () => {
    const result = validateFindingProvenance(testFinding({ headSha: OTHER }), testDiff(), [testUnit()]);
    expect(result.ok).toBe(false);
    expect(failedNames(result)).toContain("finding_head_sha");
  });

  test("missing fingerprint fails", () => {
    const result = validateFindingProvenance(testFinding({ fingerprint: "" }), testDiff(), [testUnit()]);
    expect(result.ok).toBe(false);
    expect(failedNames(result)).toContain("finding_identity");
  });

  test("missing id fails", () => {
    const result = validateFindingProvenance(testFinding({ id: "" }), testDiff(), [testUnit()]);
    expect(result.ok).toBe(false);
    expect(failedNames(result)).toContain("finding_identity");
  });

  test("unknown origin unit fails and dependent checks skip", () => {
    const result = validateFindingProvenance(testFinding(), testDiff(), [testUnit("unit-9")]);
    expect(result.ok).toBe(false);
    expect(failedNames(result)).toContain("origin_unit");
    expect(result.checks).toHaveLength(7);
    for (const check of result.checks) {
      if (check.name !== "finding_identity" && check.name !== "finding_head_sha" && check.name !== "origin_unit") {
        expect(check).toMatchObject({
          outcome: "skipped",
          code: "check_skipped_prerequisite_failed",
          detail: "skipped: prerequisite check failed",
        });
      }
    }
  });

  test("non-canonical unit path still maps to the canonical diff file", () => {
    const unit = testUnit();
    unit.file.path = "./src/a.ts";
    const result = validateFindingProvenance(testFinding(), testDiff(), [unit]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.canonicalPath).toBe("src/a.ts");
  });

  test("unit with no changed file in the diff fails", () => {
    const unit = testUnit("unit-1", testFile({ path: "src/gone.ts" }));
    const result = validateFindingProvenance(testFinding(), testDiff(), [unit]);
    expect(result.ok).toBe(false);
    expect(failedNames(result)).toContain("origin_file");
  });

  test("file not in the diff fails", () => {
    const result = validateFindingProvenance(testFinding({ file: "src/elsewhere.ts" }), testDiff(), [testUnit()]);
    expect(result.ok).toBe(false);
    expect(failedNames(result)).toContain("finding_path");
  });

  test("file from another changed file fails unit ownership", () => {
    const diff = testDiff([testFile(), testFile({ path: "src/b.ts", symbols: [testSymbol("other")] })]);
    const result = validateFindingProvenance(testFinding({ file: "src/b.ts" }), diff, [testUnit()]);
    expect(result.ok).toBe(false);
    expect(failedNames(result)).toContain("finding_path");
  });

  test("rename new path resolves to itself", () => {
    const renamed = testFile({ path: "src/new.ts", oldPath: "src/old.ts", status: "renamed" });
    const result = validateFindingProvenance(
      testFinding({ file: "src/new.ts", evidence: [{ file: "src/new.ts", startLine: 10, endLine: 11, quote: "q" }] }),
      testDiff([renamed]),
      [testUnit("unit-1", renamed)],
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonicalPath).toBe("src/new.ts");
      expect(result.viaOldPath).toBe(false);
    }
  });

  test("rename old path canonicalizes to the head-side path", () => {
    const renamed = testFile({ path: "src/new.ts", oldPath: "src/old.ts", status: "renamed" });
    const result = validateFindingProvenance(
      testFinding({ file: "src/old.ts", evidence: [{ file: "src/new.ts", startLine: 10, endLine: 11, quote: "q" }] }),
      testDiff([renamed]),
      [testUnit("unit-1", renamed)],
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonicalPath).toBe("src/new.ts");
      expect(result.viaOldPath).toBe(true);
    }
  });

  test("deleted file keeps membership but has no head-side target", () => {
    const deleted = testFile({ status: "deleted" });
    const result = validateFindingProvenance(testFinding(), testDiff([deleted]), [testUnit("unit-1", deleted)]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changedFile.status).toBe("deleted");
  });

  test("absolute finding path fails", () => {
    const result = validateFindingProvenance(testFinding({ file: "/etc/passwd" }), testDiff(), [testUnit()]);
    expect(result.ok).toBe(false);
    expect(failedNames(result)).toContain("finding_path");
  });

  test("traversal finding path fails", () => {
    const result = validateFindingProvenance(testFinding({ file: "src/../secret.ts" }), testDiff(), [testUnit()]);
    expect(result.ok).toBe(false);
    expect(failedNames(result)).toContain("finding_path");
  });

  test("NUL byte finding path fails", () => {
    const result = validateFindingProvenance(testFinding({ file: "src/a.ts\u0000" }), testDiff(), [testUnit()]);
    expect(result.ok).toBe(false);
    expect(failedNames(result)).toContain("finding_path");
  });

  test("control character finding path fails", () => {
    const result = validateFindingProvenance(testFinding({ file: "src/a\u0001.ts" }), testDiff(), [testUnit()]);
    expect(result.ok).toBe(false);
    expect(failedNames(result)).toContain("finding_path");
  });

  test("path case must match exactly", () => {
    const result = validateFindingProvenance(testFinding({ file: "SRC/A.TS" }), testDiff(), [testUnit()]);
    expect(result.ok).toBe(false);
    expect(failedNames(result)).toContain("finding_path");
  });

  test("symbol mismatch fails", () => {
    const result = validateFindingProvenance(testFinding({ symbol: "unrelated" }), testDiff(), [testUnit()]);
    expect(result.ok).toBe(false);
    expect(failedNames(result)).toContain("finding_symbol");
  });

  test("absent symbol passes", () => {
    const finding = testFinding();
    delete finding.symbol;
    const result = validateFindingProvenance(finding, testDiff(), [testUnit()]);
    expect(result.ok).toBe(true);
  });

  test("evidence from an allowed context file passes", () => {
    const finding = testFinding({
      evidence: [{ file: "src/caller.ts", startLine: 1, endLine: 2, quote: "q" }],
    });
    const result = validateFindingProvenance(finding, testDiff(), [testUnit("unit-1", testFile(), ["src/caller.ts"])]);
    expect(result.ok).toBe(true);
  });

  test("evidence from an unprovided repository file fails", () => {
    const finding = testFinding({
      evidence: [{ file: "src/unprovided.ts", startLine: 1, endLine: 1, quote: "q" }],
    });
    const result = validateFindingProvenance(finding, testDiff(), [testUnit()]);
    expect(result.ok).toBe(false);
    expect(failedNames(result)).toContain("evidence_provenance");
  });

  test("evidence with an unsafe path fails", () => {
    const finding = testFinding({
      evidence: [{ file: "/etc/passwd", startLine: 1, endLine: 1, quote: "q" }],
    });
    const result = validateFindingProvenance(finding, testDiff(), [testUnit()]);
    expect(result.ok).toBe(false);
    expect(failedNames(result)).toContain("evidence_provenance");
  });

  test("evidence against a rename old path is allowed", () => {
    const renamed = testFile({ path: "src/new.ts", oldPath: "src/old.ts", status: "renamed" });
    const finding = testFinding({
      file: "src/new.ts",
      evidence: [{ file: "src/old.ts", startLine: 1, endLine: 2, quote: "q" }],
    });
    const result = validateFindingProvenance(finding, testDiff([renamed]), [testUnit("unit-1", renamed)]);
    expect(result.ok).toBe(true);
  });

  test("empty evidence fails", () => {
    const result = validateFindingProvenance(testFinding({ evidence: [] }), testDiff(), [testUnit()]);
    expect(result.ok).toBe(false);
    expect(failedNames(result)).toContain("evidence_provenance");
  });

  test("fingerprint is preserved, never recomputed", () => {
    const finding = testFinding({ fingerprint: "fp-original" });
    const result = validateFindingProvenance(finding, testDiff(), [testUnit()]);
    expect(result.ok).toBe(true);
    expect(finding.fingerprint).toBe("fp-original");
  });
});
