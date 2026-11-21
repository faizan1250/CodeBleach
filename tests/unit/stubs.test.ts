import { describe, expect, test } from "bun:test";
import {
  stubContextEngine,
  stubDiffEngine,
  stubPublisher,
  stubReviewEngine,
  stubValidationEngine,
} from "../../src/core/stubs.ts";
import type { ValidatedFinding } from "../../src/types/index.ts";
import { ReviewerError } from "../../src/core/errors.ts";

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewerError);
    return (error as ReviewerError).code;
  }
  throw new Error("expected ReviewerError");
}

describe("stub engines", () => {
  test("every stub throws NOT_IMPLEMENTED", async () => {
    const empty = { files: [], baseSha: "b", headSha: "h", mergeBase: "b" };
    await expect(
      codeOf(stubDiffEngine.run({ repoDir: ".", baseSha: "b", headSha: "h", config: {} as never })),
    ).resolves.toBe("NOT_IMPLEMENTED");
    await expect(codeOf(stubContextEngine.build(empty, {} as never, "."))).resolves.toBe("NOT_IMPLEMENTED");
    await expect(codeOf(stubReviewEngine.review([], {} as never))).resolves.toBe("NOT_IMPLEMENTED");
    await expect(codeOf(stubValidationEngine.validate([], empty, [], {} as never))).resolves.toBe("NOT_IMPLEMENTED");
    await expect(
      codeOf(stubPublisher.publish([], empty, { owner: "o", repo: "r", number: 1, baseSha: "b", headSha: "h" })),
    ).resolves.toBe("NOT_IMPLEMENTED");
  });

  test("publisher rejects non-narrowed findings at compile time", async () => {
    const empty = { files: [], baseSha: "b", headSha: "h", mergeBase: "b" };
    const meta = { owner: "o", repo: "r", number: 1, baseSha: "b", headSha: "h" };
    const mixed: ValidatedFinding[] = [];
    await expect(
      // @ts-expect-error publisher accepts only accepted findings
      codeOf(stubPublisher.publish(mixed, empty, meta)),
    ).resolves.toBe("NOT_IMPLEMENTED");
  });
});
