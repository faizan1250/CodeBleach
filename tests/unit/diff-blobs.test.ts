import { describe, expect, test } from "bun:test";
import { countBlobLines, moduleSymbol } from "../../src/diff/blobs.ts";
import type { ParsedFilePatch } from "../../src/diff/parse.ts";

const encoder = new TextEncoder();

function patchWithAdds(newLines: (number | null)[]): ParsedFilePatch {
  return {
    status: "modified",
    path: "src/a.ts",
    oldPath: null,
    binary: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 4,
        lines: newLines.map((newLine, index) => ({
          kind: "add" as const,
          oldLine: null,
          newLine,
          position: index,
          text: `line ${String(index)}`,
        })),
      },
    ],
  };
}

describe("countBlobLines", () => {
  test("empty blob has no lines", () => {
    expect(countBlobLines(new Uint8Array(0))).toBe(0);
  });

  test("counts trailing-newline and unterminated endings", () => {
    expect(countBlobLines(encoder.encode("a\nb\n"))).toBe(2);
    expect(countBlobLines(encoder.encode("a\nb"))).toBe(2);
    expect(countBlobLines(encoder.encode("a"))).toBe(1);
  });

  test("counts lone newlines", () => {
    expect(countBlobLines(encoder.encode("\n"))).toBe(1);
    expect(countBlobLines(encoder.encode("\n\n"))).toBe(2);
  });
});

describe("moduleSymbol", () => {
  test("collects sorted unique added head lines", () => {
    const symbol = moduleSymbol(20, patchWithAdds([9, 9, 3, null]));
    expect(symbol).toMatchObject({ name: "<module>", kind: "module", startLine: 1, endLine: 20 });
    expect(symbol.changedLines).toEqual([3, 9]);
  });

  test("floors empty blobs at line one", () => {
    const symbol = moduleSymbol(0, patchWithAdds([]));
    expect(symbol.endLine).toBe(1);
    expect(symbol.changedLines).toEqual([]);
  });
});
