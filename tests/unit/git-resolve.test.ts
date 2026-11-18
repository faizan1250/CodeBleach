import { describe, expect, test } from "bun:test";
import { ReviewerError } from "../../src/core/errors.ts";
import { isFullCommitSha, normalizeCommitSha } from "../../src/diff/git.ts";

const SHA40 = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SHA64 = `${SHA40}9abcdef0123456789abcdef01`;

describe("isFullCommitSha", () => {
  test("accepts lowercase 40- and 64-hex", () => {
    expect(isFullCommitSha(SHA40)).toBe(true);
    expect(isFullCommitSha(SHA64)).toBe(true);
  });

  test("accepts uppercase 40- and 64-hex", () => {
    expect(isFullCommitSha(SHA40.toUpperCase())).toBe(true);
    expect(isFullCommitSha(SHA64.toUpperCase())).toBe(true);
  });

  test("rejects abbreviated SHAs and refs", () => {
    expect(isFullCommitSha(SHA40.slice(0, 7))).toBe(false);
    expect(isFullCommitSha(SHA40.slice(0, 39))).toBe(false);
    expect(isFullCommitSha("HEAD")).toBe(false);
    expect(isFullCommitSha("main")).toBe(false);
    expect(isFullCommitSha("")).toBe(false);
  });

  test("rejects option-like, padded, and non-hex input", () => {
    expect(isFullCommitSha("--verify")).toBe(false);
    expect(isFullCommitSha(` ${SHA40}`)).toBe(false);
    expect(isFullCommitSha(`${SHA40}\n`)).toBe(false);
    expect(isFullCommitSha(`z${SHA40.slice(1)}`)).toBe(false);
    expect(isFullCommitSha(SHA40.slice(0, 41))).toBe(false);
    expect(isFullCommitSha(SHA64.slice(0, 63))).toBe(false);
  });
});

describe("normalizeCommitSha", () => {
  test("lowercases valid SHAs", () => {
    expect(normalizeCommitSha(SHA40.toUpperCase(), "baseSha")).toBe(SHA40);
    expect(normalizeCommitSha(SHA64.toUpperCase(), "headSha")).toBe(SHA64);
  });

  test("rejects invalid SHAs as GIT_FAILED naming the label", () => {
    for (const bad of ["HEAD", SHA40.slice(0, 7), "", "--verify"]) {
      let caught: unknown = null;
      try {
        normalizeCommitSha(bad, "baseSha");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ReviewerError);
      expect((caught as ReviewerError).code).toBe("GIT_FAILED");
      expect((caught as Error).message).toMatch(/baseSha/);
    }
  });
});
