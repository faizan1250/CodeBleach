import { describe, expect, test } from "bun:test";
import { ReviewerError } from "../../src/core/errors.ts";
import { migrate } from "../../src/config/migrate.ts";

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewerError);
    return (error as ReviewerError).code;
  }
  throw new Error("expected ReviewerError");
}

describe("migrate", () => {
  test("missing version means v1 passthrough", () => {
    expect(migrate({ review: {} })).toEqual({ review: {} });
  });

  test("version 1 passes through", () => {
    expect(migrate({ version: 1 })).toEqual({ version: 1 });
  });

  test("version above supported fails unsupported", () => {
    expect(codeOf(() => migrate({ version: 2 }))).toBe("CONFIG_UNSUPPORTED_VERSION");
  });

  test("non-object root and bad version fail invalid", () => {
    expect(codeOf(() => migrate(null))).toBe("CONFIG_INVALID");
    expect(codeOf(() => migrate([1]))).toBe("CONFIG_INVALID");
    expect(codeOf(() => migrate("v1"))).toBe("CONFIG_INVALID");
    expect(codeOf(() => migrate({ version: "1" }))).toBe("CONFIG_INVALID");
    expect(codeOf(() => migrate({ version: 0 }))).toBe("CONFIG_INVALID");
  });
});
