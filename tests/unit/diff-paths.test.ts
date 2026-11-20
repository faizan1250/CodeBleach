import { describe, expect, test } from "bun:test";
import { ReviewerError } from "../../src/core/errors.ts";
import { detectLanguage, normalizeRepoPath } from "../../src/diff/paths.ts";

function invalidPathOf(path: string): ReviewerError {
  try {
    normalizeRepoPath(path);
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewerError);
    return error as ReviewerError;
  }
  throw new Error(`expected PARSE_FAILED for ${JSON.stringify(path)}`);
}

describe("normalizeRepoPath", () => {
  test("passes clean repo-relative paths through", () => {
    for (const path of ["a.ts", "src/app.ts", "src/my file.ts", 'src/qu"ote.ts', "src/tab\tname.ts", "src/unié.ts"]) {
      expect(normalizeRepoPath(path)).toBe(path);
    }
  });

  test("rejects empty, absolute, traversal, and NUL paths", () => {
    for (const path of ["", "/abs/path.ts", "..", "../escape.ts", "src/../../escape.ts", "a\0b.ts"]) {
      expect(invalidPathOf(path).code).toBe("PARSE_FAILED");
    }
  });
});

describe("detectLanguage", () => {
  test("maps typescript extensions case-insensitively", () => {
    for (const path of ["a.ts", "A.TS", "src/a.mts", "src/a.CTS", "a.d.ts"]) {
      expect(detectLanguage(path)).toBe("typescript");
    }
  });

  test("maps tsx and javascript extensions case-insensitively", () => {
    expect(detectLanguage("a.tsx")).toBe("tsx");
    expect(detectLanguage("src/A.TSX")).toBe("tsx");
    for (const path of ["a.js", "a.JS", "a.jsx", "a.mjs", "a.cjs", "src/a.MJS"]) {
      expect(detectLanguage(path)).toBe("javascript");
    }
  });

  test("returns null for unsupported or missing extensions", () => {
    for (const path of ["a.py", "a.json", "README", "a.ts.map", "Makefile", "a."]) {
      expect(detectLanguage(path)).toBeNull();
    }
  });
});
