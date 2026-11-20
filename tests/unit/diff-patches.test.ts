import { describe, expect, test } from "bun:test";
import { buildPatchPathspec, fetchEligiblePatches, isUnsupportedMode } from "../../src/diff/patches.ts";

describe("isUnsupportedMode", () => {
  test("flags symlinks and gitlinks on either side", () => {
    expect(isUnsupportedMode("120000", "120000")).toBe(true);
    expect(isUnsupportedMode("100644", "120000")).toBe(true);
    expect(isUnsupportedMode("160000", "100644")).toBe(true);
    expect(isUnsupportedMode("100644", "100755")).toBe(false);
    expect(isUnsupportedMode("100644", "100644")).toBe(false);
  });
});

describe("buildPatchPathspec", () => {
  test("renames contribute both sides, entries deduped", () => {
    expect(
      buildPatchPathspec([
        { status: "renamed", path: "src/b.ts", oldPath: "src/a.ts" },
        { status: "modified", path: "src/b.ts", oldPath: null },
        { status: "added", path: "src/c.ts", oldPath: null },
      ]),
    ).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  test("plain files pass through in order", () => {
    expect(buildPatchPathspec([{ status: "modified", path: "src/a.ts", oldPath: null }])).toEqual(["src/a.ts"]);
  });
});

describe("fetchEligiblePatches", () => {
  test("empty candidates short-circuit without running git", async () => {
    await expect(
      fetchEligiblePatches({
        repoRoot: "no-such-dir",
        mergeBase: "base",
        headSha: "head",
        candidates: [],
        patchMaxStdoutBytes: 1024,
      }),
    ).resolves.toEqual([]);
  });
});
