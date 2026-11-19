import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCalleesForSymbol } from "../../src/context/calls.ts";
import { resolveCallersForSymbol } from "../../src/context/callers.ts";
import { resolveImportsForFile } from "../../src/context/imports.ts";
import { SnapshotReader } from "../../src/context/snapshot.ts";
import { mapChangedSymbolsForFile } from "../../src/context/symbols.ts";
import type { ChangedFile, ChangedSymbol, SymbolKind } from "../../src/types/diff.ts";
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
  const outside = await mkdtemp(join(tmpdir(), "codebleach-cons-"));
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

describe("context consolidation from commit snapshots", () => {
  test("unsupported language maps to a module fallback with diff lines", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "data/notes.json": '{\n  "hello": "world"\n}\n',
    });
    try {
      const file: ChangedFile = {
        path: "data/notes.json",
        oldPath: null,
        status: "added",
        language: null,
        hunks: [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 3,
            lines: [
              { kind: "add", oldLine: null, newLine: 1, position: 1, text: "{" },
              { kind: "add", oldLine: null, newLine: 2, position: 2, text: '  "hello": "world"' },
              { kind: "add", oldLine: null, newLine: 3, position: 3, text: "}" },
            ],
          },
        ],
        commentableLines: [1, 2, 3],
        symbols: [],
      };
      const symbols = await mapChangedSymbolsForFile({ file, reader: readerFor(dir, commit) });
      expect(symbols).toHaveLength(1);
      expect(symbols[0]).toMatchObject({ name: "<module>", kind: "module", changedLines: [1, 2, 3] });
    } finally {
      await cleanup();
    }
  });

  test("unsupported language resolutions stay empty", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "data/notes.json": '{\n  "hello": "world"\n}\n',
    });
    try {
      const reader = readerFor(dir, commit);
      const moduleSymbol = symbolFor("<module>", "module", 1, 3);
      await expect(
        resolveImportsForFile({ importerPath: "data/notes.json", reader }),
      ).resolves.toEqual({ resolved: [], diagnostics: [] });
      await expect(
        resolveCalleesForSymbol({ filePath: "data/notes.json", symbol: moduleSymbol, reader }),
      ).resolves.toEqual({ callees: [], diagnostics: [] });
      await expect(
        resolveCallersForSymbol({ filePath: "data/notes.json", symbol: moduleSymbol, reader }),
      ).resolves.toEqual({ callers: [], diagnostics: [] });
    } finally {
      await cleanup();
    }
  });

  test("type symbol yields no callers", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/types.ts": "export interface Options {\n  verbose: boolean;\n}\n",
      "src/app.ts": 'import type { Options } from "./types";\nexport function run(opts: Options): boolean {\n  return opts.verbose;\n}\n',
    });
    try {
      const { callers } = await resolveCallersForSymbol({
        filePath: "src/types.ts",
        symbol: symbolFor("Options", "type", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(callers).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("module symbol yields no callers", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/a.ts": "export function helper(): number {\n  return 1;\n}\n",
    });
    try {
      const { callers } = await resolveCallersForSymbol({
        filePath: "src/a.ts",
        symbol: symbolFor("<module>", "module", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(callers).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("module-scope callee resolves from a top-level call", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/util.ts": "export function helper(): number {\n  return 1;\n}\n",
      "src/main.ts": 'import { helper } from "./util";\nhelper();\n',
    });
    try {
      const { callees, diagnostics } = await resolveCalleesForSymbol({
        filePath: "src/main.ts",
        symbol: symbolFor("<module>", "module", 1, 2),
        reader: readerFor(dir, commit),
      });
      expect(diagnostics).toEqual([]);
      expect(callees).toHaveLength(1);
      expect(callees[0]).toMatchObject({ name: "helper", path: "src/util.ts", reason: "relative named import" });
    } finally {
      await cleanup();
    }
  });

  test("module-scope caller is reported without an enclosing function", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/util.ts": "export function helper(): number {\n  return 1;\n}\n",
      "src/main.ts": 'import { helper } from "./util";\nhelper();\n',
    });
    try {
      const { callers } = await resolveCallersForSymbol({
        filePath: "src/util.ts",
        symbol: symbolFor("helper", "function", 1, 3),
        reader: readerFor(dir, commit),
      });
      expect(callers).toHaveLength(1);
      expect(callers[0]).toMatchObject({ path: "src/main.ts", caller: null, callerKind: "module" });
    } finally {
      await cleanup();
    }
  });
});
