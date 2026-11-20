import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import type { ResolvedConfig } from "../../src/config/schema.ts";
import { SnapshotReader } from "../../src/context/snapshot.ts";
import { mapChangedSymbolsForFile } from "../../src/context/symbols.ts";
import { GitDiffEngine } from "../../src/diff/git.ts";
import type { DiffLogger } from "../../src/diff/git.ts";
import { commitIndex, git, makeRepo } from "../helpers/git-repo.ts";

function defaults(): ResolvedConfig {
  return ConfigFileSchema.parse({});
}

function quietLogger(): DiffLogger {
  const noop = (_msg: string, _fields: Record<string, unknown> = {}): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

async function writeIndexed(dir: string, outside: string, repoPath: string, content: string): Promise<void> {
  const staging = join(outside, Buffer.from(repoPath).toString("hex"));
  await writeFile(staging, content);
  const blob = await git(dir, ["hash-object", "-w", staging]);
  await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${blob},${repoPath}`]);
}

describe("context symbols from commit snapshots", () => {
  test("E05 deletion-only maps to surviving function with anchor; diff untouched", async () => {
    const { dir, cleanup } = await makeRepo();
    let outside: string | null = null;
    try {
      outside = await mkdtemp(join(tmpdir(), "codebleach-sym-"));
      await mkdir(join(dir, "src"), { recursive: true });
      await writeIndexed(
        dir,
        outside,
        "src/f.ts",
        "export function f(x?: string) {\n  if (!x) return 0;\n  return x.length;\n}\n",
      );
      const base = await commitIndex(dir, "base");
      await writeIndexed(dir, outside, "src/f.ts", "export function f(x?: string) {\n  return x.length;\n}\n");
      const head = await commitIndex(dir, "head");
      const engine = new GitDiffEngine({ logger: quietLogger() });
      const result = await engine.run({ repoDir: dir, baseSha: base, headSha: head, config: defaults() });
      expect(result.files).toHaveLength(1);
      const file = result.files[0];
      if (file === undefined) throw new Error("expected one file");
      expect(file.symbols).toEqual([{ name: "<module>", kind: "module", startLine: 1, endLine: 3, changedLines: [] }]);
      const reader = new SnapshotReader({ repoRoot: dir, headSha: result.headSha, mergeBase: result.mergeBase });
      const symbols = await mapChangedSymbolsForFile({ file, reader });
      expect(symbols).toHaveLength(1);
      expect(symbols[0]).toMatchObject({ name: "f", kind: "function", changedLines: [], deletedLines: [2] });
      expect(symbols[0]?.anchorLine).toBe(2);
      expect(symbols[0]?.startLine).toBe(1);
      expect(symbols[0]?.endLine).toBe(3);
    } finally {
      if (outside !== null) await rm(outside, { recursive: true, force: true });
      await cleanup();
    }
  });

  test("addition inside method maps with class container", async () => {
    const { dir, cleanup } = await makeRepo();
    let outside: string | null = null;
    try {
      outside = await mkdtemp(join(tmpdir(), "codebleach-sym-"));
      await mkdir(join(dir, "src"), { recursive: true });
      await writeIndexed(dir, outside, "src/c.ts", "export class C {\n  m(): void {}\n}\n");
      const base = await commitIndex(dir, "base");
      await writeIndexed(dir, outside, "src/c.ts", "export class C {\n  m(): void {\n    work();\n  }\n}\n");
      const head = await commitIndex(dir, "head");
      const engine = new GitDiffEngine({ logger: quietLogger() });
      const result = await engine.run({ repoDir: dir, baseSha: base, headSha: head, config: defaults() });
      const file = result.files[0];
      if (file === undefined) throw new Error("expected one file");
      const reader = new SnapshotReader({ repoRoot: dir, headSha: result.headSha, mergeBase: result.mergeBase });
      const symbols = await mapChangedSymbolsForFile({ file, reader });
      expect(symbols).toHaveLength(1);
      expect(symbols[0]).toMatchObject({ name: "m", kind: "method", container: "C" });
      expect(symbols[0]?.changedLines).toEqual([2, 3, 4]);
    } finally {
      if (outside !== null) await rm(outside, { recursive: true, force: true });
      await cleanup();
    }
  });

  test("fully deleted function falls back to module with anchor", async () => {
    const { dir, cleanup } = await makeRepo();
    let outside: string | null = null;
    try {
      outside = await mkdtemp(join(tmpdir(), "codebleach-sym-"));
      await mkdir(join(dir, "src"), { recursive: true });
      await writeIndexed(
        dir,
        outside,
        "src/g.ts",
        "export function keep(): void {}\nexport function gone(): void {\n  work();\n}\n",
      );
      const base = await commitIndex(dir, "base");
      await writeIndexed(dir, outside, "src/g.ts", "export function keep(): void {}\n");
      const head = await commitIndex(dir, "head");
      const engine = new GitDiffEngine({ logger: quietLogger() });
      const result = await engine.run({ repoDir: dir, baseSha: base, headSha: head, config: defaults() });
      const file = result.files[0];
      if (file === undefined) throw new Error("expected one file");
      const reader = new SnapshotReader({ repoRoot: dir, headSha: result.headSha, mergeBase: result.mergeBase });
      const symbols = await mapChangedSymbolsForFile({ file, reader });
      expect(symbols).toHaveLength(1);
      expect(symbols[0]).toMatchObject({ name: "<module>", kind: "module", changedLines: [] });
      expect(symbols[0]?.deletedLines).toEqual([2, 3, 4]);
      expect(symbols[0]?.anchorLine).toBe(1);
    } finally {
      if (outside !== null) await rm(outside, { recursive: true, force: true });
      await cleanup();
    }
  });

  test("rename reads old path at base and new path at head", async () => {
    const { dir, cleanup } = await makeRepo();
    let outside: string | null = null;
    try {
      outside = await mkdtemp(join(tmpdir(), "codebleach-sym-"));
      await mkdir(join(dir, "src"), { recursive: true });
      await writeIndexed(dir, outside, "src/old.ts", "export function f(): number {\n  return 1;\n}\n");
      const base = await commitIndex(dir, "base");
      await git(dir, ["rm", "--cached", "src/old.ts"]);
      await writeIndexed(dir, outside, "src/new.ts", "export function f(): number {\n  return 2;\n}\n");
      const head = await commitIndex(dir, "head");
      const engine = new GitDiffEngine({ logger: quietLogger() });
      const result = await engine.run({ repoDir: dir, baseSha: base, headSha: head, config: defaults() });
      expect(result.files).toHaveLength(1);
      const file = result.files[0];
      if (file === undefined) throw new Error("expected one file");
      expect(file.oldPath).toBe("src/old.ts");
      const reader = new SnapshotReader({ repoRoot: dir, headSha: result.headSha, mergeBase: result.mergeBase });
      const symbols = await mapChangedSymbolsForFile({ file, reader });
      expect(symbols).toHaveLength(1);
      expect(symbols[0]).toMatchObject({ name: "f", kind: "function" });
      expect(symbols[0]?.changedLines).toEqual([2]);
      expect(symbols[0]?.deletedLines).toEqual([2]);
    } finally {
      if (outside !== null) await rm(outside, { recursive: true, force: true });
      await cleanup();
    }
  });

  test("worktree edits and untracked files do not affect mapping", async () => {
    const { dir, cleanup } = await makeRepo();
    let outside: string | null = null;
    try {
      outside = await mkdtemp(join(tmpdir(), "codebleach-sym-"));
      await mkdir(join(dir, "src"), { recursive: true });
      await writeIndexed(
        dir,
        outside,
        "src/f.ts",
        "export function f(x?: string) {\n  if (!x) return 0;\n  return x.length;\n}\n",
      );
      const base = await commitIndex(dir, "base");
      await writeIndexed(dir, outside, "src/f.ts", "export function f(x?: string) {\n  return x.length;\n}\n");
      const head = await commitIndex(dir, "head");
      const engine = new GitDiffEngine({ logger: quietLogger() });
      const result = await engine.run({ repoDir: dir, baseSha: base, headSha: head, config: defaults() });
      const file = result.files[0];
      if (file === undefined) throw new Error("expected one file");
      await writeFile(join(dir, "src/f.ts"), "export function f(): void {\n  hacked();\n}\n");
      await writeFile(join(dir, "src/untracked.ts"), "export function f(): void {}\n");
      const reader = new SnapshotReader({ repoRoot: dir, headSha: result.headSha, mergeBase: result.mergeBase });
      const symbols = await mapChangedSymbolsForFile({ file, reader });
      expect(symbols).toHaveLength(1);
      expect(symbols[0]).toMatchObject({ name: "f", deletedLines: [2] });
    } finally {
      if (outside !== null) await rm(outside, { recursive: true, force: true });
      await cleanup();
    }
  });

  test("mapping is deterministic across runs", async () => {
    const { dir, cleanup } = await makeRepo();
    let outside: string | null = null;
    try {
      outside = await mkdtemp(join(tmpdir(), "codebleach-sym-"));
      await mkdir(join(dir, "src"), { recursive: true });
      await writeIndexed(
        dir,
        outside,
        "src/f.ts",
        "export function f(x?: string) {\n  if (!x) return 0;\n  return x.length;\n}\n",
      );
      const base = await commitIndex(dir, "base");
      await writeIndexed(dir, outside, "src/f.ts", "export function f(x?: string) {\n  return x.length;\n}\n");
      const head = await commitIndex(dir, "head");
      const engine = new GitDiffEngine({ logger: quietLogger() });
      const result = await engine.run({ repoDir: dir, baseSha: base, headSha: head, config: defaults() });
      const file = result.files[0];
      if (file === undefined) throw new Error("expected one file");
      const reader = new SnapshotReader({ repoRoot: dir, headSha: result.headSha, mergeBase: result.mergeBase });
      const first = await mapChangedSymbolsForFile({ file, reader });
      const second = await mapChangedSymbolsForFile({ file, reader });
      expect(second).toEqual(first);
    } finally {
      if (outside !== null) await rm(outside, { recursive: true, force: true });
      await cleanup();
    }
  });

  test("deleted and lockfile-skipped files yield no symbols", async () => {
    const { dir, cleanup } = await makeRepo();
    let outside: string | null = null;
    try {
      outside = await mkdtemp(join(tmpdir(), "codebleach-sym-"));
      await mkdir(join(dir, "src"), { recursive: true });
      await writeIndexed(dir, outside, "src/doomed.ts", "export function doomed(): void {}\n");
      await writeIndexed(dir, outside, "bun.lock", "lock v1\n");
      const base = await commitIndex(dir, "base");
      await git(dir, ["rm", "--cached", "src/doomed.ts"]);
      await writeIndexed(dir, outside, "bun.lock", "lock v2\n");
      const head = await commitIndex(dir, "head");
      const engine = new GitDiffEngine({ logger: quietLogger() });
      const result = await engine.run({ repoDir: dir, baseSha: base, headSha: head, config: defaults() });
      expect(result.files).toHaveLength(2);
      const reader = new SnapshotReader({ repoRoot: dir, headSha: result.headSha, mergeBase: result.mergeBase });
      for (const file of result.files) {
        expect(file.skipReason).toBeDefined();
        await expect(mapChangedSymbolsForFile({ file, reader })).resolves.toEqual([]);
      }
    } finally {
      if (outside !== null) await rm(outside, { recursive: true, force: true });
      await cleanup();
    }
  });
});
