import { describe, expect, test } from "bun:test";

describe("types barrel isolation", () => {
  test("src/types imports nothing from other src directories", async () => {
    const glob = new Bun.Glob("src/types/*.ts");
    const files: string[] = [];
    for await (const file of glob.scan(".")) files.push(file);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = await Bun.file(file).text();
      expect(text).not.toContain("../");
      expect(text).not.toContain("@/");
      expect(text).not.toContain("from \"src/");
    }
  });

  test("barrel re-exports shared contracts", async () => {
    const index = await import("../../src/types/index.ts");
    expect(typeof index.RawFindingSchema).toBe("object");
    expect(typeof index.LlmVerdictSchema).toBe("object");
  });
});
