import { describe, expect, test } from "bun:test";
import { parseUnifiedDiff, type ParsedFilePatch } from "../../src/diff/parse.ts";
import { assignDiffPositions, getCommentableLines } from "../../src/diff/positions.ts";
import type { DiffHunk } from "../../src/types/diff.ts";

function patchFile(overrides: Partial<ParsedFilePatch> & { path: string }): ParsedFilePatch {
  return { status: "modified", oldPath: null, binary: false, hunks: [], ...overrides };
}

function hunk(overrides: Partial<DiffHunk>): DiffHunk {
  return { oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines: [], ...overrides };
}

describe("assignDiffPositions", () => {
  test("numbers add/del/ctx lines with per-file positions from 1", () => {
    const files = assignDiffPositions([
      patchFile({
        path: "a.ts",
        hunks: [
          hunk({
            oldStart: 1,
            oldLines: 3,
            newStart: 1,
            newLines: 4,
            lines: [
              { kind: "ctx", oldLine: -1, newLine: -1, position: -1, text: "ctx1" },
              { kind: "del", oldLine: -1, newLine: -1, position: -1, text: "del1" },
              { kind: "add", oldLine: -1, newLine: -1, position: -1, text: "add1" },
              { kind: "add", oldLine: -1, newLine: -1, position: -1, text: "add2" },
              { kind: "ctx", oldLine: -1, newLine: -1, position: -1, text: "ctx2" },
            ],
          }),
        ],
      }),
    ]);
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { kind: "ctx", oldLine: 1, newLine: 1, position: 1, text: "ctx1" },
      { kind: "del", oldLine: 2, newLine: null, position: 2, text: "del1" },
      { kind: "add", oldLine: null, newLine: 2, position: 3, text: "add1" },
      { kind: "add", oldLine: null, newLine: 3, position: 4, text: "add2" },
      { kind: "ctx", oldLine: 3, newLine: 4, position: 5, text: "ctx2" },
    ]);
  });

  test("continues positions across hunks after a large line gap", () => {
    const files = assignDiffPositions([
      patchFile({
        path: "a.ts",
        hunks: [
          hunk({
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 2,
            lines: [
              { kind: "ctx", oldLine: 0, newLine: 0, position: 0, text: "ctx" },
              { kind: "del", oldLine: 0, newLine: null, position: 0, text: "del" },
              { kind: "add", oldLine: null, newLine: 0, position: 0, text: "add" },
            ],
          }),
          hunk({
            oldStart: 50,
            oldLines: 2,
            newStart: 50,
            newLines: 3,
            lines: [
              { kind: "ctx", oldLine: 0, newLine: 0, position: 0, text: "ctx2" },
              { kind: "add", oldLine: null, newLine: 0, position: 0, text: "more" },
              { kind: "ctx", oldLine: 0, newLine: 0, position: 0, text: "ctx3" },
            ],
          }),
        ],
      }),
    ]);
    expect(files[0]?.hunks[0]?.lines.map((l) => l.position)).toEqual([1, 2, 3]);
    expect(files[0]?.hunks[1]?.lines).toEqual([
      { kind: "ctx", oldLine: 50, newLine: 50, position: 4, text: "ctx2" },
      { kind: "add", oldLine: null, newLine: 51, position: 5, text: "more" },
      { kind: "ctx", oldLine: 51, newLine: 52, position: 6, text: "ctx3" },
    ]);
  });

  test("resets positions for each file and preserves file identity", () => {
    const files = assignDiffPositions([
      patchFile({
        path: "a.ts",
        status: "renamed",
        oldPath: "old.ts",
        binary: false,
        hunks: [
          hunk({
            lines: [
              { kind: "del", oldLine: 0, newLine: null, position: 0, text: "x" },
              { kind: "add", oldLine: null, newLine: 0, position: 0, text: "y" },
            ],
          }),
        ],
      }),
      patchFile({
        path: "b.ts",
        hunks: [
          hunk({
            lines: [
              { kind: "del", oldLine: 0, newLine: null, position: 0, text: "p" },
              { kind: "add", oldLine: null, newLine: 0, position: 0, text: "q" },
            ],
          }),
        ],
      }),
    ]);
    expect(files[0]?.hunks[0]?.lines.map((l) => l.position)).toEqual([1, 2]);
    expect(files[1]?.hunks[0]?.lines.map((l) => l.position)).toEqual([1, 2]);
    expect(files[0]).toMatchObject({ status: "renamed", path: "a.ts", oldPath: "old.ts", binary: false });
  });

  test("numbers new files from a -0,0 old range and deleted files into +0,0", () => {
    const files = assignDiffPositions([
      patchFile({
        path: "new.ts",
        status: "added",
        hunks: [
          hunk({
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 2,
            lines: [
              { kind: "add", oldLine: null, newLine: 0, position: 0, text: "line1" },
              { kind: "add", oldLine: null, newLine: 0, position: 0, text: "line2" },
            ],
          }),
        ],
      }),
      patchFile({
        path: "old.ts",
        status: "deleted",
        hunks: [
          hunk({
            oldStart: 1,
            oldLines: 2,
            newStart: 0,
            newLines: 0,
            lines: [
              { kind: "del", oldLine: 0, newLine: null, position: 0, text: "gone1" },
              { kind: "del", oldLine: 0, newLine: null, position: 0, text: "gone2" },
            ],
          }),
        ],
      }),
    ]);
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { kind: "add", oldLine: null, newLine: 1, position: 1, text: "line1" },
      { kind: "add", oldLine: null, newLine: 2, position: 2, text: "line2" },
    ]);
    expect(files[1]?.hunks[0]?.lines).toEqual([
      { kind: "del", oldLine: 1, newLine: null, position: 1, text: "gone1" },
      { kind: "del", oldLine: 2, newLine: null, position: 2, text: "gone2" },
    ]);
  });

  test("leaves binary and hunk-less files untouched", () => {
    const files = assignDiffPositions([
      patchFile({ path: "img.png", status: "added", binary: true }),
      patchFile({ path: "run.sh" }),
    ]);
    expect(files).toEqual([
      patchFile({ path: "img.png", status: "added", binary: true }),
      patchFile({ path: "run.sh" }),
    ]);
  });

  test("returns empty for empty input and never mutates its input", () => {
    expect(assignDiffPositions([])).toEqual([]);
    const input = [
      patchFile({
        path: "a.ts",
        hunks: [
          hunk({
            lines: [{ kind: "add", oldLine: null, newLine: 0, position: 0, text: "x" }],
          }),
        ],
      }),
    ];
    const snapshot = structuredClone(input);
    assignDiffPositions(input);
    expect(input).toEqual(snapshot);
  });

  test("agrees with parseUnifiedDiff on a multi-hunk patch", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "index 1111111..2222222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@",
      " ctx",
      "-del",
      "+add",
      "@@ -50,2 +50,3 @@",
      " ctx2",
      "+more",
      " ctx3",
      "",
    ].join("\n");
    const parsed = parseUnifiedDiff(patch, [{ status: "modified", path: "a.ts", oldPath: null }]);
    const stripped = parsed.map((file) => ({
      ...file,
      hunks: file.hunks.map((h) => ({
        ...h,
        lines: h.lines.map((l) => ({ ...l, oldLine: -999, newLine: -999, position: -999 })),
      })),
    }));
    expect(assignDiffPositions(stripped)).toEqual(parsed);
  });
});

describe("getCommentableLines", () => {
  test("collects add and ctx head-side lines, skipping del and nulls", () => {
    expect(
      getCommentableLines([
        hunk({
          lines: [
            { kind: "ctx", oldLine: 1, newLine: 1, position: 1, text: "ctx1" },
            { kind: "del", oldLine: 2, newLine: null, position: 2, text: "del1" },
            { kind: "add", oldLine: null, newLine: 2, position: 3, text: "add1" },
            { kind: "add", oldLine: null, newLine: 3, position: 4, text: "add2" },
            { kind: "ctx", oldLine: 3, newLine: 4, position: 5, text: "ctx2" },
          ],
        }),
      ]),
    ).toEqual([1, 2, 3, 4]);
  });

  test("sorts numerically and dedupes", () => {
    expect(
      getCommentableLines([
        hunk({
          oldStart: 50,
          newStart: 50,
          lines: [
            { kind: "add", oldLine: null, newLine: 52, position: 1, text: "b" },
            { kind: "ctx", oldLine: 50, newLine: 50, position: 2, text: "a" },
            { kind: "add", oldLine: null, newLine: 52, position: 3, text: "dup" },
            { kind: "ctx", oldLine: 51, newLine: 51, position: 4, text: "c" },
          ],
        }),
      ]),
    ).toEqual([50, 51, 52]);
  });

  test("returns empty for del-only, binary, and empty hunks", () => {
    const delOnly = hunk({
      lines: [{ kind: "del", oldLine: 1, newLine: null, position: 1, text: "gone" }],
    });
    expect(getCommentableLines([delOnly])).toEqual([]);
    expect(getCommentableLines([])).toEqual([]);
  });
});
