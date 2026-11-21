import { describe, expect, test } from "bun:test";
import type { Finding } from "../../src/types/index.ts";
import type { ResolvedTarget } from "../../src/validate/location.ts";
import {
  type DedupeInput,
  normalizeDedupeTitle,
  resolveDuplicates,
  selectWithinCap,
} from "../../src/validate/dedupe.ts";

function finding(id: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id,
    fingerprint: `fp-${id}`,
    headSha: "c".repeat(40),
    origin: { pass: "test", unitId: "unit-1" },
    title: "Null dereference on name",
    severity: "high",
    category: "null-handling",
    file: "src/a.ts",
    line: 10,
    description: "name may be null at runtime.",
    confidence: 0.9,
    evidence: [{ file: "src/a.ts", startLine: 10, endLine: 12, quote: "q" }],
    introducedByPr: true,
    ...overrides,
  };
}

function target(line: number, file = "src/a.ts"): ResolvedTarget {
  return { file, line, side: "RIGHT", kind: "added" };
}

function retainedId(verdicts: { retained: boolean }[], inputs: DedupeInput[]): string | undefined {
  return inputs[verdicts.findIndex((verdict) => verdict.retained)]?.finding.id;
}

function input(id: string, overrides: Partial<Finding> = {}, line = 10): DedupeInput {
  const found = finding(id, overrides);
  return {
    finding: found,
    canonicalPath: "src/a.ts",
    symbol: "render",
    effectiveSeverity: found.severity,
    target: target(line),
  };
}

describe("dedupe title normalization", () => {
  test("folds case and collapses whitespace", () => {
    expect(normalizeDedupeTitle("Null  Dereference\nON   name")).toBe("null dereference on name");
  });

  test("leaves punctuation intact", () => {
    expect(normalizeDedupeTitle("null-dereference!")).not.toBe(normalizeDedupeTitle("null dereference"));
  });
});

describe("primary fingerprint duplicates", () => {
  test("same stored fingerprint merges regardless of title", () => {
    const a = input("a", { fingerprint: "same-fp", title: "First title" }, 10);
    const b = input("b", { fingerprint: "same-fp", title: "Second title" }, 40);
    const verdicts = resolveDuplicates([a, b]);
    const retained = verdicts.filter((verdict) => verdict.retained);
    expect(retained).toHaveLength(1);
    expect(verdicts.find((verdict) => !verdict.retained)?.checks).toContainEqual(
      expect.objectContaining({ name: "dedupe_fingerprint", outcome: "failed", code: "duplicate_fingerprint" }),
    );
  });

  test("winner is independent of input order", () => {
    const lo = input("lo", { fingerprint: "same-fp", severity: "low", confidence: 0.5 });
    const hi = input("hi", { fingerprint: "same-fp", severity: "critical", confidence: 0.99 });
    const forward = resolveDuplicates([lo, hi]);
    const backward = resolveDuplicates([hi, lo]);
    expect(retainedId(forward, [lo, hi])).toBe("hi");
    expect(retainedId(backward, [hi, lo])).toBe("hi");
  });

  test("stored value decides, never a recomputed fingerprint", () => {
    const a = input("a", { fingerprint: "fp-one", title: "Title one" }, 10);
    const b = input("b", { fingerprint: "fp-two", title: "Title two" }, 30);
    const verdicts = resolveDuplicates([a, b]);
    expect(verdicts.every((verdict) => verdict.retained)).toBe(true);
  });
});

describe("secondary conservative duplicates", () => {
  test("same path, symbol, category, title, and overlapping ranges merge", () => {
    const a = input("a", { title: "Same  Title" });
    const b = input("b", { title: "same title" }, 11);
    const verdicts = resolveDuplicates([a, b]);
    expect(verdicts.filter((verdict) => verdict.retained)).toHaveLength(1);
    expect(verdicts.find((verdict) => !verdict.retained)?.checks).toContainEqual(
      expect.objectContaining({ name: "dedupe_secondary", outcome: "failed", code: "duplicate_secondary_key" }),
    );
  });

  test("distinct titles remain separate", () => {
    const verdicts = resolveDuplicates([input("a", { title: "Alpha" }), input("b", { title: "Beta" })]);
    expect(verdicts.every((verdict) => verdict.retained)).toBe(true);
  });

  test("disjoint targets and evidence remain separate", () => {
    const a = input("a");
    const far = finding("b");
    far.evidence = [{ file: "src/a.ts", startLine: 90, endLine: 92, quote: "far" }];
    const b: DedupeInput = {
      finding: far,
      canonicalPath: "src/a.ts",
      symbol: "render",
      effectiveSeverity: far.severity,
      target: target(91),
    };
    const verdicts = resolveDuplicates([a, b]);
    expect(verdicts.every((verdict) => verdict.retained)).toBe(true);
  });

  test("same title on a different file remains separate", () => {
    const a = input("a");
    const other = finding("b", { file: "src/b.ts" });
    const b: DedupeInput = {
      finding: other,
      canonicalPath: "src/b.ts",
      symbol: "render",
      effectiveSeverity: other.severity,
      target: target(10, "src/b.ts"),
    };
    expect(resolveDuplicates([a, b]).every((verdict) => verdict.retained)).toBe(true);
  });

  test("same title under a different symbol remains separate", () => {
    const a = input("a");
    const b = input("b");
    b.symbol = "other";
    expect(resolveDuplicates([a, b]).every((verdict) => verdict.retained)).toBe(true);
  });

  test("same title under a different category remains separate", () => {
    const a = input("a");
    const b = input("b", { category: "security" });
    expect(resolveDuplicates([a, b]).every((verdict) => verdict.retained)).toBe(true);
  });

  test("rule severity decides before model severity", () => {
    const a = input("a", { severity: "low" });
    const b = input("b", { severity: "low" });
    a.effectiveSeverity = "critical";
    const verdicts = resolveDuplicates([a, b]);
    expect(retainedId(verdicts, [a, b])).toBe("a");
  });
});

describe("deterministic winner ordering", () => {
  test("higher confidence wins on tied severity", () => {
    const a = input("a", { confidence: 0.5 });
    const b = input("b", { confidence: 0.9 });
    const verdicts = resolveDuplicates([a, b]);
    expect(retainedId(verdicts, [a, b])).toBe("b");
  });

  test("lower target line wins a shared fingerprint", () => {
    const a = input("a", { fingerprint: "same-fp" }, 30);
    const b = input("b", { fingerprint: "same-fp" }, 10);
    const verdicts = resolveDuplicates([a, b]);
    expect(retainedId(verdicts, [a, b])).toBe("b");
  });
});

describe("max findings cap", () => {
  test("keeps the top candidate by winner order", () => {
    const kept = selectWithinCap([input("a", { severity: "low" }), input("b", { severity: "critical" })], 1).map(
      (verdict) => verdict.kept,
    );
    expect(kept).toEqual([false, true]);
  });

  test("earlier path wins on tied severity and confidence", () => {
    const a = input("a");
    const other = finding("b", { file: "src/z.ts", title: "Other title" });
    const b: DedupeInput = {
      finding: other,
      canonicalPath: "src/z.ts",
      symbol: "render",
      effectiveSeverity: other.severity,
      target: target(10, "src/z.ts"),
    };
    const kept = selectWithinCap([b, a], 1).map((verdict) => verdict.kept);
    expect(kept).toEqual([false, true]);
  });

  test("lower target line wins on tied severity, confidence, and path", () => {
    const kept = selectWithinCap([input("a", {}, 30), input("b", {}, 10)], 1).map((verdict) => verdict.kept);
    expect(kept).toEqual([false, true]);
  });

  test("smaller fingerprint wins the final severity tiebreak", () => {
    const kept = selectWithinCap([input("a", { fingerprint: "fp-zzz" }), input("b", { fingerprint: "fp-aaa" })], 1).map(
      (verdict) => verdict.kept,
    );
    expect(kept).toEqual([false, true]);
  });

  test("cap larger than the set keeps everything", () => {
    const kept = selectWithinCap([input("a"), input("b")], 10).map((verdict) => verdict.kept);
    expect(kept).toEqual([true, true]);
  });
});
