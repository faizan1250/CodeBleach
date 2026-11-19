import { describe, expect, test } from "bun:test";
import {
  BASE_WEIGHTS,
  PROXIMITY_MULTIPLIERS,
  baseWeightForKind,
  decayFactor,
  proximityMultiplier,
  rankContextItems,
  type RankInput,
} from "../../src/context/rank.ts";
import type { ContextItem } from "../../src/types/context.ts";

function item(overrides: Partial<ContextItem> & { id: string }): ContextItem {
  return {
    kind: "callee",
    file: "src/a.ts",
    startLine: 1,
    endLine: 2,
    text: "text",
    score: 0,
    tokens: 10,
    reason: "test",
    ...overrides,
  };
}

describe("context ranking", () => {
  test("documents base weights", () => {
    expect(BASE_WEIGHTS).toEqual({ definition: 100, type: 85, callee: 75, caller: 65, test: 55 });
    expect(baseWeightForKind("definition")).toBe(100);
    expect(baseWeightForKind("type")).toBe(85);
    expect(baseWeightForKind("callee")).toBe(75);
    expect(baseWeightForKind("caller")).toBe(65);
    expect(baseWeightForKind("test")).toBe(55);
  });

  test("documents proximity multipliers", () => {
    expect(PROXIMITY_MULTIPLIERS).toEqual({
      "same-file": 1,
      "direct-import": 0.85,
      "cross-file-caller": 0.75,
      "same-dir-test": 0.55,
      other: 0.5,
    });
    expect(proximityMultiplier("same-file")).toBe(1);
    expect(proximityMultiplier("direct-import")).toBe(0.85);
  });

  test("reference-count decay is deterministic and penalizes ubiquity", () => {
    expect(decayFactor(1)).toBe(1);
    expect(decayFactor(2)).toBeLessThan(1);
    expect(decayFactor(2)).toBeGreaterThan(decayFactor(5));
    expect(decayFactor(3)).toBe(decayFactor(3));
  });

  test("identical input produces identical ordering", () => {
    const inputs: RankInput[] = [
      { item: item({ id: "b", kind: "caller", file: "src/b.ts", startLine: 20 }), proximity: "cross-file-caller" },
      { item: item({ id: "a", kind: "callee", file: "src/a.ts", startLine: 10 }), proximity: "same-file" },
      { item: item({ id: "c", kind: "test", file: "src/c.test.ts", startLine: 5 }), proximity: "same-dir-test" },
    ];
    const first = rankContextItems(inputs).map((i) => i.id);
    const second = rankContextItems(inputs).map((i) => i.id);
    expect(first).toEqual(second);
    expect(first[0]).toBe("a");
  });

  test("ties fall back to kind priority then path then line then id", () => {
    const mk = (id: string, kind: ContextItem["kind"], file: string, startLine: number): RankInput => ({
      item: item({ id, kind, file, startLine }),
      proximity: "same-file",
    });
    const ranked = rankContextItems([
      mk("t2", "test", "src/b.ts", 1),
      mk("t1", "test", "src/a.ts", 1),
      mk("c1", "callee", "src/z.ts", 1),
    ]).map((i) => i.id);
    expect(ranked).toEqual(["c1", "t1", "t2"]);
  });

  test("same score and kind orders by start line then id", () => {
    const mk = (id: string, startLine: number): RankInput => ({
      item: item({ id, kind: "test", file: "src/a.ts", startLine }),
      proximity: "same-dir-test",
    });
    const ranked = rankContextItems([mk("b", 10), mk("a", 10), mk("c", 5)]).map((i) => i.id);
    expect(ranked).toEqual(["c", "a", "b"]);
  });
});
