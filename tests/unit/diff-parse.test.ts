import { describe, expect, test } from "bun:test";
import { ReviewerError } from "../../src/core/errors.ts";
import {
  parseNameStatusZ,
  parseUnifiedDiff,
  type FileChangeMetadata,
} from "../../src/diff/parse.ts";

function nul(...fields: string[]): Uint8Array {
  return new TextEncoder().encode(`${fields.join("\0")}\0`);
}

function fileMeta(overrides: Partial<FileChangeMetadata> & { path: string }): FileChangeMetadata {
  return { status: "modified", oldPath: null, ...overrides };
}

function parseFailedOf(fn: () => unknown): ReviewerError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewerError);
    const reviewer = error as ReviewerError;
    expect(reviewer.code).toBe("PARSE_FAILED");
    return reviewer;
  }
  throw new Error("expected PARSE_FAILED but nothing was thrown");
}

describe("parseNameStatusZ", () => {
  test("maps M/A/D single records", () => {
    expect(parseNameStatusZ(nul("M", "src/a.ts"))).toEqual([
      { status: "modified", path: "src/a.ts", oldPath: null },
    ]);
    expect(parseNameStatusZ(nul("A", "src/b.ts"))).toEqual([
      { status: "added", path: "src/b.ts", oldPath: null },
    ]);
    expect(parseNameStatusZ(nul("D", "src/c.ts"))).toEqual([
      { status: "deleted", path: "src/c.ts", oldPath: null },
    ]);
  });

  test("maps T to modified", () => {
    expect(parseNameStatusZ(nul("T", "src/link.ts"))).toEqual([
      { status: "modified", path: "src/link.ts", oldPath: null },
    ]);
  });

  test("maps R-score pairs to renamed with old/new paths", () => {
    expect(parseNameStatusZ(nul("R100", "src/old.ts", "src/new.ts"))).toEqual([
      { status: "renamed", path: "src/new.ts", oldPath: "src/old.ts" },
    ]);
    expect(parseNameStatusZ(nul("R087", "o.ts", "n.ts"))).toEqual([
      { status: "renamed", path: "n.ts", oldPath: "o.ts" },
    ]);
  });

  test("parses multiple records from one NUL output", () => {
    const out = parseNameStatusZ(nul("M", "a.ts", "A", "b.ts", "D", "c.ts"));
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.status)).toEqual(["modified", "added", "deleted"]);
  });

  test("preserves spaces, quotes, backslashes, tabs, unicode in paths", () => {
    const paths = ["dir/my file.ts", `we"ird\\name.ts`, "tab\tname.ts", "unicode-caf\u00e9-\u6f22\u5b57.ts"];
    for (const path of paths) {
      expect(parseNameStatusZ(nul("M", path))).toEqual([
        { status: "modified", path, oldPath: null },
      ]);
    }
  });

  test("preserves a literal newline inside a path", () => {
    const path = "src/has\nnewline.ts";
    expect(parseNameStatusZ(nul("M", path))[0]?.path).toBe(path);
  });

  test("returns empty for empty output", () => {
    expect(parseNameStatusZ(new Uint8Array(0))).toEqual([]);
  });

  test("rejects missing NUL terminator", () => {
    const truncated = new TextEncoder().encode("M\0a.ts");
    parseFailedOf(() => parseNameStatusZ(truncated));
  });

  test("rejects unknown statuses including copies", () => {
    for (const fields of [["X", "a.ts"], ["C100", "o.ts", "n.ts"], ["U", "a.ts"], ["m", "a.ts"]]) {
      parseFailedOf(() => parseNameStatusZ(nul(...fields)));
    }
  });

  test("rejects malformed rename pairs and truncated records", () => {
    parseFailedOf(() => parseNameStatusZ(nul("R100", "only-one.ts")));
    parseFailedOf(() => parseNameStatusZ(nul("R100")));
    parseFailedOf(() => parseNameStatusZ(nul("M")));
    parseFailedOf(() => parseNameStatusZ(nul("D", "")));
  });
});

describe("parseUnifiedDiff sections", () => {
  test("returns empty for empty patch with empty metadata", () => {
    expect(parseUnifiedDiff("", [])).toEqual([]);
  });

  test("rejects section/metadata count mismatch", () => {
    const one = [
      "diff --git a/a.ts b/a.ts",
      "index 1111111..2222222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,1 @@",
      " same",
      "",
    ].join("\n");
    parseFailedOf(() => parseUnifiedDiff(one, []));
    parseFailedOf(() => parseUnifiedDiff("", [fileMeta({ path: "a.ts" })]));
    parseFailedOf(() =>
      parseUnifiedDiff(one, [fileMeta({ path: "a.ts" }), fileMeta({ path: "b.ts" })]),
    );
  });

  test("rejects combined merge diffs explicitly", () => {
    const patch = ["diff --cc a.ts", "index 111..222 100644", "@@@ -1,1 -1,1 +1,1 @@@ bla", ""].join(
      "\n",
    );
    parseFailedOf(() => parseUnifiedDiff(patch, [fileMeta({ path: "a.ts" })]));
  });
});

describe("parseUnifiedDiff hunks", () => {
  test("parses add/del/ctx with line numbers, positions, and exact text", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,4 @@",
      " ctx1",
      "-del1",
      "+add1",
      "+add2",
      " ctx2",
      "",
    ].join("\n");
    const [file] = parseUnifiedDiff(patch, [fileMeta({ path: "src/a.ts" })]);
    expect(file?.binary).toBe(false);
    expect(file?.hunks).toHaveLength(1);
    expect(file?.hunks[0]).toEqual({
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 4,
      lines: [
        { kind: "ctx", oldLine: 1, newLine: 1, position: 1, text: "ctx1" },
        { kind: "del", oldLine: 2, newLine: null, position: 2, text: "del1" },
        { kind: "add", oldLine: null, newLine: 2, position: 3, text: "add1" },
        { kind: "add", oldLine: null, newLine: 3, position: 4, text: "add2" },
        { kind: "ctx", oldLine: 3, newLine: 4, position: 5, text: "ctx2" },
      ],
    });
  });

  test("parses new files with -0,0 old range", () => {
    const patch = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,2 @@",
      "+line1",
      "+line2",
      "",
    ].join("\n");
    const [file] = parseUnifiedDiff(patch, [fileMeta({ status: "added", path: "src/new.ts" })]);
    expect(file?.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 });
    expect(file?.hunks[0]?.lines).toEqual([
      { kind: "add", oldLine: null, newLine: 1, position: 1, text: "line1" },
      { kind: "add", oldLine: null, newLine: 2, position: 2, text: "line2" },
    ]);
  });

  test("parses deleted files with +0,0 new range", () => {
    const patch = [
      "diff --git a/src/old.ts b/src/old.ts",
      "deleted file mode 100644",
      "index 4444444..0000000",
      "--- a/src/old.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-gone1",
      "-gone2",
      "",
    ].join("\n");
    const [file] = parseUnifiedDiff(patch, [fileMeta({ status: "deleted", path: "src/old.ts" })]);
    expect(file?.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0 });
    expect(file?.hunks[0]?.lines).toEqual([
      { kind: "del", oldLine: 1, newLine: null, position: 1, text: "gone1" },
      { kind: "del", oldLine: 2, newLine: null, position: 2, text: "gone2" },
    ]);
  });

  test("continues positions across hunks after a large line gap", () => {
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
    const [file] = parseUnifiedDiff(patch, [fileMeta({ path: "a.ts" })]);
    expect(file?.hunks).toHaveLength(2);
    expect(file?.hunks[0]?.lines.map((l) => l.position)).toEqual([1, 2, 3]);
    expect(file?.hunks[1]?.lines).toEqual([
      { kind: "ctx", oldLine: 50, newLine: 50, position: 4, text: "ctx2" },
      { kind: "add", oldLine: null, newLine: 51, position: 5, text: "more" },
      { kind: "ctx", oldLine: 51, newLine: 52, position: 6, text: "ctx3" },
    ]);
  });

  test("resets positions for each file", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "index 1111111..2222222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,1 @@",
      "-x",
      "+y",
      "diff --git a/b.ts b/b.ts",
      "index 3333333..4444444 100644",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1,1 +1,1 @@",
      "-p",
      "+q",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(patch, [fileMeta({ path: "a.ts" }), fileMeta({ path: "b.ts" })]);
    expect(files[0]?.hunks[0]?.lines.map((l) => l.position)).toEqual([1, 2]);
    expect(files[1]?.hunks[0]?.lines.map((l) => l.position)).toEqual([1, 2]);
  });

  test("preserves empty added and empty context lines", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "index 1111111..2222222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,3 @@",
      " ",
      " x",
      "+",
      "",
    ].join("\n");
    const [file] = parseUnifiedDiff(patch, [fileMeta({ path: "a.ts" })]);
    expect(file?.hunks[0]?.lines).toEqual([
      { kind: "ctx", oldLine: 1, newLine: 1, position: 1, text: "" },
      { kind: "ctx", oldLine: 2, newLine: 2, position: 2, text: "x" },
      { kind: "add", oldLine: null, newLine: 3, position: 3, text: "" },
    ]);
  });

  test("ignores the no-newline marker without counting it", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "index 1111111..2222222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@",
      " line",
      "-old",
      "+new",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const [file] = parseUnifiedDiff(patch, [fileMeta({ path: "a.ts" })]);
    expect(file?.hunks[0]?.lines.map((l) => l.position)).toEqual([1, 2, 3]);
    expect(file?.hunks[0]?.lines[2]).toEqual({
      kind: "add",
      oldLine: null,
      newLine: 2,
      position: 3,
      text: "new",
    });
  });

  test("preserves CR in CRLF content", () => {
    const patch = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,1 +1,2 @@", " ctx\r", "+add\r", ""].join(
      "\n",
    );
    const [file] = parseUnifiedDiff(patch, [fileMeta({ path: "a.ts" })]);
    expect(file?.hunks[0]?.lines).toEqual([
      { kind: "ctx", oldLine: 1, newLine: 1, position: 1, text: "ctx\r" },
      { kind: "add", oldLine: null, newLine: 2, position: 2, text: "add\r" },
    ]);
  });

  test("treats omitted hunk counts as 1", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -5 +5,2 @@",
      " same",
      "+extra",
      "",
    ].join("\n");
    const [file] = parseUnifiedDiff(patch, [fileMeta({ path: "a.ts" })]);
    expect(file?.hunks[0]).toMatchObject({ oldStart: 5, oldLines: 1, newStart: 5, newLines: 2 });
  });

  test("keeps section text after the hunk header", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,1 @@ function foo() {",
      "-x",
      "+y",
      "",
    ].join("\n");
    const [file] = parseUnifiedDiff(patch, [fileMeta({ path: "a.ts" })]);
    expect(file?.hunks[0]?.lines).toHaveLength(2);
  });

  test("keeps ---/+++ file markers inside hunks as ordinary lines", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,2 @@",
      " ---老款 a/file",
      "++++ b/file",
      "",
    ].join("\n");
    const [file] = parseUnifiedDiff(patch, [fileMeta({ path: "a.ts" })]);
    expect(file?.hunks[0]?.lines).toEqual([
      { kind: "ctx", oldLine: 1, newLine: 1, position: 1, text: "---老款 a/file" },
      { kind: "add", oldLine: null, newLine: 2, position: 2, text: "+++ b/file" },
    ]);
  });

  test("recognizes binary markers with no hunks", () => {
    const marker = [
      "diff --git a/img.png b/img.png",
      "new file mode 100644",
      "index 0000000..5555555",
      "Binary files /dev/null and b/img.png differ",
      "",
    ].join("\n");
    const [marked] = parseUnifiedDiff(marker, [fileMeta({ status: "added", path: "img.png" })]);
    expect(marked?.binary).toBe(true);
    expect(marked?.hunks).toEqual([]);

    const gitBinary = [
      "diff --git a/a.bin b/a.bin",
      "index 0000000..6666666 100644",
      "GIT binary patch",
      "literal 3",
      "abc",
      "",
    ].join("\n");
    const [binary] = parseUnifiedDiff(gitBinary, [fileMeta({ status: "added", path: "a.bin" })]);
    expect(binary?.binary).toBe(true);
    expect(binary?.hunks).toEqual([]);
  });

  test("parses mode-only changes with no hunks", () => {
    const patch = ["diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755", ""].join("\n");
    const [file] = parseUnifiedDiff(patch, [fileMeta({ path: "run.sh" })]);
    expect(file?.binary).toBe(false);
    expect(file?.hunks).toEqual([]);
  });

  test("parses rename-only and rename-with-content sections", () => {
    const renameOnly = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
      "",
    ].join("\n");
    const [renamed] = parseUnifiedDiff(renameOnly, [
      fileMeta({ status: "renamed", path: "new.ts", oldPath: "old.ts" }),
    ]);
    expect(renamed?.hunks).toEqual([]);
    expect(renamed).toMatchObject({ status: "renamed", path: "new.ts", oldPath: "old.ts" });

    const withContent = [
      "diff --git a/o.ts b/n.ts",
      "similarity index 80%",
      "rename from o.ts",
      "rename to n.ts",
      "index 7777777..8888888 100644",
      "--- a/o.ts",
      "+++ b/n.ts",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-was",
      "+now",
      "",
    ].join("\n");
    const [changed] = parseUnifiedDiff(withContent, [
      fileMeta({ status: "renamed", path: "n.ts", oldPath: "o.ts" }),
    ]);
    expect(changed?.hunks).toHaveLength(1);
    expect(changed?.hunks[0]?.lines.map((l) => l.kind)).toEqual(["ctx", "del", "add"]);
  });

  test("rejects malformed hunk headers", () => {
    for (const header of ["@@ bad @@", "@@ -1,x +1,1 @@", "@@ -a,1 +1,1 @@", "@@ -1,1 +2,1", "@@@ -1,1 +1,1 @@@"]) {
      const patch = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", header, " x", ""].join("\n");
      parseFailedOf(() => parseUnifiedDiff(patch, [fileMeta({ path: "a.ts" })]));
    }
  });

  test("rejects hunks consuming too few or too many lines", () => {
    const tooFew = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,3 @@",
      " a",
      " b",
      "",
    ].join("\n");
    parseFailedOf(() => parseUnifiedDiff(tooFew, [fileMeta({ path: "a.ts" })]));

    const tooMany = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,1 @@",
      " a",
      "+extra",
      "",
    ].join("\n");
    parseFailedOf(() => parseUnifiedDiff(tooMany, [fileMeta({ path: "a.ts" })]));
  });

  test("rejects garbage lines outside hunks", () => {
    const patch = ["diff --git a/a.ts b/a.ts", "not a real header", "@@ -1,1 +1,1 @@", " x", ""].join("\n");
    parseFailedOf(() => parseUnifiedDiff(patch, [fileMeta({ path: "a.ts" })]));
  });
});
