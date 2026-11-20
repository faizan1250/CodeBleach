import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "../../src/core/logger.ts";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import { ContextEngineImpl } from "../../src/context/engine.ts";
import { resolveTestsForSymbol } from "../../src/context/tests.ts";
import { SnapshotReader } from "../../src/context/snapshot.ts";
import { GitDiffEngine } from "../../src/diff/git.ts";
import type { ChangedSymbol, SymbolKind } from "../../src/types/diff.ts";
import { git, makeRepo } from "../helpers/git-repo.ts";

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

async function setupRepo(files: Record<string, string>): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
  commit: string;
}> {
  const { dir, cleanup } = await makeRepo();
  try {
    const commit = await writeAndCommit(dir, files, "head");
    return { dir, cleanup, commit };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function readerFor(dir: string, commit: string): SnapshotReader {
  return new SnapshotReader({ repoRoot: dir, headSha: commit, mergeBase: commit });
}

function symbolFor(name: string, kind: SymbolKind, startLine: number, endLine: number): ChangedSymbol {
  return { name, kind, startLine, endLine, changedLines: [startLine] };
}

const GREET = 'export function greet(): string {\n  return "hi";\n}\n';

describe("context test discovery from commit snapshots", () => {
  test("test importing the changed module ranks first", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/util.ts": GREET,
      "src/util.test.ts":
        'import { greet } from "./util";\n' +
        "export function check(): boolean {\n" +
        '  return greet() === "hi";\n' +
        "}\n" +
        "// filler\n".repeat(7) +
        "export function late(): number {\n" +
        "  return 1;\n" +
        "}\n",
    });
    try {
      const { tests, diagnostics } = await resolveTestsForSymbol({
        filePath: "src/util.ts",
        symbol: symbolFor("greet", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(diagnostics).toEqual([]);
      expect(tests).toHaveLength(1);
      expect(tests[0]).toMatchObject({
        path: "src/util.test.ts",
        evidence: "imports-file",
        proximity: "direct-import",
        reason: "test imports changed module (relative import)",
      });
      expect(tests[0]?.text).toContain("check");
      expect(tests[0]?.text).not.toContain("late");
    } finally {
      await cleanup();
    }
  });

  test("test importing the symbol through a barrel resolves", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/real.ts": GREET,
      "src/barrel.ts": 'export { greet } from "./real";\n',
      "src/app.test.ts": 'import { greet } from "./barrel";\nexport function run(): string {\n  return greet();\n}\n',
    });
    try {
      const { tests } = await resolveTestsForSymbol({
        filePath: "src/real.ts",
        symbol: symbolFor("greet", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(tests).toHaveLength(1);
      expect(tests[0]).toMatchObject({
        path: "src/app.test.ts",
        evidence: "imports-symbol",
        reason: "test imports changed symbol via barrel re-export",
      });
    } finally {
      await cleanup();
    }
  });

  test("test calling the symbol without an import is a code reference", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/util.ts": GREET,
      "src/late.test.ts": "export function run(): string {\n  return greet();\n}\n",
    });
    try {
      const { tests } = await resolveTestsForSymbol({
        filePath: "src/util.ts",
        symbol: symbolFor("greet", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(tests).toHaveLength(1);
      expect(tests[0]).toMatchObject({
        path: "src/late.test.ts",
        evidence: "refs-symbol",
        testName: "run",
        reason: "test calls changed symbol (AST-verified)",
      });
    } finally {
      await cleanup();
    }
  });

  test("__tests__ directory test importing the module is found", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/util.ts": GREET,
      "src/__tests__/util.test.ts":
        'import { greet } from "../util";\nexport function run(): string {\n  return greet();\n}\n',
    });
    try {
      const { tests } = await resolveTestsForSymbol({
        filePath: "src/util.ts",
        symbol: symbolFor("greet", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(tests).toHaveLength(1);
      expect(tests[0]).toMatchObject({ path: "src/__tests__/util.test.ts", evidence: "imports-file" });
    } finally {
      await cleanup();
    }
  });

  test("colocated base-name match without imports is a heuristic candidate", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/util.ts": GREET,
      "src/util.test.ts": "export function checkShape(): boolean {\n  return true;\n}\n",
    });
    try {
      const { tests } = await resolveTestsForSymbol({
        filePath: "src/util.ts",
        symbol: symbolFor("greet", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(tests).toHaveLength(1);
      expect(tests[0]).toMatchObject({
        path: "src/util.test.ts",
        evidence: "name-match",
        reason: "test file name matches changed file (heuristic)",
      });
    } finally {
      await cleanup();
    }
  });

  test("unrelated test file without evidence is excluded", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/util.ts": GREET,
      "src/other.test.ts": "export function checkOther(): boolean {\n  return true;\n}\n",
    });
    try {
      const { tests } = await resolveTestsForSymbol({
        filePath: "src/util.ts",
        symbol: symbolFor("greet", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(tests).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("comment/string-only mention ranks below an AST-confirmed import", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/util.ts": GREET,
      "src/a.test.ts":
        'import { greet } from "./util";\nexport function check(): boolean {\n  return greet() === "hi";\n}\n',
      "src/z.test.ts": '// greet is covered elsewhere\nexport function notes(): string {\n  return "greet";\n}\n',
    });
    try {
      const { tests } = await resolveTestsForSymbol({
        filePath: "src/util.ts",
        symbol: symbolFor("greet", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(tests.map((entry) => entry.path)).toEqual(["src/a.test.ts", "src/z.test.ts"]);
      expect(tests[0]).toMatchObject({ evidence: "imports-file" });
      expect(tests[1]).toMatchObject({
        evidence: "weak-mention",
        reason: "symbol mention outside executable code (weak evidence)",
      });
    } finally {
      await cleanup();
    }
  });

  test("test cap keeps ranked sites and reports the rest", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/util.ts": GREET,
      "src/a.test.ts":
        'import { greet } from "./util";\nexport function check(): boolean {\n  return greet() === "hi";\n}\n',
      "src/z.test.ts": '// greet is covered elsewhere\nexport function notes(): string {\n  return "greet";\n}\n',
    });
    try {
      const { tests, diagnostics } = await resolveTestsForSymbol({
        filePath: "src/util.ts",
        symbol: symbolFor("greet", "function", 1, 3),
        reader: readerFor(dir, commit),
        maxTests: 1,
      });
      expect(tests.map((entry) => entry.path)).toEqual(["src/a.test.ts"]);
      expect(diagnostics).toContainEqual({
        filePath: "src/util.ts",
        symbol: "greet",
        candidate: "src/z.test.ts:<module>",
        reason: "cap-reached",
      });
    } finally {
      await cleanup();
    }
  });

  test("test discovery is deterministic across runs", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/util.ts": GREET,
      "src/a.test.ts":
        'import { greet } from "./util";\nexport function check(): boolean {\n  return greet() === "hi";\n}\n',
      "src/z.test.ts": '// greet is covered elsewhere\nexport function notes(): string {\n  return "greet";\n}\n',
    });
    try {
      const options = {
        filePath: "src/util.ts",
        symbol: symbolFor("greet", "function", 1, 3),
        reader: readerFor(dir, commit),
      };
      const first = await resolveTestsForSymbol(options);
      const second = await resolveTestsForSymbol({ ...options, reader: readerFor(dir, commit) });
      expect(second).toEqual(first);
    } finally {
      await cleanup();
    }
  });

  test("exhausted parse budget yields no tests without failing", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/util.ts": GREET,
      "src/util.test.ts":
        'import { greet } from "./util";\nexport function check(): boolean {\n  return greet() === "hi";\n}\n',
    });
    try {
      const { tests, diagnostics } = await resolveTestsForSymbol({
        filePath: "src/util.ts",
        symbol: symbolFor("greet", "function", 1, 3),
        reader: readerFor(dir, commit),
        perFileMs: 0,
      });
      expect(tests).toEqual([]);
      expect(diagnostics.map((entry) => entry.reason)).toContain("parse-cancelled");
    } finally {
      await cleanup();
    }
  });

  test("tests come from headSha, not the worktree", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/util.ts": GREET,
      "src/app.test.ts":
        'import { greet } from "./util";\nexport function check(): boolean {\n  return greet() === "hi";\n}\n',
    });
    try {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "app.test.ts"), "export function check(): boolean {\n  return true;\n}\n");
      await writeFile(join(dir, "src", "extra.test.ts"), "// greet\n");
      const { tests } = await resolveTestsForSymbol({
        filePath: "src/util.ts",
        symbol: symbolFor("greet", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(tests.map((entry) => entry.path)).toEqual(["src/app.test.ts"]);
      expect(tests[0]).toMatchObject({ evidence: "imports-file" });
    } finally {
      await cleanup();
    }
  });

  test("unsupported language returns no tests without failing", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/data.py": "def x():\n    return 1\n",
    });
    try {
      const { tests, diagnostics } = await resolveTestsForSymbol({
        filePath: "src/data.py",
        symbol: symbolFor("x", "function", 1, 2),
        reader: readerFor(dir, commit),
      });
      expect(tests).toEqual([]);
      expect(diagnostics).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("engine unit includes the related test item", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const baseSha = await writeAndCommit(
        dir,
        {
          "src/util.ts": GREET,
          "src/app.test.ts":
            'import { greet } from "./util";\nexport function check(): boolean {\n  return greet() === "hi";\n}\n',
        },
        "base",
      );
      const headSha = await writeAndCommit(
        dir,
        {
          "src/util.ts": 'export function greet(): string {\n  return "hello";\n}\n',
          "src/app.test.ts":
            'import { greet } from "./util";\nexport function check(): boolean {\n  return greet() === "hi";\n}\n',
        },
        "head",
      );
      const logger = createLogger({ level: "error", runId: "p3-f01-test" });
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger }).run({ repoDir: dir, baseSha, headSha, config });
      const result = await new ContextEngineImpl({ logger }).build(diff, config, dir);
      expect(result.units).toHaveLength(1);
      const kinds = result.units[0]?.context.map((item) => item.kind) ?? [];
      expect(kinds).toContain("definition");
      expect(kinds).toContain("test");
      const testItem = result.units[0]?.context.find((item) => item.kind === "test");
      expect(testItem).toMatchObject({
        file: "src/app.test.ts",
        reason: "test imports changed module (relative import)",
      });
      expect(testItem?.score).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });
});
