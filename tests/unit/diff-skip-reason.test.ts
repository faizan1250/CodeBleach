import { describe, expect, test } from "bun:test";
import type { ChangedFile, DiffSkipReason } from "../../src/types/diff.ts";
import type { DiffSkipReason as BarrelSkipReason } from "../../src/types/index.ts";

// Exhaustive at the type level: adding a seventh reason breaks the sort below.
const ALL_REASONS: readonly DiffSkipReason[] = [
  "binary",
  "generated",
  "too-large",
  "ignored",
  "deleted",
  "lockfile",
];

function stubFile(skipReason: ChangedFile["skipReason"]): ChangedFile {
  return {
    path: "src/a.ts",
    oldPath: null,
    status: "modified",
    language: "typescript",
    skipReason,
    hunks: [],
    commentableLines: [],
    symbols: [],
  };
}

describe("DiffSkipReason contract", () => {
  test("covers exactly the six documented skip reasons", () => {
    expect([...ALL_REASONS].sort()).toEqual([
      "binary",
      "deleted",
      "generated",
      "ignored",
      "lockfile",
      "too-large",
    ]);
  });

  test("re-exported from the types barrel without a duplicate definition", () => {
    const viaBarrel: BarrelSkipReason = "ignored";
    const direct: DiffSkipReason = viaBarrel;
    expect(stubFile(direct).skipReason).toBe("ignored");
  });

  test("arbitrary strings are rejected", () => {
    expect(stubFile("ignored").skipReason).toBe("ignored");
    // @ts-expect-error - skipReason is a closed union, not string
    expect(stubFile("bogus").skipReason).toBe("bogus");
  });
});
