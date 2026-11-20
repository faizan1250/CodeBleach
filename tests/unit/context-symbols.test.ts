import { describe, expect, test } from "bun:test";
import { getAdapter } from "../../src/context/language.ts";
import type { Definition } from "../../src/context/language.ts";
import { parseSource } from "../../src/context/parser.ts";
import type { SupportedLanguage } from "../../src/context/runtime.ts";
import { mapFileSymbols } from "../../src/context/symbols.ts";
import type { ChangedFile } from "../../src/types/diff.ts";

async function definitionsFor(source: string, language: SupportedLanguage = "typescript"): Promise<Definition[]> {
  const result = await parseSource({ source, language, filePath: "src/unit.ts", perFileMs: 5000 });
  try {
    if (result.tree === null) throw new Error("expected a tree");
    return getAdapter(language).extractDefinitions(result.tree, result.source);
  } finally {
    result.tree?.delete();
  }
}

function fileWith(hunks: ChangedFile["hunks"], commentableLines: number[], path = "src/unit.ts"): ChangedFile {
  return {
    path,
    oldPath: null,
    status: "modified",
    language: "typescript",
    hunks,
    commentableLines,
    symbols: [],
  };
}

describe("mapFileSymbols additions", () => {
  test("addition inside function maps to that function", async () => {
    const head = "export function f(): number {\n  return 1;\n}\n";
    const defs = await definitionsFor(head);
    const file = fileWith(
      [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [
            { kind: "ctx", oldLine: 1, newLine: 1, position: 1, text: "export function f(): number {" },
            { kind: "add", oldLine: null, newLine: 2, position: 2, text: "  return 1;" },
            { kind: "ctx", oldLine: 3, newLine: 3, position: 3, text: "}" },
          ],
        },
      ],
      [2],
    );
    const symbols = mapFileSymbols({ file, headDefinitions: defs, headLineCount: 3, baseDefinitions: [] });
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: "f", kind: "function", changedLines: [2] });
  });

  test("addition inside method maps to method with class container", async () => {
    const head = "class C {\n  m(): void {\n    work();\n  }\n}\n";
    const defs = await definitionsFor(head);
    const file = fileWith(
      [
        {
          oldStart: 1,
          oldLines: 5,
          newStart: 1,
          newLines: 5,
          lines: [
            { kind: "ctx", oldLine: 2, newLine: 2, position: 1, text: "  m(): void {" },
            { kind: "add", oldLine: null, newLine: 3, position: 2, text: "    work();" },
            { kind: "ctx", oldLine: 4, newLine: 4, position: 3, text: "  }" },
          ],
        },
      ],
      [3],
    );
    const symbols = mapFileSymbols({ file, headDefinitions: defs, headLineCount: 5, baseDefinitions: [] });
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: "m", kind: "method", container: "C", changedLines: [3] });
  });

  test("module-level addition maps to module symbol", async () => {
    const head = "// leading\nconst x = 1;\n";
    const defs = await definitionsFor(head);
    expect(defs).toHaveLength(0);
    const file = fileWith(
      [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          lines: [
            { kind: "ctx", oldLine: 1, newLine: 1, position: 1, text: "// leading" },
            { kind: "add", oldLine: null, newLine: 2, position: 2, text: "const x = 1;" },
          ],
        },
      ],
      [2],
    );
    const symbols = mapFileSymbols({ file, headDefinitions: defs, headLineCount: 2, baseDefinitions: [] });
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: "<module>", kind: "module", changedLines: [2] });
  });

  test("type change maps to type symbol", async () => {
    const head = "export interface User {\n  id: string;\n}\n";
    const defs = await definitionsFor(head);
    const file = fileWith(
      [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [
            { kind: "ctx", oldLine: 1, newLine: 1, position: 1, text: "export interface User {" },
            { kind: "add", oldLine: null, newLine: 2, position: 2, text: "  id: string;" },
            { kind: "ctx", oldLine: 3, newLine: 3, position: 3, text: "}" },
          ],
        },
      ],
      [2],
    );
    const symbols = mapFileSymbols({ file, headDefinitions: defs, headLineCount: 3, baseDefinitions: [] });
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: "User", kind: "type", changedLines: [2] });
  });

  test("comment-only line creates no declaration symbol", async () => {
    const head = "// function fake(): void {}\nfunction real(): void {}\n";
    const defs = await definitionsFor(head);
    expect(defs.map((d) => d.name)).toEqual(["real"]);
    const file = fileWith(
      [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          lines: [
            { kind: "add", oldLine: null, newLine: 1, position: 1, text: "// function fake(): void {}" },
            { kind: "ctx", oldLine: 1, newLine: 2, position: 2, text: "function real(): void {}" },
          ],
        },
      ],
      [1],
    );
    const symbols = mapFileSymbols({ file, headDefinitions: defs, headLineCount: 2, baseDefinitions: [] });
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: "<module>", kind: "module", changedLines: [1] });
  });

  test("changes across multiple methods create distinct units", async () => {
    const head = "class C {\n  a(): void {\n    one();\n  }\n  b(): void {\n    two();\n  }\n}\n";
    const defs = await definitionsFor(head);
    const file = fileWith(
      [
        {
          oldStart: 1,
          oldLines: 7,
          newStart: 1,
          newLines: 7,
          lines: [
            { kind: "ctx", oldLine: 2, newLine: 2, position: 1, text: "  a(): void {" },
            { kind: "add", oldLine: null, newLine: 3, position: 2, text: "    one();" },
            { kind: "ctx", oldLine: 4, newLine: 4, position: 3, text: "  }" },
            { kind: "ctx", oldLine: 5, newLine: 5, position: 4, text: "  b(): void {" },
            { kind: "add", oldLine: null, newLine: 6, position: 5, text: "    two();" },
            { kind: "ctx", oldLine: 7, newLine: 7, position: 6, text: "}" },
          ],
        },
      ],
      [3, 6],
    );
    const symbols = mapFileSymbols({ file, headDefinitions: defs, headLineCount: 7, baseDefinitions: [] });
    expect(symbols.map((s) => [s.name, s.container, s.changedLines])).toEqual([
      ["a", "C", [3]],
      ["b", "C", [6]],
    ]);
  });

  test("multiple hunks in one function merge into one symbol", async () => {
    const head = "function f(): void {\n  a();\n  b();\n  c();\n}\n";
    const defs = await definitionsFor(head);
    const file = fileWith(
      [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          lines: [
            { kind: "ctx", oldLine: 1, newLine: 1, position: 1, text: "function f(): void {" },
            { kind: "add", oldLine: null, newLine: 2, position: 2, text: "  a();" },
          ],
        },
        {
          oldStart: 4,
          oldLines: 2,
          newStart: 5,
          newLines: 3,
          lines: [
            { kind: "ctx", oldLine: 4, newLine: 5, position: 3, text: "  c();" },
            { kind: "add", oldLine: null, newLine: 3, position: 4, text: "  b();" },
          ],
        },
      ],
      [2, 3],
    );
    const symbols = mapFileSymbols({ file, headDefinitions: defs, headLineCount: 5, baseDefinitions: [] });
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: "f", changedLines: [2, 3] });
  });

  test("replacement records added and deleted line arrays", async () => {
    const head = "export function f(x: number): number {\n  return x + 1;\n}\n";
    const base = "export function f(x: number): number {\n  return x;\n}\n";
    const headDefs = await definitionsFor(head);
    const baseDefs = await definitionsFor(base);
    const file = fileWith(
      [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [
            { kind: "ctx", oldLine: 1, newLine: 1, position: 1, text: "export function f(x: number): number {" },
            { kind: "del", oldLine: 2, newLine: null, position: 2, text: "  return x;" },
            { kind: "add", oldLine: null, newLine: 2, position: 3, text: "  return x + 1;" },
            { kind: "ctx", oldLine: 3, newLine: 3, position: 4, text: "}" },
          ],
        },
      ],
      [2, 3],
    );
    const symbols = mapFileSymbols({ file, headDefinitions: headDefs, headLineCount: 3, baseDefinitions: baseDefs });
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: "f", changedLines: [2], deletedLines: [2] });
    expect(symbols[0]?.anchorLine).toBeUndefined();
  });

  test("deletion-only change maps to surviving function with anchor", async () => {
    const head = "export function f(x?: string) {\n  return x.length;\n}\n";
    const base = "export function f(x?: string) {\n  if (!x) return 0;\n  return x.length;\n}\n";
    const headDefs = await definitionsFor(head);
    const baseDefs = await definitionsFor(base);
    const file = fileWith(
      [
        {
          oldStart: 1,
          oldLines: 4,
          newStart: 1,
          newLines: 3,
          lines: [
            { kind: "ctx", oldLine: 1, newLine: 1, position: 1, text: "export function f(x?: string) {" },
            { kind: "del", oldLine: 2, newLine: null, position: 2, text: "  if (!x) return 0;" },
            { kind: "ctx", oldLine: 3, newLine: 2, position: 3, text: "  return x.length;" },
            { kind: "ctx", oldLine: 4, newLine: 3, position: 4, text: "}" },
          ],
        },
      ],
      [1, 2, 3],
      "src/f.ts",
    );
    const symbols = mapFileSymbols({ file, headDefinitions: headDefs, headLineCount: 3, baseDefinitions: baseDefs });
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: "f", kind: "function", changedLines: [], deletedLines: [2] });
    expect(symbols[0]?.anchorLine).toBe(2);
  });

  test("fully deleted function falls back to module with anchor", async () => {
    const head = "export function keep(): void {}\n";
    const base = "export function keep(): void {}\nexport function gone(): void {\n  work();\n}\n";
    const headDefs = await definitionsFor(head);
    const baseDefs = await definitionsFor(base);
    const file = fileWith(
      [
        {
          oldStart: 1,
          oldLines: 4,
          newStart: 1,
          newLines: 1,
          lines: [
            { kind: "ctx", oldLine: 1, newLine: 1, position: 1, text: "export function keep(): void {}" },
            { kind: "del", oldLine: 2, newLine: null, position: 2, text: "export function gone(): void {" },
            { kind: "del", oldLine: 3, newLine: null, position: 3, text: "  work();" },
            { kind: "del", oldLine: 4, newLine: null, position: 4, text: "}" },
          ],
        },
      ],
      [1],
      "src/gone.ts",
    );
    const symbols = mapFileSymbols({ file, headDefinitions: headDefs, headLineCount: 1, baseDefinitions: baseDefs });
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: "<module>", kind: "module", changedLines: [], deletedLines: [2, 3, 4] });
    expect(symbols[0]?.anchorLine).toBe(1);
  });

  test("deletion with no surviving anchor leaves anchorLine undefined", async () => {
    const head = "";
    const base = "export function gone(): void {\n  work();\n}\n";
    const headDefs = await definitionsFor(head);
    const baseDefs = await definitionsFor(base);
    const file = fileWith(
      [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 0,
          newLines: 0,
          lines: [
            { kind: "del", oldLine: 1, newLine: null, position: 1, text: "export function gone(): void {" },
            { kind: "del", oldLine: 2, newLine: null, position: 2, text: "  work();" },
            { kind: "del", oldLine: 3, newLine: null, position: 3, text: "}" },
          ],
        },
      ],
      [],
      "src/emptied.ts",
    );
    const symbols = mapFileSymbols({ file, headDefinitions: headDefs, headLineCount: 0, baseDefinitions: baseDefs });
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: "<module>", kind: "module", deletedLines: [1, 2, 3] });
    expect(symbols[0]?.anchorLine).toBeUndefined();
  });

  test("anchor tie prefers the following line", async () => {
    const head = "export function f(x?: string) {\n  return x.length;\n}\n";
    const base = "export function f(x?: string) {\n  if (!x) return 0;\n  return x.length;\n}\n";
    const headDefs = await definitionsFor(head);
    const baseDefs = await definitionsFor(base);
    const file = fileWith(
      [
        {
          oldStart: 1,
          oldLines: 4,
          newStart: 1,
          newLines: 3,
          lines: [
            { kind: "ctx", oldLine: 1, newLine: 1, position: 1, text: "export function f(x?: string) {" },
            { kind: "del", oldLine: 2, newLine: null, position: 2, text: "  if (!x) return 0;" },
            { kind: "ctx", oldLine: 3, newLine: 2, position: 3, text: "  return x.length;" },
            { kind: "ctx", oldLine: 4, newLine: 3, position: 4, text: "}" },
          ],
        },
      ],
      [1, 2, 3],
      "src/f.ts",
    );
    const symbols = mapFileSymbols({ file, headDefinitions: headDefs, headLineCount: 3, baseDefinitions: baseDefs });
    expect(symbols[0]?.anchorLine).toBe(2);
  });

  test("changed line inside an error region falls back to module", async () => {
    const head = "export function f(): number {\n  return 1;\n}\n";
    const defs = await definitionsFor(head);
    const file = fileWith(
      [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [
            { kind: "ctx", oldLine: 1, newLine: 1, position: 1, text: "export function f(): number {" },
            { kind: "add", oldLine: null, newLine: 2, position: 2, text: "  return 1;" },
            { kind: "ctx", oldLine: 3, newLine: 3, position: 3, text: "}" },
          ],
        },
      ],
      [2],
    );
    const symbols = mapFileSymbols({
      file,
      headDefinitions: defs,
      headLineCount: 3,
      baseDefinitions: [],
      headErrorRanges: [{ startLine: 2, endLine: 2 }],
    });
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: "<module>", kind: "module", changedLines: [2] });
  });

  test("overloaded repeats keep stable occurrence mapping", async () => {
    const head = "function dup(): void {\n  one();\n}\nfunction dup(): void {\n  two();\n}\n";
    const base = "function dup(): void {\n  one();\n}\nfunction dup(): void {\n  two();\n}\n";
    const headDefs = await definitionsFor(head);
    const baseDefs = await definitionsFor(base);
    expect(headDefs.map((d) => d.identityKey)).toEqual(["function::dup", "function::dup#2"]);
    const file = fileWith(
      [
        {
          oldStart: 4,
          oldLines: 3,
          newStart: 4,
          newLines: 3,
          lines: [
            { kind: "ctx", oldLine: 4, newLine: 4, position: 1, text: "function dup(): void {" },
            { kind: "add", oldLine: null, newLine: 5, position: 2, text: "  two();" },
            { kind: "ctx", oldLine: 6, newLine: 6, position: 3, text: "}" },
          ],
        },
      ],
      [5],
    );
    const first = mapFileSymbols({ file, headDefinitions: headDefs, headLineCount: 6, baseDefinitions: baseDefs });
    const second = mapFileSymbols({ file, headDefinitions: headDefs, headLineCount: 6, baseDefinitions: baseDefs });
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ name: "dup", changedLines: [5], startLine: 4 });
  });
});
