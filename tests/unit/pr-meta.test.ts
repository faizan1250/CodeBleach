import { describe, expect, test } from "bun:test";
import { assertPrMetaMatchesDiff, resolvePrMetaFromEnv } from "../../src/github/pr-meta.ts";
import { ReviewerError } from "../../src/core/errors.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

function envWith(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    GITHUB_REPOSITORY: "o/r",
    CODEBLEACH_PR_NUMBER: "1",
    CODEBLEACH_BASE_SHA: BASE,
    CODEBLEACH_HEAD_SHA: HEAD,
    ...overrides,
  };
}

describe("pr-meta resolution", () => {
  test("returns null when no PR env present", () => {
    expect(resolvePrMetaFromEnv({})).toBeNull();
  });

  test("resolves valid metadata", () => {
    expect(resolvePrMetaFromEnv(envWith({}))).toEqual({
      owner: "o",
      repo: "r",
      number: 1,
      baseSha: BASE,
      headSha: HEAD,
    });
  });

  test("rejects incomplete sets", () => {
    const error = (() => {
      try {
        resolvePrMetaFromEnv(envWith({ CODEBLEACH_HEAD_SHA: undefined }));
        return null;
      } catch (failure) {
        return failure as ReviewerError;
      }
    })();
    expect(error).toBeInstanceOf(ReviewerError);
    expect((error as ReviewerError).code).toBe("CONFIG_INVALID");
  });

  test("rejects malformed repository, number, and SHAs", () => {
    for (const bad of [
      envWith({ GITHUB_REPOSITORY: "owner-only" }),
      envWith({ GITHUB_REPOSITORY: "o/r/extra" }),
      envWith({ CODEBLEACH_PR_NUMBER: "0" }),
      envWith({ CODEBLEACH_PR_NUMBER: "abc" }),
      envWith({ CODEBLEACH_BASE_SHA: "short" }),
      envWith({ CODEBLEACH_HEAD_SHA: "z".repeat(40) }),
    ]) {
      const error = (() => {
        try {
          resolvePrMetaFromEnv(bad);
          return null;
        } catch (failure) {
          return failure as ReviewerError;
        }
      })();
      expect(error).toBeInstanceOf(ReviewerError);
      expect((error as unknown as ReviewerError).code).toBe("CONFIG_INVALID");
    }
  });

  test("diff SHA mismatch fails closed", () => {
    const pr = resolvePrMetaFromEnv(envWith({}))!;
    expect(() => assertPrMetaMatchesDiff(pr, BASE, HEAD)).not.toThrow();
    const mismatch = (() => {
      try {
        assertPrMetaMatchesDiff(pr, BASE, "c".repeat(40));
        return null;
      } catch (failure) {
        return failure as ReviewerError;
      }
    })();
    expect(mismatch).toBeInstanceOf(ReviewerError);
    expect((mismatch as ReviewerError).code).toBe("CONFIG_INVALID");
  });
});
