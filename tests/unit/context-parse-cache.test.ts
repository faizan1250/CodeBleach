import { describe, expect, test } from "bun:test";
import { getAdapter } from "../../src/context/language.ts";
import { RunBudget } from "../../src/context/limits.ts";
import {
  callSitesFor,
  callsInRange,
  MAX_PARSE_CACHE_BYTES,
  MAX_PARSE_CACHE_ENTRIES,
  ParseCache,
} from "../../src/context/parse-cache.ts";
import { parseSource } from "../../src/context/parser.ts";
import { collectCallSites, collectCalls } from "../../src/context/adapters/shared.ts";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

const SOURCE_A =
  'import { helper } from "./util.ts";\n' +
  "export function f(x: number): number {\n" +
  "  return helper(x);\n" +
  "}\n";
const SOURCE_B =
  'import { helper } from "./util.ts";\n' +
  "export function f(x: number): number {\n" +
  "  return helper(x + 1);\n" +
  "}\n";

function input(commit: string, path: string, source: string) {
  return { commit, path, source, language: "typescript" as const, perFileMs: 2000 };
}

class CountingBudget extends RunBudget {
  calls = 0;
  override recordParse(durationMs: number): void {
    this.calls += 1;
    super.recordParse(durationMs);
  }
}

describe("p3-f04 parsed snapshot cache", () => {
  test("same commit+path+lang reuses one parse", async () => {
    const cache = new ParseCache();
    const first = await cache.getOrParse(input(COMMIT_A, "src/a.ts", SOURCE_A));
    const second = await cache.getOrParse(input(COMMIT_A, "src/a.ts", SOURCE_A));
    expect(first.status).toBe("parsed");
    expect(second.status).toBe("parsed");
    if (first.status !== "parsed" || second.status !== "parsed") return;
    expect(second.hit).toBe(true);
    expect(first.hit).toBe(false);
    expect(second.snapshot).toBe(first.snapshot);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
  });

  test("same path under two commits stays separate", async () => {
    const cache = new ParseCache();
    const head = await cache.getOrParse(input(COMMIT_A, "src/a.ts", SOURCE_A));
    const base = await cache.getOrParse(input(COMMIT_B, "src/a.ts", SOURCE_B));
    expect(head.status).toBe("parsed");
    expect(base.status).toBe("parsed");
    if (head.status !== "parsed" || base.status !== "parsed") return;
    expect(head.snapshot.source).toBe(SOURCE_A);
    expect(base.snapshot.source).toBe(SOURCE_B);
    expect(base.snapshot).not.toBe(head.snapshot);
    expect(cache.stats().entries).toBe(2);
  });

  test("base and head entries never mix", async () => {
    const cache = new ParseCache();
    await cache.getOrParse(input(COMMIT_A, "src/a.ts", SOURCE_A));
    const again = await cache.getOrParse(input(COMMIT_B, "src/a.ts", SOURCE_B));
    const headAgain = await cache.getOrParse(input(COMMIT_A, "src/a.ts", SOURCE_A));
    if (again.status !== "parsed" || headAgain.status !== "parsed") return;
    expect(again.snapshot.source).toBe(SOURCE_B);
    expect(headAgain.snapshot.source).toBe(SOURCE_A);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 2, entries: 2 });
  });

  test("changed source on one key re-parses and replaces", async () => {
    const cache = new ParseCache();
    const first = await cache.getOrParse(input(COMMIT_A, "src/a.ts", SOURCE_A));
    const second = await cache.getOrParse(input(COMMIT_A, "src/a.ts", SOURCE_B));
    const third = await cache.getOrParse(input(COMMIT_A, "src/a.ts", SOURCE_B));
    if (first.status !== "parsed" || second.status !== "parsed" || third.status !== "parsed") return;
    expect(second.snapshot.source).toBe(SOURCE_B);
    expect(third.snapshot).toBe(second.snapshot);
    expect(third.hit).toBe(true);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 2, entries: 1 });
  });

  test("cancelled parses never cache", async () => {
    const cache = new ParseCache();
    const budget = new RunBudget({ maxRunMs: 60_000, maxTotalParseMs: 0 });
    const first = await cache.getOrParse({ ...input(COMMIT_A, "src/a.ts", SOURCE_A), runBudget: budget });
    const second = await cache.getOrParse({ ...input(COMMIT_A, "src/a.ts", SOURCE_A), runBudget: budget });
    expect(first.status).toBe("cancelled");
    expect(second.status).toBe("cancelled");
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 2, entries: 0 });
  });

  test("hits skip the cumulative parse budget", async () => {
    const cache = new ParseCache();
    const budget = new CountingBudget({ maxRunMs: 60_000, maxTotalParseMs: 100_000 });
    await cache.getOrParse({ ...input(COMMIT_A, "src/a.ts", SOURCE_A), runBudget: budget });
    await cache.getOrParse({ ...input(COMMIT_A, "src/a.ts", SOURCE_A), runBudget: budget });
    await cache.getOrParse({ ...input(COMMIT_A, "src/b.ts", SOURCE_B), runBudget: budget });
    expect(budget.calls).toBe(2);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 2, entries: 2 });
  });

  test("entry cap bounds memory while serving correct data", async () => {
    const cache = new ParseCache({ maxEntries: 1 });
    const first = await cache.getOrParse(input(COMMIT_A, "src/a.ts", SOURCE_A));
    const second = await cache.getOrParse(input(COMMIT_A, "src/b.ts", SOURCE_B));
    expect(cache.stats().entries).toBe(1);
    expect(cache.stats().misses).toBe(2);
    if (first.status !== "parsed" || second.status !== "parsed") return;
    expect(first.snapshot.definitions.map((d) => d.name)).toEqual(["f"]);
    expect(second.snapshot.definitions.map((d) => d.name)).toEqual(["f"]);
  });

  test("byte cap refuses oversized entries without failing", async () => {
    const cache = new ParseCache({ maxBytes: 1 });
    const result = await cache.getOrParse(input(COMMIT_A, "src/a.ts", SOURCE_A));
    expect(result.status).toBe("parsed");
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 1, entries: 0 });
  });

  test("clear disposes entries and forces re-parse", async () => {
    const cache = new ParseCache();
    await cache.getOrParse(input(COMMIT_A, "src/a.ts", SOURCE_A));
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBeGreaterThan(0);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
    const after = await cache.getOrParse(input(COMMIT_A, "src/a.ts", SOURCE_A));
    expect(after.status).toBe("parsed");
    if (after.status !== "parsed") return;
    expect(after.hit).toBe(false);
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 2, entries: 1 });
  });

  test("snapshot extraction matches direct adapter output", async () => {
    const cache = new ParseCache();
    const result = await cache.getOrParse(input(COMMIT_A, "src/a.ts", SOURCE_A));
    expect(result.status).toBe("parsed");
    if (result.status !== "parsed") return;
    const parsed = await parseSource({ source: SOURCE_A, language: "typescript", filePath: "src/a.ts", perFileMs: 2000 });
    expect(parsed.tree).not.toBeNull();
    try {
      if (parsed.tree === null) return;
      const adapter = getAdapter("typescript");
      expect(result.snapshot.definitions).toEqual(adapter.extractDefinitions(parsed.tree, parsed.source));
      expect(result.snapshot.types).toEqual(adapter.extractTypes(parsed.tree, parsed.source));
      expect(result.snapshot.imports).toEqual(adapter.extractImports(parsed.tree, parsed.source));
      expect(result.snapshot.exports).toEqual(adapter.extractExports(parsed.tree, parsed.source));
      expect(result.snapshot.calls).toEqual(adapter.extractCalls(parsed.tree.rootNode, parsed.source));
      expect(result.snapshot.lineCount).toBe(parsed.lineCount);
      expect(result.snapshot.errorCount).toBe(parsed.errorCount);
    } finally {
      parsed.tree?.delete();
    }
  });

  test("callSitesFor matches collectCallSites", async () => {
    const cache = new ParseCache();
    const result = await cache.getOrParse(input(COMMIT_A, "src/a.ts", SOURCE_A));
    expect(result.status).toBe("parsed");
    if (result.status !== "parsed") return;
    const parsed = await parseSource({ source: SOURCE_A, language: "typescript", filePath: "src/a.ts", perFileMs: 2000 });
    expect(parsed.tree).not.toBeNull();
    try {
      if (parsed.tree === null) return;
      const expected = collectCallSites(parsed.tree.rootNode, parsed.source, { name: "helper", aliases: [] });
      expect(callSitesFor(result.snapshot.calls, ["helper"])).toEqual(expected);
    } finally {
      parsed.tree?.delete();
    }
  });

  test("callsInRange matches node-scoped extractCalls", async () => {
    const cache = new ParseCache();
    const result = await cache.getOrParse(input(COMMIT_A, "src/a.ts", SOURCE_A));
    expect(result.status).toBe("parsed");
    if (result.status !== "parsed") return;
    const parsed = await parseSource({ source: SOURCE_A, language: "typescript", filePath: "src/a.ts", perFileMs: 2000 });
    expect(parsed.tree).not.toBeNull();
    try {
      if (parsed.tree === null) return;
      const adapter = getAdapter("typescript");
      const definition = result.snapshot.definitions.find((d) => d.name === "f");
      expect(definition).toBeDefined();
      if (definition === undefined) return;
      const scoped = adapter.extractCalls(parsed.tree.rootNode, parsed.source).filter(
        (call) =>
          call.range.startIndex >= definition.fullRange.startIndex &&
          call.range.endIndex <= definition.fullRange.endIndex,
      );
      expect(callsInRange(result.snapshot.calls, definition.fullRange.startIndex, definition.fullRange.endIndex)).toEqual(
        scoped,
      );
    } finally {
      parsed.tree?.delete();
    }
  });

  test("commit keys normalize case", async () => {
    const cache = new ParseCache();
    await cache.getOrParse(input(COMMIT_A, "src/a.ts", SOURCE_A));
    const second = await cache.getOrParse(input(COMMIT_A.toUpperCase(), "src/a.ts", SOURCE_A));
    expect(second.status).toBe("parsed");
    if (second.status !== "parsed") return;
    expect(second.hit).toBe(true);
    expect(cache.stats().entries).toBe(1);
  });

  test("default caps are positive", () => {
    expect(MAX_PARSE_CACHE_ENTRIES).toBeGreaterThan(0);
    expect(MAX_PARSE_CACHE_BYTES).toBeGreaterThan(0);
  });
});
