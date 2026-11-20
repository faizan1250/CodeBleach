import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCalleesForSymbol } from "../../src/context/calls.ts";
import { SnapshotReader } from "../../src/context/snapshot.ts";
import type { ChangedSymbol, SymbolKind } from "../../src/types/diff.ts";
import { commitIndex, git, makeRepo } from "../helpers/git-repo.ts";

async function writeIndexed(dir: string, outside: string, repoPath: string, content: string): Promise<void> {
  const staging = join(outside, Buffer.from(repoPath).toString("hex"));
  await writeFile(staging, content);
  const blob = await git(dir, ["hash-object", "-w", staging]);
  await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${blob},${repoPath}`]);
}

async function setupRepo(files: Record<string, string>): Promise<{
  dir: string;
  outside: string;
  cleanup: () => Promise<void>;
  commit: string;
}> {
  const { dir, cleanup } = await makeRepo();
  const outside = await mkdtemp(join(tmpdir(), "codebleach-cal-"));
  const cleanupBoth = async (): Promise<void> => {
    await rm(outside, { recursive: true, force: true });
    await cleanup();
  };
  try {
    for (const [repoPath, content] of Object.entries(files)) {
      await writeIndexed(dir, outside, repoPath, content);
    }
    const commit = await commitIndex(dir, "head");
    return { dir, outside, cleanup: cleanupBoth, commit };
  } catch (error) {
    await cleanupBoth();
    throw error;
  }
}

function readerFor(dir: string, commit: string): SnapshotReader {
  return new SnapshotReader({ repoRoot: dir, headSha: commit, mergeBase: commit });
}

function symbolFor(name: string, kind: SymbolKind, startLine: number, endLine: number): ChangedSymbol {
  return { name, kind, startLine, endLine, changedLines: [startLine] };
}

describe("context callee discovery from commit snapshots", () => {
  test("local direct function call resolves in the same file", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/a.ts":
        "export function helper(): number {\n  return 1;\n}\nexport function run(): number {\n  return helper();\n}\n",
    });
    try {
      const { callees, diagnostics } = await resolveCalleesForSymbol({
        filePath: "src/a.ts",
        symbol: symbolFor("run", "function", 4, 6),
        reader: readerFor(dir, commit),
      });
      expect(diagnostics).toEqual([]);
      expect(callees).toHaveLength(1);
      expect(callees[0]).toMatchObject({
        name: "helper",
        kind: "function",
        path: "src/a.ts",
        startLine: 1,
        reason: "local direct call",
      });
    } finally {
      await cleanup();
    }
  });

  test("imported named function call resolves to the target definition", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/app.ts": 'import { greet } from "./util";\nexport function run(): string {\n  return greet();\n}\n',
      "src/util.ts": 'export function greet(): string {\n  return "hi";\n}\n',
    });
    try {
      const { callees, diagnostics } = await resolveCalleesForSymbol({
        filePath: "src/app.ts",
        symbol: symbolFor("run", "function", 2, 4),
        reader: readerFor(dir, commit),
      });
      expect(diagnostics).toEqual([]);
      expect(callees).toHaveLength(1);
      expect(callees[0]).toMatchObject({
        name: "greet",
        path: "src/util.ts",
        startLine: 1,
        reason: "relative named import",
      });
      expect(callees[0]?.text).toContain('return "hi";');
    } finally {
      await cleanup();
    }
  });

  test("imported namespace member call resolves to the member definition", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/app.ts":
        'import * as utils from "./utils";\nexport function run(): number {\n  return utils.normalize(7);\n}\n',
      "src/utils.ts": "export function normalize(n: number): number {\n  return n;\n}\n",
    });
    try {
      const { callees, diagnostics } = await resolveCalleesForSymbol({
        filePath: "src/app.ts",
        symbol: symbolFor("run", "function", 2, 4),
        reader: readerFor(dir, commit),
      });
      expect(diagnostics).toEqual([]);
      expect(callees).toHaveLength(1);
      expect(callees[0]).toMatchObject({
        name: "normalize",
        path: "src/utils.ts",
        reason: "relative namespace import",
      });
    } finally {
      await cleanup();
    }
  });

  test("this-call maps to the sibling class method", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/c.ts":
        "export class Service {\n  helper(): number {\n    return 1;\n  }\n  run(): number {\n    return this.helper();\n  }\n}\n",
    });
    try {
      const { callees, diagnostics } = await resolveCalleesForSymbol({
        filePath: "src/c.ts",
        symbol: { name: "run", kind: "method", container: "Service", startLine: 5, endLine: 7, changedLines: [6] },
        reader: readerFor(dir, commit),
      });
      expect(diagnostics).toEqual([]);
      expect(callees).toHaveLength(1);
      expect(callees[0]).toMatchObject({
        name: "helper",
        kind: "method",
        container: "Service",
        path: "src/c.ts",
        startLine: 2,
        reason: "local method call",
      });
    } finally {
      await cleanup();
    }
  });

  test("bare call ignores same-file method definitions", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/a.ts":
        "export class Service {\n  helper(): number {\n    return 1;\n  }\n}\nexport function run(): number {\n  return helper();\n}\n",
    });
    try {
      const { callees, diagnostics } = await resolveCalleesForSymbol({
        filePath: "src/a.ts",
        symbol: symbolFor("run", "function", 6, 8),
        reader: readerFor(dir, commit),
      });
      expect(callees).toEqual([]);
      expect(diagnostics.map((entry) => entry.reason)).toContain("unresolved");
    } finally {
      await cleanup();
    }
  });

  test("constructor call resolves to the imported class", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/app.ts":
        'import { Client } from "./client";\nexport function connect(): number {\n  return new Client().fetch();\n}\n',
      "src/client.ts": "export class Client {\n  fetch(): number {\n    return 1;\n  }\n}\n",
    });
    try {
      const { callees, diagnostics } = await resolveCalleesForSymbol({
        filePath: "src/app.ts",
        symbol: symbolFor("connect", "function", 2, 4),
        reader: readerFor(dir, commit),
      });
      expect(callees.map((entry) => entry.name)).toEqual(["Client"]);
      expect(callees[0]).toMatchObject({ kind: "class", path: "src/client.ts" });
      expect(diagnostics.map((entry) => entry.reason)).toContain("dynamic");
    } finally {
      await cleanup();
    }
  });

  test("calls inside nested callbacks are found", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/a.ts":
        "export function helper(): void {}\nexport function run(): void {\n  [1, 2].forEach((n) => {\n    helper();\n  });\n}\n",
    });
    try {
      const { callees } = await resolveCalleesForSymbol({
        filePath: "src/a.ts",
        symbol: symbolFor("run", "function", 2, 6),
        reader: readerFor(dir, commit),
      });
      expect(callees.map((entry) => entry.name)).toContain("helper");
    } finally {
      await cleanup();
    }
  });

  test("same-name definitions in unrelated modules are not selected", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/a.ts":
        "export function helper(): number {\n  return 1;\n}\nexport function run(): number {\n  return helper();\n}\n",
      "src/b.ts": "export function helper(): number {\n  return 2;\n}\n",
    });
    try {
      const { callees, diagnostics } = await resolveCalleesForSymbol({
        filePath: "src/a.ts",
        symbol: symbolFor("run", "function", 4, 6),
        reader: readerFor(dir, commit),
      });
      expect(diagnostics).toEqual([]);
      expect(callees).toHaveLength(1);
      expect(callees[0]).toMatchObject({ name: "helper", path: "src/a.ts" });
    } finally {
      await cleanup();
    }
  });

  test("string and comment mentions create no callees", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/a.ts":
        'export function helper(): void {}\nexport function run(): string {\n  const label = "helper()";\n  // helper();\n  return label;\n}\n',
    });
    try {
      const { callees, diagnostics } = await resolveCalleesForSymbol({
        filePath: "src/a.ts",
        symbol: symbolFor("run", "function", 2, 6),
        reader: readerFor(dir, commit),
      });
      expect(callees).toEqual([]);
      expect(diagnostics).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("duplicate calls collapse to one callee", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/a.ts": "export function helper(): void {}\nexport function run(): void {\n  helper();\n  helper();\n}\n",
    });
    try {
      const { callees, diagnostics } = await resolveCalleesForSymbol({
        filePath: "src/a.ts",
        symbol: symbolFor("run", "function", 2, 5),
        reader: readerFor(dir, commit),
      });
      expect(diagnostics).toEqual([]);
      expect(callees).toHaveLength(1);
      expect(callees[0]).toMatchObject({ name: "helper", path: "src/a.ts" });
    } finally {
      await cleanup();
    }
  });

  test("unresolved and dynamic calls are omitted with diagnostics", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/a.ts": "export function run(): void {\n  missing();\n  receiver.method();\n  getFn()();\n}\n",
    });
    try {
      const { callees, diagnostics } = await resolveCalleesForSymbol({
        filePath: "src/a.ts",
        symbol: symbolFor("run", "function", 1, 5),
        reader: readerFor(dir, commit),
      });
      expect(callees).toEqual([]);
      expect(diagnostics.map((entry) => entry.reason).sort()).toEqual([
        "ambiguous",
        "dynamic",
        "unresolved",
        "unresolved",
      ]);
    } finally {
      await cleanup();
    }
  });

  test("recursive self-calls are flagged without traversal", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/a.ts": "export function loop(n: number): number {\n  if (n <= 0) return 0;\n  return loop(n - 1);\n}\n",
    });
    try {
      const { callees, diagnostics } = await resolveCalleesForSymbol({
        filePath: "src/a.ts",
        symbol: symbolFor("loop", "function", 1, 4),
        reader: readerFor(dir, commit),
      });
      expect(diagnostics).toEqual([]);
      expect(callees).toHaveLength(1);
      expect(callees[0]).toMatchObject({ name: "loop", path: "src/a.ts", recursive: true });
    } finally {
      await cleanup();
    }
  });

  test("callee cap keeps ranked targets and reports the rest", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/a.ts":
        "export function first(): void {}\nexport function second(): void {}\nexport function run(): void {\n  first();\n  second();\n}\n",
    });
    try {
      const { callees, diagnostics } = await resolveCalleesForSymbol({
        filePath: "src/a.ts",
        symbol: symbolFor("run", "function", 3, 6),
        reader: readerFor(dir, commit),
        maxCallees: 1,
      });
      expect(callees.map((entry) => entry.name)).toEqual(["first"]);
      expect(diagnostics).toEqual([{ filePath: "src/a.ts", symbol: "run", callee: "second", reason: "cap-reached" }]);
    } finally {
      await cleanup();
    }
  });

  test("callees come from headSha, not the worktree", async () => {
    const { dir, cleanup } = await setupRepo({
      "src/a.ts":
        "export function helper(): number {\n  return 1;\n}\nexport function run(): number {\n  return helper();\n}\n",
    });
    try {
      const commit = await git(dir, ["rev-parse", "HEAD"]);
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(
        join(dir, "src", "a.ts"),
        "export function helper(): number {\n  return 2;\n}\nexport function run(): number {\n  return 0;\n}\n",
      );
      const { callees } = await resolveCalleesForSymbol({
        filePath: "src/a.ts",
        symbol: symbolFor("run", "function", 4, 6),
        reader: readerFor(dir, commit),
      });
      expect(callees).toHaveLength(1);
      expect(callees[0]).toMatchObject({ name: "helper", path: "src/a.ts" });
      expect(callees[0]?.text).toContain("return 1;");
    } finally {
      await cleanup();
    }
  });
});
