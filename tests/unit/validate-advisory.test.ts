import { describe, expect, test } from "bun:test";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import type { ResolvedConfig } from "../../src/config/schema.ts";
import type { ChangedFile, DiffResult, Finding, ReviewUnit } from "../../src/types/index.ts";
import type { ConventionAdvisoryUnit, PendingAdvisoryCandidate } from "../../src/types/conventions.ts";
import { FakeValidationSnapshotReader } from "../../src/validate/snapshot.ts";
import { createPhase6ValidationEngine } from "../../src/validate/engine.ts";

const HEAD = "c".repeat(40);
const BASE = "d".repeat(40);

const HEAD_TEXT = "export function f(): number {\n  return 2;\n}";

function testChangedFile(): ChangedFile {
  return {
    path: "src/a.ts",
    oldPath: null,
    status: "modified",
    language: "typescript",
    hunks: [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 3,
        lines: [
          { kind: "ctx", oldLine: 1, newLine: 1, position: 0, text: "export function f(): number {" },
          { kind: "add", oldLine: null, newLine: 2, position: 1, text: "  return 2;" },
          { kind: "ctx", oldLine: 2, newLine: 3, position: 2, text: "}" },
        ],
      },
    ],
    commentableLines: [1, 2, 3],
    symbols: [{ name: "f", kind: "function", startLine: 1, endLine: 3, changedLines: [2] }],
  };
}

function testDiff(): DiffResult {
  return { baseSha: BASE, headSha: HEAD, mergeBase: BASE, files: [testChangedFile()] };
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
    diff: {
      hunks: file.hunks,
      originalHunkCount: 1,
      includedHunkCount: 1,
      omittedHunkCount: 0,
      truncated: false,
    },
    symbol: { name: "f", kind: "function", startLine: 1, endLine: 3, changedLines: [2] },
    context: [],
    rules: [],
  };
}

function advisoryUnit(id = "unit-1"): ConventionAdvisoryUnit {
  return {
    unitId: id,
    path: "src/a.ts",
    language: "typescript",
    symbol: { name: "f", kind: "function", signature: "f(): number", side: "head", startLine: 1 },
    diffHunks: [
      { baseStartLine: 1, headStartLine: 1, lines: [" export function f(): number {", "+  return 2;", " }"] },
    ],
    changedSymbolSource: HEAD_TEXT,
  };
}

function advisoryFinding(id: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id,
    fingerprint: `fp-${id}`,
    headSha: HEAD,
    origin: { pass: "convention-advisory", unitId: "unit-1" },
    title: "Default export breaks the named-export convention",
    severity: "low",
    category: "convention",
    file: "src/a.ts",
    line: 2,
    description: "The change adds a default export where the repository uses named exports.",
    confidence: 0.9,
    evidence: [{ file: "src/a.ts", startLine: 2, endLine: 2, quote: "  return 2;" }],
    introducedByPr: true,
    symbol: "f",
    ...overrides,
  };
}

function engineWithHeadText(headText: string, baseText?: string, readers: FakeValidationSnapshotReader[] = []) {
  return createPhase6ValidationEngine({
    repoDir: "/repo",
    createReader: (input) => {
      const reader = new FakeValidationSnapshotReader({
        headSha: input.headSha,
        mergeBase: input.mergeBase,
        script: {
          head: { "src/a.ts": { status: "ok" as const, text: headText, bytes: headText.length } },
          ...(baseText === undefined
            ? {}
            : { base: { "src/a.ts": { status: "ok" as const, text: baseText, bytes: baseText.length } } }),
        },
      });
      readers.push(reader);
      return reader;
    },
  });
}

function configWith(value: Record<string, unknown>): ResolvedConfig {
  return ConfigFileSchema.parse(value);
}

describe("primary validation with handoff", () => {
  test("matches validate() findings exactly and hands off retained winners", async () => {
    const readers: FakeValidationSnapshotReader[] = [];
    const engine = engineWithHeadText(HEAD_TEXT, undefined, readers);
    const diff = testDiff();
    const units = [testUnit()];
    const config = configWith({});
    const accepted = advisoryFinding("keep", {
      origin: { pass: "code-review-v1", unitId: "unit-1" },
      severity: "high",
      category: "bug",
    });
    const rejected = advisoryFinding("drop", { file: "src/other.ts" });
    const primary = await engine.validate([accepted, rejected], diff, units, config);
    const withHandoff = await engine.validatePrimaryWithHandoff([accepted, rejected], diff, units, config);
    expect(withHandoff.findings).toEqual(primary);
    expect(withHandoff.findings.filter((entry) => entry.status === "accepted")).toHaveLength(1);
    expect(withHandoff.handoff).toEqual([
      { findingId: "keep", headLocations: [{ path: "src/a.ts", startLine: 2, endLine: 2 }] },
    ]);
    expect(readers.every((reader) => reader.cleared >= 1)).toBe(true);
  });

  test("carries only head-side intervals when evidence spans both sides", async () => {
    const baseText = "export function f(): number {\n  return 1;\n}";
    const readers: FakeValidationSnapshotReader[] = [];
    const engine = engineWithHeadText(HEAD_TEXT, baseText, readers);
    const finding = advisoryFinding("both", {
      origin: { pass: "code-review-v1", unitId: "unit-1" },
      severity: "high",
      category: "bug",
      evidence: [
        { file: "src/a.ts", startLine: 2, endLine: 2, quote: "  return 2;" },
        { file: "src/a.ts", startLine: 1, endLine: 1, quote: "export function f(): number {" },
      ],
    });
    const withHandoff = await engine.validatePrimaryWithHandoff([finding], testDiff(), [testUnit()], configWith({}));
    expect(withHandoff.findings).toHaveLength(1);
    expect(withHandoff.findings[0]?.status).toBe("accepted");
    expect(withHandoff.handoff).toEqual([
      {
        findingId: "both",
        headLocations: [
          { path: "src/a.ts", startLine: 2, endLine: 2 },
          { path: "src/a.ts", startLine: 1, endLine: 1 },
        ],
      },
    ]);
  });

  test("base-only accepted findings carry an empty headLocations list", async () => {
    const headText = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join("\n");
    const baseText = "line-1\nremoved-line\nline-3";
    const changedFile: ChangedFile = {
      path: "src/a.ts",
      oldPath: null,
      status: "modified",
      language: "typescript",
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 10,
          lines: [
            { kind: "ctx", oldLine: 1, newLine: 1, position: 0, text: "line-1" },
            { kind: "del", oldLine: 2, newLine: null, position: 1, text: "removed-line" },
            { kind: "ctx", oldLine: 3, newLine: 3, position: 2, text: "line-3" },
          ],
        },
      ],
      commentableLines: [1, 2, 3],
      symbols: [
        { name: "f", kind: "function", startLine: 1, endLine: 3, changedLines: [], deletedLines: [2], anchorLine: 1 },
      ],
    };
    const diff: DiffResult = { baseSha: BASE, headSha: HEAD, mergeBase: BASE, files: [changedFile] };
    const unit: ReviewUnit = {
      id: "unit-1",
      file: {
        path: "src/a.ts",
        oldPath: null,
        status: "modified",
        language: "typescript",
        commentableLines: [1, 2, 3],
      },
      diff: {
        hunks: changedFile.hunks,
        originalHunkCount: 1,
        includedHunkCount: 1,
        omittedHunkCount: 0,
        truncated: false,
      },
      symbol: {
        name: "f",
        kind: "function",
        startLine: 1,
        endLine: 3,
        changedLines: [],
        deletedLines: [2],
        anchorLine: 1,
      },
      context: [],
      rules: [],
    };
    const readers: FakeValidationSnapshotReader[] = [];
    const engine = engineWithHeadText(headText, baseText, readers);
    const finding: Finding = {
      id: "base-only",
      fingerprint: "fp-base-only",
      headSha: HEAD,
      origin: { pass: "code-review-v1", unitId: "unit-1" },
      title: "Removed line breaks a caller",
      severity: "high",
      category: "bug",
      file: "src/a.ts",
      line: 2,
      description: "The deleted line was load-bearing.",
      confidence: 0.9,
      evidence: [{ file: "src/a.ts", startLine: 2, endLine: 2, quote: "removed-line" }],
      introducedByPr: true,
      symbol: "f",
    };
    const withHandoff = await engine.validatePrimaryWithHandoff([finding], diff, [unit], configWith({}));
    expect(withHandoff.findings).toHaveLength(1);
    expect(withHandoff.findings[0]?.status).toBe("accepted");
    expect(withHandoff.handoff).toEqual([{ findingId: "base-only", headLocations: [] }]);
  });

  test("all-rejected primaries yield an empty handoff", async () => {
    const engine = engineWithHeadText(HEAD_TEXT);
    const withHandoff = await engine.validatePrimaryWithHandoff(
      [advisoryFinding("drop", { file: "src/other.ts" })],
      testDiff(),
      [testUnit()],
      configWith({}),
    );
    expect(withHandoff.findings).toHaveLength(1);
    expect(withHandoff.handoff).toEqual([]);
  });
});

describe("advisory candidate validation", () => {
  test("accepts a convention low finding into a pending candidate", async () => {
    const readers: FakeValidationSnapshotReader[] = [];
    const engine = engineWithHeadText(HEAD_TEXT, undefined, readers);
    const candidates = await engine.validateAdvisoryCandidates(
      [advisoryFinding("cand-1")],
      testDiff(),
      [advisoryUnit()],
      configWith({}),
    );
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0] as PendingAdvisoryCandidate;
    expect(candidate.phase).toBe("pending-advisory-resolution");
    expect(candidate.findingId).toBe("cand-1");
    expect(candidate.pendingFields.finding.id).toBe("cand-1");
    expect("status" in candidate.pendingFields).toBe(false);
    expect(candidate.pendingFields.checks.length).toBeGreaterThan(0);
    expect(candidate.pendingFields.derivedTarget).toEqual({ file: "src/a.ts", line: 2, side: "RIGHT", kind: "added" });
    expect(candidate.pendingFields.derivedAttribution?.introducedByPr).toBe(true);
    expect(candidate.handoff).toEqual({
      findingId: "cand-1",
      headLocations: [{ path: "src/a.ts", startLine: 2, endLine: 2 }],
    });
    expect(readers.every((reader) => reader.cleared >= 1)).toBe(true);
  });

  test("drops below-low and non-convention findings at the advisory boundary", async () => {
    const engine = engineWithHeadText(HEAD_TEXT);
    const diff = testDiff();
    const units = [advisoryUnit()];
    const config = configWith({});
    expect(
      await engine.validateAdvisoryCandidates([advisoryFinding("m", { severity: "medium" })], diff, units, config),
    ).toEqual([]);
    expect(
      await engine.validateAdvisoryCandidates(
        [advisoryFinding("b", { severity: "high", category: "bug" })],
        diff,
        units,
        config,
      ),
    ).toEqual([]);
  });

  test("rejects any ruleId, including a real configured rule", async () => {
    const engine = engineWithHeadText(HEAD_TEXT);
    const config = configWith({ rules: [{ id: "real-rule", kind: "security", text: "Never do the thing." }] });
    const candidates = await engine.validateAdvisoryCandidates(
      [advisoryFinding("r", { ruleId: "real-rule" })],
      testDiff(),
      [advisoryUnit()],
      config,
    );
    expect(candidates).toEqual([]);
  });

  test("ignores path severity overrides but preserves confidence overrides", async () => {
    const engine = engineWithHeadText(HEAD_TEXT);
    const diff = testDiff();
    const units = [advisoryUnit()];
    const severityOverridden = configWith({
      path_overrides: [{ paths: ["src/**"], review: { severity_threshold: "critical" } }],
    });
    expect(
      await engine.validateAdvisoryCandidates([advisoryFinding("s")], diff, units, severityOverridden),
    ).toHaveLength(1);
    const confidenceOverridden = configWith({
      path_overrides: [{ paths: ["src/**"], review: { confidence_threshold: 0.99 } }],
    });
    expect(await engine.validateAdvisoryCandidates([advisoryFinding("c")], diff, units, confidenceOverridden)).toEqual(
      [],
    );
  });

  test("drops candidates with unknown units, foreign files, or foreign evidence", async () => {
    const engine = engineWithHeadText(HEAD_TEXT);
    const diff = testDiff();
    const units = [advisoryUnit()];
    const config = configWith({});
    expect(
      await engine.validateAdvisoryCandidates(
        [advisoryFinding("u", { origin: { pass: "convention-advisory", unitId: "missing" } })],
        diff,
        units,
        config,
      ),
    ).toEqual([]);
    expect(
      await engine.validateAdvisoryCandidates([advisoryFinding("f", { file: "src/other.ts" })], diff, units, config),
    ).toEqual([]);
    expect(
      await engine.validateAdvisoryCandidates(
        [advisoryFinding("e", { evidence: [{ file: "src/other.ts", startLine: 1, endLine: 1, quote: "x" }] })],
        diff,
        units,
        config,
      ),
    ).toEqual([]);
  });

  test("rejects deleted-symbol findings without an anchor instead of guessing", async () => {
    const baseText = "line-1\nremoved-line\nline-3";
    const engine = engineWithHeadText(HEAD_TEXT, baseText);
    const deletedUnit: ConventionAdvisoryUnit = {
      ...advisoryUnit(),
      symbol: { name: "f", kind: "function", signature: "f(): number", side: "base", startLine: 1 },
      diffHunks: [{ baseStartLine: 1, headStartLine: 1, lines: [" line-1", "-removed-line", " line-3"] }],
      changedSymbolSource: null,
    };
    const candidates = await engine.validateAdvisoryCandidates(
      [
        advisoryFinding("del", {
          line: 2,
          evidence: [{ file: "src/a.ts", startLine: 2, endLine: 2, quote: "removed-line" }],
        }),
      ],
      testDiff(),
      [deletedUnit],
      configWith({}),
    );
    expect(candidates).toEqual([]);
  });

  test("preserves input order across mixed outcomes", async () => {
    const engine = engineWithHeadText(HEAD_TEXT);
    const candidates = await engine.validateAdvisoryCandidates(
      [advisoryFinding("first"), advisoryFinding("bad", { file: "src/other.ts" }), advisoryFinding("third")],
      testDiff(),
      [advisoryUnit()],
      configWith({}),
    );
    expect(candidates.map((candidate) => candidate.findingId)).toEqual(["first", "third"]);
  });
});

describe("advisory finalization", () => {
  test("stamps surviving candidates as accepted without reordering", async () => {
    const engine = engineWithHeadText(HEAD_TEXT);
    const [first, second] = await engine.validateAdvisoryCandidates(
      [advisoryFinding("one"), advisoryFinding("two")],
      testDiff(),
      [advisoryUnit()],
      configWith({}),
    );
    const finalized = engine.finalizeAdvisoryCandidates([first!, second!]);
    expect(finalized.map((entry) => entry.finding.id)).toEqual(["one", "two"]);
    for (const entry of finalized) {
      expect(entry.status).toBe("accepted");
    }
    expect(finalized[0]?.derivedTarget).toEqual({ file: "src/a.ts", line: 2, side: "RIGHT", kind: "added" });
  });
});
