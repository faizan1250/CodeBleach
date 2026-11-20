import { describe, expect, test } from "bun:test";
import { ReviewerError } from "../../src/core/errors.ts";
import { resolveRepoRoot, resolveRevision } from "../../src/diff/revisions.ts";

describe("resolveRevision pre-git validation", () => {
  test("rejects dash-prefixed revisions as INVALID_INPUT without running git", async () => {
    let caught: unknown = null;
    try {
      await resolveRevision("no-such-dir", "--verify", "baseSha");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReviewerError);
    expect((caught as ReviewerError).code).toBe("INVALID_INPUT");
  });

  test("rejects empty revisions as INVALID_INPUT without running git", async () => {
    let caught: unknown = null;
    try {
      await resolveRevision("no-such-dir", "", "headSha");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReviewerError);
    expect((caught as ReviewerError).code).toBe("INVALID_INPUT");
  });
});

describe("resolveRepoRoot pre-git validation", () => {
  test("rejects empty repoDir as GIT_FAILED without running git", async () => {
    let caught: unknown = null;
    try {
      await resolveRepoRoot("");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReviewerError);
    expect((caught as ReviewerError).code).toBe("GIT_FAILED");
  });
});
