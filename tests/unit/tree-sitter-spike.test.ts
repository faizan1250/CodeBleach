import { describe, expect, test } from "bun:test";
import { runTreeSitterSpike } from "../../scripts/tree-sitter-spike.ts";

describe("tree-sitter spike", () => {
  test("pinned runtime parses typescript tsx javascript", async () => {
    const result = await runTreeSitterSpike();
    expect(result.languageVersion).toBe(15);
    expect(result.minCompatibleVersion).toBe(13);
    expect(result.grammars.map((g) => g.language)).toEqual(["typescript", "tsx", "javascript"]);
    for (const grammar of result.grammars) {
      expect(grammar.abiVersion).toBeGreaterThanOrEqual(13);
      expect(grammar.abiVersion).toBeLessThanOrEqual(15);
      expect(grammar.hasError).toBe(false);
      expect(grammar.rootType).toBe("program");
      expect(grammar.sexpr).toContain("function_declaration");
    }
    const byLanguage = Object.fromEntries(result.grammars.map((g) => [g.language, g]));
    expect(byLanguage["tsx"]?.sexpr).toContain("jsx_element");
  });

  test("spike is deterministic", async () => {
    const first = await runTreeSitterSpike();
    const second = await runTreeSitterSpike();
    expect(second).toEqual(first);
  });
});
