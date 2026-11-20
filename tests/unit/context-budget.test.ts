import { describe, expect, test } from "bun:test";
import { estimateTokens } from "../../src/utils/tokens.ts";
import {
  FRAMING_RESERVE_TOKENS,
  fitUnitToBudget,
  selectHunks,
  serializeHunk,
  tokensForDiffIdentity,
  tokensForRule,
  tokensForSymbolIdentity,
  truncateDefinition,
  type FitUnitInput,
} from "../../src/context/budget.ts";
import type { DiffHunk } from "../../src/types/diff.ts";
import type { Rule } from "../../src/types/rules.ts";

function hunk(newStart: number, texts: string[]): DiffHunk {
  return {
    oldStart: newStart,
    oldLines: texts.length,
    newStart,
    newLines: texts.length,
    lines: texts.map((text, index) => ({
      kind: "add" as const,
      oldLine: null,
      newLine: newStart + index,
      position: index + 1,
      text,
    })),
  };
}

function rule(id: string, text = `rule ${id}`): Rule {
  return { id, kind: "convention", text };
}

describe("token estimator", () => {
  test("empty text costs zero; estimates are stable and non-negative", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello")).toBeGreaterThan(0);
    expect(estimateTokens("hello")).toBe(estimateTokens("hello"));
    expect(estimateTokens("a".repeat(100))).toBeGreaterThanOrEqual(estimateTokens("a".repeat(10)));
  });

  test("unicode text stays valid and counted", () => {
    const text = "emoji 🎉 accent café\nsecond line";
    expect(estimateTokens(text)).toBeGreaterThan(0);
    expect(estimateTokens(text)).toBe(estimateTokens(text));
  });
});

describe("hunk selection", () => {
  test("includes whole hunks in order while they fit", () => {
    const hunks = [hunk(1, ["a"]), hunk(10, ["b"]), hunk(20, ["c"])];
    const sizes = hunks.map((h) => estimateTokens(serializeHunk(h)));
    const budget = sizes[0]! + sizes[1]!;
    const selected = selectHunks(hunks, budget);
    expect(selected.included).toHaveLength(2);
    expect(selected.omittedHunkCount).toBe(1);
    expect(selected.truncated).toBe(true);
  });

  test("never splits a hunk", () => {
    const hunks = [hunk(1, ["a".repeat(500)])];
    const selected = selectHunks(hunks, 1);
    expect(selected.included).toHaveLength(0);
    expect(selected.truncated).toBe(false);
  });
});

describe("definition truncation", () => {
  test("preserves signature and truncates body at line boundaries", () => {
    const signature = "function greet(): string {";
    const body = ["  const a = 1;", "  const b = 2;", "  return 'hi';", "}"].join("\n");
    const sigTokens = estimateTokens(signature);
    const oneLine = estimateTokens(`\n${"  const a = 1;"}`);
    const result = truncateDefinition(signature, body, sigTokens + oneLine);
    expect(result.text.startsWith(signature)).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("const a = 1;");
    expect(result.text).not.toContain("return 'hi';");
  });

  test("full body fits without truncation flag", () => {
    const signature = "function f() {";
    const body = "  return 1;\n}";
    const result = truncateDefinition(signature, body, 100000);
    expect(result.truncated).toBe(false);
    expect(result.text).toContain("return 1;");
  });
});

describe("unit budget", () => {
  function input(overrides: Partial<FitUnitInput> = {}): FitUnitInput {
    return {
      path: "src/a.ts",
      symbol: "greet",
      hunks: [hunk(1, ["+line"])],
      definitionSignature: "function greet() {",
      definitionBody: "  return 1;\n}",
      rules: [],
      candidates: [],
      maxTokens: 12000,
      ...overrides,
    };
  }

  test("counts rules, diff, definition, items, and framing reserve", () => {
    const rules = [rule("r1", "do not do things")];
    const outcome = fitUnitToBudget(input({ rules }));
    expect(outcome.status).toBe("emit");
    if (outcome.status !== "emit") return;
    const expectedMin = FRAMING_RESERVE_TOKENS + tokensForRule(rules[0]!) + estimateTokens("function greet() {");
    expect(outcome.totalTokens).toBeGreaterThanOrEqual(expectedMin);
    expect(outcome.totalTokens).toBeLessThanOrEqual(12000);
  });

  test("keeps rules verbatim", () => {
    const rules = [rule("arch-001", "Controllers must not contain business logic.")];
    const outcome = fitUnitToBudget(input({ rules }));
    expect(outcome.status).toBe("emit");
    if (outcome.status !== "emit") return;
    expect(outcome.keptRules).toEqual(rules);
  });

  test("rule-heavy unit skips with mandatory-budget-exceeded", () => {
    const rules = [rule("big", "x".repeat(20000))];
    const outcome = fitUnitToBudget(input({ rules, maxTokens: 1000 }));
    expect(outcome.status).toBe("skip");
    if (outcome.status !== "skip") return;
    expect(outcome.reason).toBe("mandatory-budget-exceeded");
  });

  test("no fitting hunk skips with diff-exceeds-budget", () => {
    const outcome = fitUnitToBudget(input({ hunks: [hunk(1, ["z".repeat(20000)])], maxTokens: 1000 }));
    expect(outcome.status).toBe("skip");
    if (outcome.status !== "skip") return;
    expect(outcome.reason).toBe("diff-exceeds-budget");
  });

  test("trailing hunks truncate with omitted count", () => {
    const hunks = [hunk(1, ["a"]), hunk(50, ["b".repeat(5000)])];
    const firstSize = estimateTokens(serializeHunk(hunks[0]!));
    const sigSize = estimateTokens("function greet() {");
    const outcome = fitUnitToBudget(input({ hunks, maxTokens: FRAMING_RESERVE_TOKENS + sigSize + firstSize + 50 }));
    expect(outcome.status).toBe("emit");
    if (outcome.status !== "emit") return;
    expect(outcome.diffTruncated).toBe(true);
    expect(outcome.omittedHunkCount).toBe(1);
    expect(outcome.includedHunks).toHaveLength(1);
  });

  test("lower-ranked items omitted first and cap never exceeded", () => {
    const candidates = [
      {
        id: "low",
        kind: "test" as const,
        file: "src/a.test.ts",
        startLine: 1,
        endLine: 50,
        text: "t".repeat(5000),
        score: 1,
        tokens: estimateTokens("t".repeat(5000)),
        reason: "test",
      },
      {
        id: "high",
        kind: "callee" as const,
        file: "src/a.ts",
        startLine: 2,
        endLine: 3,
        text: "small",
        score: 99,
        tokens: estimateTokens("small"),
        reason: "callee",
      },
    ];
    const sorted = [...candidates].sort((a, b) => b.score - a.score);
    const hunks = [hunk(1, ["a"])];
    const hunkSize = estimateTokens(serializeHunk(hunks[0]!));
    const sigSize = estimateTokens("function greet() {");
    const bodySize = estimateTokens("  return 1;\n}");
    const highSize = estimateTokens("small");
    const identitySize = tokensForDiffIdentity("src/a.ts", 1) + tokensForSymbolIdentity("src/a.ts", "greet");
    const outcome = fitUnitToBudget(
      input({
        hunks,
        candidates: sorted,
        maxTokens: FRAMING_RESERVE_TOKENS + identitySize + sigSize + bodySize + hunkSize + highSize + 2,
      }),
    );
    expect(outcome.status).toBe("emit");
    if (outcome.status !== "emit") return;
    expect(outcome.includedItems.map((i) => i.id)).toEqual(["high"]);
    expect(outcome.omittedItemCount).toBe(1);
    expect(outcome.totalTokens).toBeLessThanOrEqual(
      FRAMING_RESERVE_TOKENS + identitySize + sigSize + bodySize + hunkSize + highSize + 2,
    );
  });
});
