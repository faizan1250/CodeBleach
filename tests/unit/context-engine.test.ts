import { describe, expect, test } from "bun:test";
import { stableItemId, stableUnitId, toReviewUnitFile } from "../../src/context/engine.ts";
import type { ChangedFile } from "../../src/types/diff.ts";

function file(): ChangedFile {
  return {
    path: "src/a.ts",
    oldPath: null,
    status: "modified",
    language: "typescript",
    hunks: [],
    commentableLines: [1, 2],
    symbols: [],
  };
}

describe("p3-11 unit helpers", () => {
  test("projects file without hunks or symbols", () => {
    expect(toReviewUnitFile(file())).toEqual({
      path: "src/a.ts",
      oldPath: null,
      status: "modified",
      language: "typescript",
      commentableLines: [1, 2],
    });
  });

  test("unit ids are stable and path-sensitive", () => {
    const a = stableUnitId("a".repeat(40), "src/a.ts", "function", undefined, "f", 1);
    const b = stableUnitId("a".repeat(40), "src/a.ts", "function", undefined, "f", 1);
    const c = stableUnitId("a".repeat(40), "src/b.ts", "function", undefined, "f", 1);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test("item ids are stable", () => {
    const unit = stableUnitId("a".repeat(40), "src/a.ts", "function", undefined, "f", 1);
    expect(stableItemId(unit, "definition", "src/a.ts", 1)).toBe(
      stableItemId(unit, "definition", "src/a.ts", 1),
    );
  });
});
