import { describe, expect, test } from "bun:test";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import { ReviewerError } from "../../src/core/errors.ts";
import type { DiffResult, Finding } from "../../src/types/index.ts";
import { FakeValidationSnapshotReader } from "../../src/validate/snapshot.ts";
import { createValidationEngine } from "../../src/validate/engine.ts";
import type { ValidationReaderInput } from "../../src/validate/engine.ts";

const HEAD = "c".repeat(40);
const BASE = "d".repeat(40);

function testDiff(): DiffResult {
  return { baseSha: BASE, headSha: HEAD, mergeBase: BASE, files: [] };
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
    evidence: [{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "q" }],
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

describe("validation engine wiring (P5-01)", () => {
  test("empty findings validate to an empty result", async () => {
    const engine = createValidationEngine({ repoDir: "/repo" });
    const result = await engine.validate([], testDiff(), [], ConfigFileSchema.parse({}));
    expect(result).toEqual([]);
  });

  test("findings are inconclusive and never accepted before P5-02 checks exist", async () => {
    const engine = createValidationEngine({ repoDir: "/repo" });
    const config = ConfigFileSchema.parse({});
    const result = await engine.validate([testFinding("a"), testFinding("b")], testDiff(), [], config);
    expect(result).toHaveLength(2);
    for (const item of result) {
      expect(item.status).toBe("inconclusive");
      expect(item.status).not.toBe("accepted");
      expect(item.checks).toHaveLength(1);
      expect(item.checks[0]?.passed).toBe(false);
      expect("llmVerdict" in item).toBe(false);
    }
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
