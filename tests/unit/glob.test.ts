import { describe, expect, test } from "bun:test";
import { isValidGlobPattern, matchGlob } from "../../src/utils/glob.ts";

describe("isValidGlobPattern", () => {
  test("accepts supported syntax", () => {
    for (const pattern of [
      "*.ts",
      "src/*.ts",
      "src/**/*.ts",
      "**/*.lock",
      "dist/**",
      "build/**",
      "node_modules/**",
      "**",
      "**/*.generated.*",
      "**/*.snap",
      "src/controllers/**",
      "tests/**",
      "gen/**",
      "a?c.ts",
      "file?.ts",
      "*.min.*",
      "**/*.min.*",
      "a/b/c",
      "a*b?c",
      ".eslintrc",
      "src/.hidden/*.ts",
    ]) {
      expect(isValidGlobPattern(pattern)).toBe(true);
    }
  });

  test("rejects empty, NUL, backslash, and absolute patterns", () => {
    expect(isValidGlobPattern("")).toBe(false);
    expect(isValidGlobPattern("a\0b.ts")).toBe(false);
    expect(isValidGlobPattern("src\\.ts")).toBe(false);
    expect(isValidGlobPattern("src\\*.ts")).toBe(false);
    expect(isValidGlobPattern("/src/*.ts")).toBe(false);
  });

  test("rejects dot, dotdot, and empty segments", () => {
    for (const pattern of [".", "..", "src/./a.ts", "../a.ts", "src/../a.ts", "src//a.ts", "src/", "a/**//b"]) {
      expect(isValidGlobPattern(pattern)).toBe(false);
    }
  });

  test("rejects malformed and embedded double stars", () => {
    for (const pattern of ["***", "src/***/a.ts", "ab**", "**ab", "src/a**b/*.ts"]) {
      expect(isValidGlobPattern(pattern)).toBe(false);
    }
  });

  test("rejects brace, class, extglob, and negation syntax", () => {
    for (const pattern of [
      "src/{a,b}.ts",
      "src/[abc].ts",
      "src/*.+(ts|js)",
      "src/!(a).ts",
      "src/@(a).ts",
      "src/a(b).ts",
      "!src/a.ts",
    ]) {
      expect(isValidGlobPattern(pattern)).toBe(false);
    }
  });
});

describe("matchGlob", () => {
  test("star stays within one segment", () => {
    expect(matchGlob("a.ts", "*.ts")).toBe(true);
    expect(matchGlob("src/a.ts", "*.ts")).toBe(false);
    expect(matchGlob("src/a.ts", "src/*.ts")).toBe(true);
    expect(matchGlob("src/a/b.ts", "src/*.ts")).toBe(false);
    expect(matchGlob("app.min.js", "*.min.*")).toBe(true);
    expect(matchGlob("app.js", "*.min.*")).toBe(false);
    expect(matchGlob("src/app.min.js", "*.min.*")).toBe(false);
  });

  test("canonical minified pattern matches at root and at depth", () => {
    for (const path of ["bundle.min.js", "src/app.min.js", "src/generated/bundle.min.js"]) {
      expect(matchGlob(path, "**/*.min.*")).toBe(true);
    }
    expect(matchGlob("public/assets/app.min.css", "**/*.min.*")).toBe(true);
    expect(matchGlob("src/app.js", "**/*.min.*")).toBe(false);
    expect(matchGlob("src/minifier.js", "**/*.min.*")).toBe(false);
  });

  test("double-star spans segments and matches zero dirs after slash", () => {
    expect(matchGlob("a.lock", "**/*.lock")).toBe(true);
    expect(matchGlob("src/nested/b.lock", "**/*.lock")).toBe(true);
    expect(matchGlob("a.lock.txt", "**/*.lock")).toBe(false);
    expect(matchGlob("src/a.ts", "src/**")).toBe(true);
    expect(matchGlob("src/a/b.ts", "src/**")).toBe(true);
    expect(matchGlob("other/a.ts", "src/**")).toBe(false);
    expect(matchGlob("dist/a.js", "dist/**")).toBe(true);
    expect(matchGlob("dist/a/b.js", "dist/**")).toBe(true);
    expect(matchGlob("a/b/c.ts", "**")).toBe(true);
  });

  test("question mark matches exactly one char", () => {
    expect(matchGlob("file1.ts", "file?.ts")).toBe(true);
    expect(matchGlob("file.ts", "file?.ts")).toBe(false);
    expect(matchGlob("file12.ts", "file?.ts")).toBe(false);
    expect(matchGlob("src/file1.ts", "src/file?.ts")).toBe(true);
  });

  test("matching is case sensitive", () => {
    expect(matchGlob("a.ts", "*.TS")).toBe(false);
    expect(matchGlob("A.TS", "*.ts")).toBe(false);
    expect(matchGlob("A.TS", "*.TS")).toBe(true);
  });
});
