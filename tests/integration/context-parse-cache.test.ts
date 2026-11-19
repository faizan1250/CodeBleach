import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import { createLogger } from "../../src/core/logger.ts";
import { resolveCalleesForSymbol } from "../../src/context/calls.ts";
import { resolveCallersForSymbol } from "../../src/context/callers.ts";
import { ContextEngineImpl } from "../../src/context/engine.ts";
import { ParseCache } from "../../src/context/parse-cache.ts";
import { SnapshotReader } from "../../src/context/snapshot.ts";
import { resolveTestsForSymbol } from "../../src/context/tests.ts";
import { GitDiffEngine } from "../../src/diff/git.ts";
import type { ChangedSymbol } from "../../src/types/diff.ts";
import { ReviewerError } from "../../src/core/errors.ts";
import { git, makeRepo } from "../helpers/git-repo.ts";

function logger() {
  return createLogger({ level: "error", runId: "p3-f04-test" });
}

async function writeAndCommit(dir: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", message, "--quiet"]);
  return git(dir, ["rev-parse", "HEAD"]);
}

const UTIL = "export function helper(x: number): number {\n  return x + 1;\n}\n";
const A_BASE =
  'import { helper } from "./util.ts";\n' +
  "export function f(x: number): number {\n" +
  "  return helper(x);\n" +
  "}\n" +
  "export function g(x: number): number {\n" +
  "  return helper(x * 2);\n" +
  "}\n";
const A_HEAD =
  'import { helper } from "./util.ts";\n' +
  "export function f(x: number): number {\n" +
  "  return helper(x + 1);\n" +
  "}\n" +
  "export function g(x: number): number {\n" +
  "  return helper(x * 3);\n" +
  "}\n";
const MAIN =
  'import { f } from "./a.ts";\n' + "export function main(): number {\n" + "  return f(1);\n" + "}\n";
const A_TEST =
  'import { f } from "./a.ts";\n' +
  "import { strict as assert } from \"node:assert\";\n" +
  "export function checkF(): void {\n" +
  "  assert.equal(f(1), 3);\n" +
  "}\n";

function symbolFor(name: string, startLine: number, endLine: number): ChangedSymbol {
  return { name, kind: "function", startLine, endLine, changedLines: [startLine + 1] };
}

describe("p3-f04 parse cache integration", () => {
  test("shared cache matches uncached resolver output", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const headSha = await writeAndCommit(
        dir,
        { "src/a.ts": A_HEAD, "src/util.ts": UTIL, "src/main.ts": MAIN, "src/a.test.ts": A_TEST },
        "head",
      );
      const reader = new SnapshotReader({ repoRoot: dir, headSha, mergeBase: headSha });
      const symbol = symbolFor("f", 2, 4);
      const shared = new ParseCache();

      const uncachedCallees = await resolveCalleesForSymbol({ filePath: "src/a.ts", symbol, reader });
      const cachedCallees = await resolveCalleesForSymbol({ filePath: "src/a.ts", symbol, reader, parseCache: shared });
      expect(cachedCallees).toEqual(uncachedCallees);
      expect(cachedCallees.callees.length).toBeGreaterThan(0);

      const uncachedCallers = await resolveCallersForSymbol({ filePath: "src/a.ts", symbol, reader });
      const cachedCallers = await resolveCallersForSymbol({ filePath: "src/a.ts", symbol, reader, parseCache: shared });
      expect(cachedCallers).toEqual(uncachedCallers);
      expect(cachedCallers.callers.length).toBeGreaterThan(0);

      const uncachedTests = await resolveTestsForSymbol({ filePath: "src/a.ts", symbol, reader });
      const cachedTests = await resolveTestsForSymbol({ filePath: "src/a.ts", symbol, reader, parseCache: shared });
      expect(cachedTests).toEqual(uncachedTests);
      expect(cachedTests.tests.length).toBeGreaterThan(0);
      expect(shared.stats().hits).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  test("engine reuses snapshots and reports cache stats", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const baseSha = await writeAndCommit(
        dir,
        { "src/a.ts": A_BASE, "src/util.ts": UTIL, "src/main.ts": MAIN, "src/a.test.ts": A_TEST },
        "base",
      );
      const headSha = await writeAndCommit(
        dir,
        { "src/a.ts": A_HEAD, "src/util.ts": UTIL, "src/main.ts": MAIN, "src/a.test.ts": A_TEST },
        "head",
      );
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      const result = await new ContextEngineImpl({ logger: logger() }).build(diff, config, dir);
      expect(result.units.length).toBe(2);
      expect(result.diagnostics.parseCacheHits).toBeGreaterThan(0);
      expect(result.diagnostics.parseCacheMisses).toBeGreaterThan(0);
      expect(result.diagnostics.parseCacheEntries).toBeGreaterThan(0);
      const kinds = result.units.flatMap((unit) => unit.context.map((item) => item.kind));
      expect(kinds).toContain("callee");
      expect(kinds).toContain("caller");
      expect(kinds).toContain("test");
    } finally {
      await cleanup();
    }
  });

  test("repeated builds emit identical units with no cross-run persistence", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const baseSha = await writeAndCommit(dir, { "src/a.ts": A_BASE, "src/util.ts": UTIL }, "base");
      const headSha = await writeAndCommit(dir, { "src/a.ts": A_HEAD, "src/util.ts": UTIL }, "head");
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      const engine = new ContextEngineImpl({ logger: logger() });
      const first = await engine.build(diff, config, dir);
      const second = await engine.build(diff, config, dir);
      expect(second.units).toEqual(first.units);
      expect(second.status).toBe(first.status);
      expect(second.diagnostics.parseCacheMisses).toBeGreaterThan(0);
      expect(second.diagnostics.unitsCreated).toBe(first.diagnostics.unitsCreated);
    } finally {
      await cleanup();
    }
  });

  test("head definitions come from the head snapshot, never base", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const baseSha = await writeAndCommit(dir, { "src/a.ts": A_BASE, "src/util.ts": UTIL }, "base");
      const headSha = await writeAndCommit(dir, { "src/a.ts": A_HEAD, "src/util.ts": UTIL }, "head");
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      const result = await new ContextEngineImpl({ logger: logger() }).build(diff, config, dir);
      const f = result.units.find((unit) => unit.symbol.name === "f");
      expect(f).toBeDefined();
      const definition = f?.context.find((item) => item.kind === "definition");
      expect(definition?.text).toContain("helper(x + 1)");
      expect(definition?.text).not.toContain("helper(x)");
    } finally {
      await cleanup();
    }
  });

  test("failed run cleans up and rebuilds identically", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const baseSha = await writeAndCommit(dir, { "src/a.ts": A_BASE, "src/util.ts": UTIL }, "base");
      const headSha = await writeAndCommit(dir, { "src/a.ts": A_HEAD, "src/util.ts": UTIL }, "head");
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      const failing = new ContextEngineImpl({
        logger: logger(),
        resolvers: {
          resolveCallersForSymbol: (async (): Promise<never> => {
            throw new ReviewerError({
              code: "GIT_FAILED",
              message: "injected git timeout",
              cause: { reason: "timeout", timeoutMs: 30_000 },
            });
          }) as never,
        },
      });
      const failed = await failing.build(diff, config, dir);
      expect(failed.status).toBe("partial");
      expect(failed.diagnostics.queryTimeouts).toBeGreaterThan(0);
      const engine = new ContextEngineImpl({ logger: logger() });
      const rebuilt = await engine.build(diff, config, dir);
      const fresh = await new ContextEngineImpl({ logger: logger() }).build(diff, config, dir);
      expect(rebuilt.units).toEqual(fresh.units);
      expect(rebuilt.units.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });
});
