import { describe, expect, test } from "bun:test";
import { ruleAppliesToFile, selectRulesForFile } from "../../src/context/rules.ts";
import type { Rule } from "../../src/types/rules.ts";

function rule(overrides: Partial<Rule> & { id: string }): Rule {
  return {
    kind: "convention",
    text: `text for ${overrides.id}`,
    ...overrides,
  };
}

describe("explicit rule selection", () => {
  test("repo-wide rule applies to every file", () => {
    const rules = [rule({ id: "global" })];
    expect(selectRulesForFile(rules, "src/a.ts").map((r) => r.id)).toEqual(["global"]);
    expect(selectRulesForFile(rules, "docs/readme.md").map((r) => r.id)).toEqual(["global"]);
  });

  test("path-scoped rule applies only to matching paths", () => {
    const rules = [rule({ id: "src-only", paths: ["src/**"] })];
    expect(selectRulesForFile(rules, "src/a.ts").map((r) => r.id)).toEqual(["src-only"]);
    expect(selectRulesForFile(rules, "docs/a.md")).toEqual([]);
  });

  test("rule matches when any pattern matches", () => {
    const rules = [rule({ id: "multi", paths: ["docs/**", "src/**"] })];
    expect(selectRulesForFile(rules, "docs/a.md").map((r) => r.id)).toEqual(["multi"]);
    expect(selectRulesForFile(rules, "src/a.ts").map((r) => r.id)).toEqual(["multi"]);
    expect(selectRulesForFile(rules, "test/a.ts")).toEqual([]);
  });

  test("preserves configuration order", () => {
    const rules = [rule({ id: "b", paths: ["src/**"] }), rule({ id: "a" }), rule({ id: "c", paths: ["src/**"] })];
    expect(selectRulesForFile(rules, "src/x.ts").map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  test("preserves rule identity verbatim", () => {
    const original = rule({ id: "keep", kind: "security", text: "exact text", severity: "high" });
    const selected = selectRulesForFile([original], "src/x.ts");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toBe(original);
    expect(selected[0]?.id).toBe("keep");
    expect(selected[0]?.text).toBe("exact text");
  });

  test("empty rules produce empty array", () => {
    expect(selectRulesForFile([], "src/x.ts")).toEqual([]);
  });

  test("empty paths array is repo-wide", () => {
    const rules = [rule({ id: "empty-paths", paths: [] })];
    expect(selectRulesForFile(rules, "any/file.ts").map((r) => r.id)).toEqual(["empty-paths"]);
  });

  test("generates no inferred rules", () => {
    const rules = [rule({ id: "scoped", paths: ["src/**"] }), rule({ id: "global" })];
    const selected = selectRulesForFile(rules, "other/file.ts");
    expect(selected.map((r) => r.id)).toEqual(["global"]);
    for (const item of selected) {
      expect(rules.includes(item)).toBe(true);
    }
  });

  test("predicate mirrors selection", () => {
    expect(ruleAppliesToFile(rule({ id: "g" }), "a/b.ts")).toBe(true);
    expect(ruleAppliesToFile(rule({ id: "s", paths: ["src/**"] }), "src/a.ts")).toBe(true);
    expect(ruleAppliesToFile(rule({ id: "s", paths: ["src/**"] }), "docs/a.md")).toBe(false);
  });
});
