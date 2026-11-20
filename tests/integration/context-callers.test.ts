import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCallersForSymbol } from "../../src/context/callers.ts";
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
  const outside = await mkdtemp(join(tmpdir(), "codebleach-clr-"));
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

describe("context caller discovery from commit snapshots", () => {
  test("same-file direct caller resolves to the enclosing function", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/a.ts":
        "export function helper(): number {\n  return 1;\n}\nexport function run(): number {\n  return helper();\n}\n",
    });
    try {
      const { callers, diagnostics } = await resolveCallersForSymbol({
        filePath: "src/a.ts",
        symbol: symbolFor("helper", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(diagnostics).toEqual([]);
      expect(callers).toHaveLength(1);
      expect(callers[0]).toMatchObject({
        path: "src/a.ts",
        caller: "run",
        callerKind: "function",
        reason: "same-file direct call",
      });
    } finally {
      await cleanup();
    }
  });

  test("same-file this-call resolves to the sibling method caller", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/c.ts":
        "export class Service {\n  run(): number {\n    return 1;\n  }\n  drive(): number {\n    return this.run();\n  }\n}\n",
    });
    try {
      const { callers } = await resolveCallersForSymbol({
        filePath: "src/c.ts",
        symbol: { name: "run", kind: "method", container: "Service", startLine: 2, endLine: 4, changedLines: [3] },
        reader: readerFor(dir, commit),
      });
      expect(callers).toHaveLength(1);
      expect(callers[0]).toMatchObject({ caller: "drive", callerKind: "method", reason: "same-file direct call" });
    } finally {
      await cleanup();
    }
  });

  test("cross-file named import caller resolves", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/app.ts": 'import { greet } from "./util";\nexport function run(): string {\n  return greet();\n}\n',
      "src/util.ts": 'export function greet(): string {\n  return "hi";\n}\n',
    });
    try {
      const { callers, diagnostics } = await resolveCallersForSymbol({
        filePath: "src/util.ts",
        symbol: symbolFor("greet", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(diagnostics).toEqual([]);
      expect(callers).toHaveLength(1);
      expect(callers[0]).toMatchObject({
        path: "src/app.ts",
        caller: "run",
        reason: "named import call",
      });
      expect(callers[0]?.callerText).toContain("return greet();");
    } finally {
      await cleanup();
    }
  });

  test("aliased named import caller reports the alias evidence", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/app.ts": 'import { greet as g } from "./util";\nexport function run(): string {\n  return g();\n}\n',
      "src/util.ts": 'export function greet(): string {\n  return "hi";\n}\n',
    });
    try {
      const { callers } = await resolveCallersForSymbol({
        filePath: "src/util.ts",
        symbol: symbolFor("greet", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(callers).toHaveLength(1);
      expect(callers[0]).toMatchObject({ path: "src/app.ts", caller: "run", reason: "named import alias call" });
    } finally {
      await cleanup();
    }
  });

  test("default import caller resolves to the default export", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/app.ts": 'import local from "./util";\nexport function run(): number {\n  return local();\n}\n',
      "src/util.ts": "export default function helper(): number {\n  return 1;\n}\n",
    });
    try {
      const { callers, diagnostics } = await resolveCallersForSymbol({
        filePath: "src/util.ts",
        symbol: symbolFor("helper", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(diagnostics).toEqual([]);
      expect(callers).toHaveLength(1);
      expect(callers[0]).toMatchObject({ path: "src/app.ts", caller: "run", reason: "default import call" });
    } finally {
      await cleanup();
    }
  });

  test("default export through an explicit barrel re-export resolves", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/app.ts": 'import { helper } from "./barrel";\nexport function run(): number {\n  return helper();\n}\n',
      "src/barrel.ts": 'export { default as helper } from "./real";\n',
      "src/real.ts": "export default function helper(): number {\n  return 1;\n}\n",
    });
    try {
      const { callers, diagnostics } = await resolveCallersForSymbol({
        filePath: "src/real.ts",
        symbol: symbolFor("helper", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(diagnostics).toEqual([]);
      expect(callers).toHaveLength(1);
      expect(callers[0]).toMatchObject({ path: "src/app.ts", caller: "run", reason: "barrel re-export call" });
    } finally {
      await cleanup();
    }
  });

  test("named symbol through multiple explicit barrel hops resolves", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/app.ts": 'import { greet } from "./outer";\nexport function run(): string {\n  return greet();\n}\n',
      "src/outer.ts": 'export { greet } from "./mid";\n',
      "src/mid.ts": 'export { greet as greet } from "./real";\n',
      "src/real.ts": 'export function greet(): string {\n  return "hi";\n}\n',
    });
    try {
      const { callers, diagnostics } = await resolveCallersForSymbol({
        filePath: "src/real.ts",
        symbol: symbolFor("greet", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(diagnostics).toEqual([]);
      expect(callers).toHaveLength(1);
      expect(callers[0]).toMatchObject({ path: "src/app.ts", reason: "barrel re-export call" });
    } finally {
      await cleanup();
    }
  });

  test("namespace import caller resolves the member through the target module", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/app.ts":
        'import * as utils from "./utils";\nexport function run(): number {\n  return utils.normalize(7);\n}\n',
      "src/utils.ts": "export function normalize(n: number): number {\n  return n;\n}\n",
    });
    try {
      const { callers, diagnostics } = await resolveCallersForSymbol({
        filePath: "src/utils.ts",
        symbol: symbolFor("normalize", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(diagnostics).toEqual([]);
      expect(callers).toHaveLength(1);
      expect(callers[0]).toMatchObject({ path: "src/app.ts", reason: "namespace import call" });
    } finally {
      await cleanup();
    }
  });

  test("export star caller resolves only when unambiguous", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/app.ts": 'import { greet } from "./barrel";\nexport function run(): string {\n  return greet();\n}\n',
      "src/barrel.ts": 'export * from "./real";\n',
      "src/real.ts": 'export function greet(): string {\n  return "hi";\n}\n',
    });
    try {
      const { callers, diagnostics } = await resolveCallersForSymbol({
        filePath: "src/real.ts",
        symbol: symbolFor("greet", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(diagnostics).toEqual([]);
      expect(callers).toHaveLength(1);
      expect(callers[0]).toMatchObject({ path: "src/app.ts", reason: "barrel re-export call" });
    } finally {
      await cleanup();
    }
  });

  test("ambiguous export star is not guessed", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/app.ts": 'import { clash } from "./barrel";\nexport function run(): number {\n  return clash();\n}\n',
      "src/barrel.ts": 'export * from "./left";\nexport * from "./right";\n',
      "src/left.ts": "export function clash(): number {\n  return 1;\n}\n",
      "src/right.ts": "export function clash(): number {\n  return 2;\n}\n",
    });
    try {
      const { callers, diagnostics } = await resolveCallersForSymbol({
        filePath: "src/left.ts",
        symbol: symbolFor("clash", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(callers).toEqual([]);
      expect(diagnostics.map((entry) => entry.reason)).toContain("ambiguous");
    } finally {
      await cleanup();
    }
  });

  test("re-export cycles terminate without callers", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/app.ts": 'import { x } from "./a";\nexport function run(): number {\n  return x();\n}\n',
      "src/a.ts": 'export { x as x } from "./b";\n',
      "src/b.ts": 'export { x as x } from "./a";\n',
      "src/real.ts": "export function x(): number {\n  return 1;\n}\n",
    });
    try {
      const { callers } = await resolveCallersForSymbol({
        filePath: "src/real.ts",
        symbol: symbolFor("x", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(callers).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("comments and strings do not count as callers", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/app.ts":
        'const label = "helper()";\n// helper();\n/* helper(); */\nexport function run(): string {\n  return label;\n}\n',
      "src/util.ts": 'export function helper(): string {\n  return "hi";\n}\n',
    });
    try {
      const { callers } = await resolveCallersForSymbol({
        filePath: "src/util.ts",
        symbol: symbolFor("helper", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(callers).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("declaration alone creates no caller", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/util.ts": 'export function greet(): string {\n  return "hi";\n}\n',
    });
    try {
      const { callers, diagnostics } = await resolveCallersForSymbol({
        filePath: "src/util.ts",
        symbol: symbolFor("greet", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(callers).toEqual([]);
      expect(diagnostics).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("same-name unrelated function without import evidence is not selected", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/a.ts": "export function helper(): number {\n  return 1;\n}\n",
      "src/b.ts": "export function helper(): number {\n  return helper();\n}\n",
    });
    try {
      const { callers } = await resolveCallersForSymbol({
        filePath: "src/a.ts",
        symbol: symbolFor("helper", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(callers).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("constructor call counts as a caller of the class", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/app.ts":
        'import { Client } from "./client";\nexport function connect(): number {\n  return new Client().fetch();\n}\n',
      "src/client.ts": "export class Client {\n  fetch(): number {\n    return 1;\n  }\n}\n",
    });
    try {
      const { callers } = await resolveCallersForSymbol({
        filePath: "src/client.ts",
        symbol: symbolFor("Client", "class", 1, 5),
        reader: readerFor(dir, commit),
      });
      expect(callers).toHaveLength(1);
      expect(callers[0]).toMatchObject({ path: "src/app.ts", caller: "connect", reason: "named import call" });
    } finally {
      await cleanup();
    }
  });

  test("caller cap keeps ranked sites and reports the rest", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/a.ts": 'import { helper } from "./util";\nexport function first(): number {\n  return helper();\n}\n',
      "src/b.ts": 'import { helper } from "./util";\nexport function second(): number {\n  return helper();\n}\n',
      "src/util.ts": "export function helper(): number {\n  return 1;\n}\n",
    });
    try {
      const { callers, diagnostics } = await resolveCallersForSymbol({
        filePath: "src/util.ts",
        symbol: symbolFor("helper", "function", 1, 3),
        reader: readerFor(dir, commit),
        maxCallers: 1,
      });
      expect(callers.map((entry) => entry.path)).toEqual(["src/a.ts"]);
      expect(diagnostics).toEqual([
        { filePath: "src/util.ts", symbol: "helper", candidate: "src/b.ts:second", reason: "cap-reached" },
      ]);
    } finally {
      await cleanup();
    }
  });

  test("re-export chains past the depth limit report depth-exceeded", async () => {
    const files: Record<string, string> = {
      "src/app.ts": 'import { x } from "./l0";\nexport function run(): number {\n  return x();\n}\n',
      "src/real.ts": "export function x(): number {\n  return 1;\n}\n",
    };
    for (let index = 0; index < 10; index += 1) {
      const next = index === 9 ? "./real" : `./l${index + 1}`;
      files[`src/l${index}.ts`] = `export { x as x } from "${next}";\n`;
    }
    const { dir, cleanup, commit } = await setupRepo(files);
    try {
      const { callers, diagnostics } = await resolveCallersForSymbol({
        filePath: "src/real.ts",
        symbol: symbolFor("x", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(callers).toEqual([]);
      expect(diagnostics.map((entry) => entry.reason)).toContain("depth-exceeded");
    } finally {
      await cleanup();
    }
  });

  test("callers come from headSha, not the worktree", async () => {
    const { dir, cleanup } = await setupRepo({
      "src/app.ts": 'import { helper } from "./util";\nexport function run(): number {\n  return helper();\n}\n',
      "src/util.ts": "export function helper(): number {\n  return 1;\n}\n",
    });
    try {
      const commit = await git(dir, ["rev-parse", "HEAD"]);
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "app.ts"), "export function run(): number {\n  return 0;\n}\n");
      await writeFile(join(dir, "src", "extra.ts"), 'import { helper } from "./util";\nhelper();\n');
      const { callers } = await resolveCallersForSymbol({
        filePath: "src/util.ts",
        symbol: symbolFor("helper", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(callers.map((entry) => entry.path)).toEqual(["src/app.ts"]);
    } finally {
      await cleanup();
    }
  });
});
