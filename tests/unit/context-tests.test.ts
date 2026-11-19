import { describe, expect, test } from "bun:test";
import { dedupeTestSites, sortTestSites } from "../../src/context/tests.ts";
import type { TestSite } from "../../src/context/tests.ts";

function site(path: string, testName: string | null, proximity: TestSite["proximity"]): TestSite {
  return {
    path,
    testName,
    startLine: 1,
    endLine: 3,
    text: `${testName ?? "<module>"} {}`,
    reason: "test",
    evidence: "name-match",
    proximity,
  };
}

describe("dedupeTestSites", () => {
  test("collapses repeat entries from one enclosing test", () => {
    const first = site("src/a.test.ts", "check", "direct-import");
    const second = { ...first, startLine: 9 };
    expect(dedupeTestSites([first, second])).toEqual([first]);
  });

  test("keeps distinct tests and module-scope entries once per file", () => {
    const sites = [
      site("src/a.test.ts", "check", "direct-import"),
      site("src/a.test.ts", "drive", "direct-import"),
      site("src/a.test.ts", null, "other"),
    ];
    expect(dedupeTestSites(sites)).toHaveLength(3);
  });
});

describe("sortTestSites", () => {
  test("orders import evidence above weak mentions, then path", () => {
    const weak = site("src/a.test.ts", "notes", "other");
    const direct = site("src/z.test.ts", "check", "direct-import");
    const caller = site("src/m.test.ts", "run", "cross-file-caller");
    expect(sortTestSites([weak, direct, caller]).map((entry) => entry.path)).toEqual([
      "src/z.test.ts",
      "src/m.test.ts",
      "src/a.test.ts",
    ]);
  });

  test("breaks score ties by path then start line", () => {
    const second = { ...site("src/a.test.ts", "check", "other"), startLine: 9 };
    const first = site("src/a.test.ts", "check", "other");
    const remote = site("src/z.test.ts", "check", "other");
    expect(sortTestSites([remote, second, first]).map((entry) => entry.startLine)).toEqual([1, 9, 1]);
    expect(sortTestSites([remote, first])[0]?.path).toBe("src/a.test.ts");
  });
});
