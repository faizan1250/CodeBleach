import { describe, expect, test } from "bun:test";
import { RunBudget } from "../../src/context/limits.ts";
import { parseSource, sliceSourceByIndex } from "../../src/context/parser.ts";

describe("parse source", () => {
  test("parses an in-memory typescript sample", async () => {
    const result = await parseSource({
      source: "export function greet(name: string): string { return `hi ${name}`; }\n",
      language: "typescript",
      filePath: "src/greet.ts",
      perFileMs: 2000,
    });
    try {
      expect(result.language).toBe("typescript");
      expect(result.cancelled).toBe(false);
      expect(result.skipReason).toBeUndefined();
      expect(result.errorCount).toBe(0);
      expect(result.missingCount).toBe(0);
      expect(result.errorRanges).toEqual([]);
      expect(result.lineCount).toBe(1);
      expect(result.filePath).toBe("src/greet.ts");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      if (result.tree === null) throw new Error("expected a tree");
      expect(result.tree.rootNode.type).toBe("program");
      expect(result.tree.rootNode.hasError).toBe(false);
    } finally {
      result.tree?.delete();
    }
  });

  test("emoji before a declaration keeps text and lines correct", async () => {
    const source = "// hello 👋 world\n// café naïve résumé\nfunction target(): number { return 1; }\n";
    const result = await parseSource({
      source,
      language: "typescript",
      filePath: "src/emoji.ts",
      perFileMs: 2000,
    });
    try {
      expect(result.cancelled).toBe(false);
      expect(result.errorCount).toBe(0);
      if (result.tree === null) throw new Error("expected a tree");
      const sexpr = result.tree.rootNode.toString();
      expect(sexpr).toContain("function_declaration");
      const cursor = result.tree.walk();
      let declaration: { startIndex: number; endIndex: number } | null = null;
      const visit = (): void => {
        do {
          const node = cursor.currentNode;
          if (node.type === "function_declaration") {
            declaration = { startIndex: node.startIndex, endIndex: node.endIndex };
          }
          if (cursor.gotoFirstChild()) {
            visit();
            cursor.gotoParent();
          }
        } while (cursor.gotoNextSibling());
      };
      visit();
      cursor.delete();
      if (declaration === null) throw new Error("function_declaration not found");
      const byHelper = sliceSourceByIndex(
        source,
        (declaration as { startIndex: number }).startIndex,
        (declaration as { endIndex: number }).endIndex,
      );
      expect(byHelper).toBe("function target(): number { return 1; }");
      let fnRow: number | null = null;
      for (let index = 0; index < result.tree.rootNode.namedChildCount; index += 1) {
        const child = result.tree.rootNode.namedChild(index);
        if (child?.type === "function_declaration") fnRow = child.startPosition.row;
      }
      expect(fnRow).toBe(2);
      expect(byHelper).toBe(
        result.tree.rootNode.namedChild(result.tree.rootNode.namedChildCount - 1)?.text ?? "",
      );
    } finally {
      result.tree?.delete();
    }
  });

  test("crlf bom and missing trailing newline are deterministic", async () => {
    const variants = [
      "function a(): void {}\nfunction b(): void {}\n",
      "function a(): void {}\r\nfunction b(): void {}\r\n",
      "﻿function a(): void {}\nfunction b(): void {}",
      "function a(): void {}\nfunction b(): void {}",
    ];
    for (const source of variants) {
      const result = await parseSource({
        source,
        language: "typescript",
        filePath: "src/eol.ts",
        perFileMs: 2000,
      });
      try {
        expect(result.cancelled).toBe(false);
        expect(result.lineCount).toBe(2);
        expect(result.errorCount).toBe(0);
        if (result.tree === null) throw new Error("expected a tree");
        expect(result.tree.rootNode.namedChildCount).toBe(2);
      } finally {
        result.tree?.delete();
      }
    }
  });

  test("syntax errors are recorded without crashing", async () => {
    const result = await parseSource({
      source: "function broken( { return ; }\nfunction fine(): void {}\n",
      language: "typescript",
      filePath: "src/broken.ts",
      perFileMs: 2000,
    });
    try {
      expect(result.cancelled).toBe(false);
      if (result.tree === null) throw new Error("expected a tree despite syntax errors");
      expect(result.tree.rootNode.hasError).toBe(true);
      expect(result.errorCount + result.missingCount).toBeGreaterThan(0);
      expect(result.errorRanges.length).toBeGreaterThan(0);
      for (const range of result.errorRanges) {
        expect(range.startLine).toBeGreaterThanOrEqual(1);
        expect(range.endLine).toBeGreaterThanOrEqual(range.startLine);
      }
    } finally {
      result.tree?.delete();
    }
  });

  test("missing node is counted separately", async () => {
    const result = await parseSource({
      source: "function incomplete( {\n",
      language: "typescript",
      filePath: "src/incomplete.ts",
      perFileMs: 2000,
    });
    try {
      expect(result.cancelled).toBe(false);
      if (result.tree === null) throw new Error("expected a tree");
      expect(result.errorCount + result.missingCount).toBeGreaterThan(0);
    } finally {
      result.tree?.delete();
    }
  });

  test("per-file timeout cancels and resets for the next parse", async () => {
    const big = "export function f0(): number { return 0; }\n".repeat(20000);
    const cancelled = await parseSource({
      source: big,
      language: "typescript",
      filePath: "src/big.ts",
      perFileMs: 1,
    });
    expect(cancelled.tree).toBeNull();
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.skipReason).toBe("per-file-timeout");

    const next = await parseSource({
      source: "function fine(): void {}\n",
      language: "typescript",
      filePath: "src/fine.ts",
      perFileMs: 2000,
    });
    try {
      expect(next.cancelled).toBe(false);
      if (next.tree === null) throw new Error("parser was not reset after cancellation");
      expect(next.tree.rootNode.hasError).toBe(false);
    } finally {
      next.tree?.delete();
    }
  });

  test("exhausted cumulative budget skips without parsing", async () => {
    const budget = new RunBudget({ maxRunMs: 120000, maxTotalParseMs: 30000 });
    const first = await parseSource({
      source: "function a(): void {}\n",
      language: "typescript",
      filePath: "src/a.ts",
      perFileMs: 2000,
      runBudget: budget,
    });
    first.tree?.delete();
    budget.recordParse(30000 - budget.consumedParseMs + 1);
    expect(budget.canStartParse(2000)).toBe(false);

    const skippedResult = await parseSource({
      source: "function b(): void {}\n",
      language: "typescript",
      filePath: "src/b.ts",
      perFileMs: 2000,
      runBudget: budget,
    });
    expect(skippedResult.tree).toBeNull();
    expect(skippedResult.cancelled).toBe(true);
    expect(skippedResult.skipReason).toBe("cumulative-budget");
  });

  test("expired run deadline skips without parsing", async () => {
    let nowMs = 0;
    const budget = new RunBudget(
      { maxRunMs: 1000, maxTotalParseMs: 30000 },
      { now: () => nowMs },
    );
    nowMs = 5000;
    const result = await parseSource({
      source: "function late(): void {}\n",
      language: "typescript",
      filePath: "src/late.ts",
      perFileMs: 2000,
      runBudget: budget,
    });
    expect(result.tree).toBeNull();
    expect(result.cancelled).toBe(true);
    expect(result.skipReason).toBe("run-deadline");
  });

  test("same-language concurrent parses stay correct", async () => {
    const budget = new RunBudget({ maxRunMs: 120000, maxTotalParseMs: 30000 });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        parseSource({
          source: `function worker${index}(): number { return ${index}; }\n`,
          language: "typescript",
          filePath: `src/worker${index}.ts`,
          perFileMs: 2000,
          runBudget: budget,
        }),
      ),
    );
    for (const [index, result] of results.entries()) {
      try {
        expect(result.cancelled).toBe(false);
        if (result.tree === null) throw new Error(`worker${index} parse returned null`);
        expect(result.tree.rootNode.text).toContain(`worker${index}`);
      } finally {
        result.tree?.delete();
      }
    }
  });

  test("index slicing clamps out-of-range offsets", () => {
    expect(sliceSourceByIndex("abc", -5, 2)).toBe("ab");
    expect(sliceSourceByIndex("abc", 1, 99)).toBe("bc");
    expect(sliceSourceByIndex("", 0, 10)).toBe("");
  });
});
