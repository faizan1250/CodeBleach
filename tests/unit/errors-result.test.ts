import { describe, expect, test } from "bun:test";
import { ReviewerError } from "../../src/core/errors.ts";
import { err, ok } from "../../src/core/result.ts";

describe("reviewer error", () => {
  test("preserves code, message, retryable, cause", () => {
    const cause = new Error("disk gone");
    const error = new ReviewerError({
      code: "GIT_FAILED",
      message: "git diff failed",
      retryable: true,
      cause,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ReviewerError");
    expect(error.code).toBe("GIT_FAILED");
    expect(error.message).toBe("git diff failed");
    expect(error.retryable).toBe(true);
    expect(error.cause).toBe(cause);
  });

  test("retryable defaults to false", () => {
    const error = new ReviewerError({ code: "INTERNAL", message: "boom" });
    expect(error.retryable).toBe(false);
    expect(error.cause).toBeUndefined();
  });
});

describe("result", () => {
  test("ok carries value", () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });

  test("err carries error", () => {
    const failure = new ReviewerError({ code: "PARSE_FAILED", message: "bad" });
    const result = err(failure);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(failure);
  });
});
