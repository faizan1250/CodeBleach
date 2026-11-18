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

  test("v1 passes through the registered migration", () => {
    const seen: unknown[] = [];
    const registry = {
      1: (config: Record<string, unknown>) => {
        seen.push(config);
        return { ...config, migrated: true };
      },
    };
    expect(migrate({ version: 1 }, registry)).toEqual({ version: 1, migrated: true });
    expect(seen).toEqual([{ version: 1 }]);
  });

  test("missing registry entry is a clear invalid error", () => {
    expect(codeOf(() => migrate({ version: 1 }, {}))).toBe("CONFIG_INVALID");
    try {
      migrate({ version: 1 }, {});
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewerError);
      expect((error as ReviewerError).message).toContain("no migration registered");
    }
  });

  test("migration failure propagates without partial return", () => {
    const boom = new ReviewerError({ code: "CONFIG_INVALID", message: "boom" });
    const registry = {
      1: (): Record<string, unknown> => {
        throw boom;
      },
    };
    try {
      migrate({ version: 1 }, registry);
      throw new Error("expected ReviewerError");
    } catch (error) {
      expect(error).toBe(boom);
    }
  });
});
