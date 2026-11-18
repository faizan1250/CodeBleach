import { describe, expect, test } from "bun:test";

describe("bootstrap", () => {
  test("package metadata matches repo", async () => {
    const pkg = (await Bun.file("package.json").json()) as { name: unknown; version: unknown };
    expect(pkg.name).toBe("codebleach");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
