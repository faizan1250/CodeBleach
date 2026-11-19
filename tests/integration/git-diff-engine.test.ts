import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import type { ResolvedConfig } from "../../src/config/schema.ts";
import { ReviewerError } from "../../src/core/errors.ts";
import { GitDiffEngine, PINNED_DIFF_FLAGS } from "../../src/diff/git.ts";
import type { DiffLogger } from "../../src/diff/git.ts";
import { runProcess } from "../../src/utils/spawn.ts";

interface LoggedCall {
  level: string;
  msg: string;
  fields: Record<string, unknown>;
}

function makeLogger(): { calls: LoggedCall[]; logger: DiffLogger } {
  const calls: LoggedCall[] = [];
  const entry =
    (level: string) =>
    (msg: string, fields: Record<string, unknown> = {}): void => {
      calls.push({ level, msg, fields });
    };
  return {
    calls,
    logger: {
      debug: entry("debug"),
      info: entry("info"),
      warn: entry("warn"),
      error: entry("error"),
    },
  };
}

// Structural use only; satisfied by the spy above and the real Logger.

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export async function git(dir: string, args: string[]): Promise<string> {
  const result = await runProcess({ cmd: ["git", ...args], cwd: dir });
  return decode(result.stdout).trim();
}

export async function makeRepo(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "codebleach-p2-07-"));
  const cleanup = (): Promise<void> => rm(dir, { recursive: true, force: true });
  try {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.name", "CodeBleach Test"]);
    await git(dir, ["config", "user.email", "p2-07@codebleach.local"]);
    await git(dir, ["config", "commit.gpgsign", "false"]);
    return { dir, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function writeAndCommit(
  dir: string,
  files: Record<string, string | Uint8Array>,
  message: string,
): Promise<string> {
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", message, "--quiet"]);
  return git(dir, ["rev-parse", "HEAD"]);
}

// Fixed identity for deterministic SHAs; plumbing commits use it.
const FIXED_GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "CodeBleach Test",
  GIT_AUTHOR_EMAIL: "edge@codebleach.local",
  GIT_COMMITTER_NAME: "CodeBleach Test",
  GIT_COMMITTER_EMAIL: "edge@codebleach.local",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

// Commits the current index directly via plumbing.
export async function commitIndex(dir: string, message: string): Promise<string> {
  const tree = await git(dir, ["write-tree"]);
  let parent: string | null = null;
  try {
    parent = await git(dir, ["rev-parse", "HEAD"]);
  } catch {
    parent = null;
  }
  const args =
    parent === null ? ["commit-tree", tree, "-m", message] : ["commit-tree", tree, "-p", parent, "-m", message];
  const result = await runProcess({ cmd: ["git", ...args], cwd: dir, env: FIXED_GIT_ENV });
  const commit = decode(result.stdout).trim();
  await git(dir, ["update-ref", "HEAD", commit]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function defaults(overrides: Record<string, unknown> = {}): ResolvedConfig {
  return ConfigFileSchema.parse(overrides);
}

function codeOf(error: unknown): string {
  expect(error).toBeInstanceOf(ReviewerError);
  return (error as ReviewerError).code;
}

async function runEngine(
  dir: string,
  baseSha: string,
  headSha: string,
  config: ResolvedConfig = defaults(),
): Promise<{ result: Awaited<ReturnType<GitDiffEngine["run"]>>; calls: LoggedCall[] }> {
  const { calls, logger } = makeLogger();
  const result = await new GitDiffEngine({ logger }).run({
    repoDir: dir,
    baseSha,
    headSha,
    config,
  });
  return { result, calls };
}

describe("modified TypeScript file", () => {
  test("maps lines, positions, commentable lines, and module symbol", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(
        dir,
        { "src/app.ts": "one\ntwo\nthree\nfour\nfive\nsix\n" },
        "base",
      );
      const head = await writeAndCommit(
        dir,
        { "src/app.ts": "one\ntwo\nTHREE\nfour\nfive\nsix\nseven\n" },
        "head",
      );
      const { result, calls } = await runEngine(dir, base, head);
      expect(result.baseSha).toBe(base.toLowerCase());
      expect(result.headSha).toBe(head.toLowerCase());
      expect(result.mergeBase).toBe(base.toLowerCase());
      expect(result.files).toHaveLength(1);
      const file = result.files[0];
      expect(file).toMatchObject({
        path: "src/app.ts",
        oldPath: null,
        status: "modified",
        language: "typescript",
      });
      expect(file?.skipReason).toBeUndefined();
      expect(file?.hunks).toHaveLength(1);
      const lines = file?.hunks[0]?.lines ?? [];
      expect(lines.map((line) => line.kind)).toEqual(["ctx", "ctx", "del", "add", "ctx", "ctx", "ctx", "add"]);
      expect(lines.map((line) => [line.oldLine, line.newLine])).toEqual([
        [1, 1],
        [2, 2],
        [3, null],
        [null, 3],
        [4, 4],
        [5, 5],
        [6, 6],
        [null, 7],
      ]);
      expect(lines.map((line) => line.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(lines[2]?.text).toBe("three");
      expect(lines[3]?.text).toBe("THREE");
      expect(file?.commentableLines).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(file?.symbols).toEqual([
        { name: "<module>", kind: "module", startLine: 1, endLine: 7, changedLines: [3, 7] },
      ]);
      const summary = calls.find((call) => call.level === "info");
      expect(summary?.fields).toMatchObject({
        filesTotal: 1,
        filesAnalyzed: 1,
        filesSkipped: 0,
        additions: 2,
        deletions: 1,
        hunks: 1,
        binaryFiles: 0,
        renamedFiles: 0,
      });
    } finally {
      await cleanup();
    }
  });

  test("unsupported language stays visible with null language and no symbol", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/main.py": "print(1)\n" }, "base");
      const head = await writeAndCommit(dir, { "src/main.py": "print(2)\n" }, "head");
      const { result } = await runEngine(dir, base, head);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]).toMatchObject({ path: "src/main.py", language: null });
      expect(result.files[0]?.skipReason).toBeUndefined();
      expect(result.files[0]?.hunks).toHaveLength(1);
      expect(result.files[0]?.symbols).toEqual([]);
      expect(result.files[0]?.commentableLines).toEqual([1]);
    } finally {
      await cleanup();
    }
  });
});

describe("added, deleted, and mode-only files", () => {
  test("added file carries null oldPath and a module symbol", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/keep.ts": "const a = 1;\n" }, "base");
      const head = await writeAndCommit(
        dir,
        { "src/keep.ts": "const a = 1;\n", "src/new.ts": "export const b = 2;\n" },
        "head",
      );
      const { result } = await runEngine(dir, base, head);
      const added = result.files.find((file) => file.path === "src/new.ts");
      expect(added).toMatchObject({ status: "added", oldPath: null, language: "typescript" });
      expect(added?.skipReason).toBeUndefined();
      expect(added?.symbols).toEqual([
        { name: "<module>", kind: "module", startLine: 1, endLine: 1, changedLines: [1] },
      ]);
      expect(added?.commentableLines).toEqual([1]);
    } finally {
      await cleanup();
    }
  });

  test("deleted file is skipped without head blob reads", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(
        dir,
        { "src/gone.ts": "export const x = 1;\n", "src/keep.ts": "const a = 1;\n" },
        "base",
      );
      await writeAndCommit(dir, { "src/keep.ts": "const a = 2;\n" }, "head");
      await git(dir, ["rm", "--quiet", "src/gone.ts"]);
      await git(dir, ["commit", "-m", "head", "--quiet"]);
      const head = await git(dir, ["rev-parse", "HEAD"]);
      const { result } = await runEngine(dir, base, head);
      const deleted = result.files.find((file) => file.path === "src/gone.ts");
      expect(deleted).toMatchObject({ status: "deleted", language: "typescript" });
      expect(deleted?.skipReason).toBe("deleted");
      expect(deleted?.hunks).toEqual([]);
      expect(deleted?.commentableLines).toEqual([]);
      expect(deleted?.symbols).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("mode-only change has empty hunks and no symbol", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "run.sh": "#!/bin/sh\necho hi\n" }, "base");
      await git(dir, ["update-index", "--chmod=+x", "run.sh"]);
      await git(dir, ["commit", "-m", "head", "--quiet"]);
      const head = await git(dir, ["rev-parse", "HEAD"]);
      const { result } = await runEngine(dir, base, head);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]).toMatchObject({ path: "run.sh", status: "modified" });
      expect(result.files[0]?.skipReason).toBeUndefined();
      expect(result.files[0]?.hunks).toEqual([]);
      expect(result.files[0]?.commentableLines).toEqual([]);
      expect(result.files[0]?.symbols).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe("multi-hunk positions", () => {
  test("positions continue across hunks within one file", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const body = Array.from({ length: 30 }, (_, index) => `line${index + 1}`).join("\n");
      const base = await writeAndCommit(dir, { "src/big.ts": `${body}\n` }, "base");
      const changed = body.split("\n");
      changed[1] = "CHANGED2";
      changed[27] = "CHANGED28";
      const head = await writeAndCommit(dir, { "src/big.ts": `${changed.join("\n")}\n` }, "head");
      const { result } = await runEngine(dir, base, head);
      const file = result.files[0];
      expect(file?.hunks.length).toBeGreaterThan(1);
      const positions = (file?.hunks ?? []).flatMap((hunk) => hunk.lines.map((line) => line.position));
      expect(positions).toEqual(Array.from({ length: positions.length }, (_, index) => index + 1));
      const secondHunkFirst = file?.hunks[1]?.lines[0];
      expect(secondHunkFirst?.position).toBe((file?.hunks[0]?.lines.length ?? 0) + 1);
    } finally {
      await cleanup();
    }
  });
});

describe("renames", () => {
  test("rename with changes keeps oldPath and a new-path symbol", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(
        dir,
        { "src/old.ts": "export const a = 1;\nexport const b = 2;\n" },
        "base",
      );
      await git(dir, ["mv", "src/old.ts", "src/new.ts"]);
      await writeFile(join(dir, "src/new.ts"), "export const a = 1;\nexport const b = 3;\n");
      await git(dir, ["add", "-A"]);
      await git(dir, ["commit", "-m", "head", "--quiet"]);
      const head = await git(dir, ["rev-parse", "HEAD"]);
      const { result } = await runEngine(dir, base, head);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]).toMatchObject({
        path: "src/new.ts",
        oldPath: "src/old.ts",
        status: "renamed",
        language: "typescript",
      });
      expect(result.files[0]?.skipReason).toBeUndefined();
      expect(result.files[0]?.hunks.length).toBeGreaterThan(0);
      expect(result.files[0]?.symbols).toEqual([
        { name: "<module>", kind: "module", startLine: 1, endLine: 2, changedLines: [2] },
      ]);
      const summary = result.files[0];
      expect(summary?.commentableLines).toContain(2);
    } finally {
      await cleanup();
    }
  });

  test("rename-only has empty hunks and no symbol", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/old.ts": "export const a = 1;\n" }, "base");
      await git(dir, ["mv", "src/old.ts", "src/new.ts"]);
      await git(dir, ["commit", "-m", "head", "--quiet"]);
      const head = await git(dir, ["rev-parse", "HEAD"]);
      const { result } = await runEngine(dir, base, head);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]).toMatchObject({
        path: "src/new.ts",
        oldPath: "src/old.ts",
        status: "renamed",
      });
      expect(result.files[0]?.skipReason).toBeUndefined();
      expect(result.files[0]?.hunks).toEqual([]);
      expect(result.files[0]?.symbols).toEqual([]);
      expect(result.files[0]?.commentableLines).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe("filters", () => {
  test("binary, lockfile, ignored, generated, and too-large each carry a skip reason", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(
        dir,
        {
          "asset/logo.png": "placeholder\n",
          "src/keep.ts": "const a = 1;\n",
        },
        "base",
      );
      const head = await writeAndCommit(
        dir,
        {
          "asset/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]),
          "src/keep.ts": "const a = 2;\n",
          "yarn.lock": "lock v1\nlock v2\n",
          "gen/out.ts": "export const g = 1;\n",
          "src/gen.ts": "// @generated by tool\nexport const g = 1;\n",
          "big/data.ts": `${"x".repeat(1500)}\n`,
          "chatty/log.ts": "a\nb\nc\nd\n",
        },
        "head",
      );
      const config = defaults({
        review: { max_file_size_kb: 1, max_changed_lines_per_file: 2 },
        ignore: { paths: ["gen/**"] },
      });
      const { result } = await runEngine(dir, base, head, config);
      const byPath = new Map(result.files.map((file) => [file.path, file]));
      expect(byPath.get("asset/logo.png")?.skipReason).toBe("binary");
      // yarn.lock matches the default `**/*.lock` ignore too; lockfile wins.
      expect(byPath.get("yarn.lock")?.skipReason).toBe("lockfile");
      expect(byPath.get("gen/out.ts")?.skipReason).toBe("ignored");
      expect(byPath.get("src/gen.ts")?.skipReason).toBe("generated");
      expect(byPath.get("big/data.ts")?.skipReason).toBe("too-large");
      expect(byPath.get("chatty/log.ts")?.skipReason).toBe("too-large");
      for (const file of result.files) {
        if (file.skipReason !== undefined) {
          expect(file.hunks).toEqual([]);
          expect(file.commentableLines).toEqual([]);
          expect(file.symbols).toEqual([]);
        }
      }
      // Control: the one clean file is fully analyzed.
      expect(byPath.get("src/keep.ts")?.skipReason).toBeUndefined();
      expect(byPath.get("src/keep.ts")?.symbols).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  test("minified bundles skip as ignored under defaults", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/app.ts": "const a = 1;\n" }, "base");
      const head = await writeAndCommit(
        dir,
        {
          "src/app.ts": "const a = 2;\n",
          "bundle.min.js": "var a=1;\nvar b=2;\n",
          "public/assets/app.min.css": "a{color:red}\n",
        },
        "head",
      );
      const { result } = await runEngine(dir, base, head);
      const byPath = new Map(result.files.map((file) => [file.path, file]));
      expect(byPath.get("bundle.min.js")?.skipReason).toBe("ignored");
      expect(byPath.get("public/assets/app.min.css")?.skipReason).toBe("ignored");
      expect(byPath.get("src/app.ts")?.skipReason).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("generated marker outside the header window does not skip", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const clean = `${"// filler\n".repeat(21)}// @generated\n`;
      const base = await writeAndCommit(dir, { "src/late.ts": "const a = 1;\n" }, "base");
      const head = await writeAndCommit(dir, { "src/late.ts": clean }, "head");
      const { result } = await runEngine(dir, base, head);
      expect(result.files[0]?.skipReason).toBeUndefined();
      expect(result.files[0]?.symbols).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});

describe("deletion-only edits", () => {
  test("file surviving at head keeps a module symbol with empty changedLines", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(
        dir,
        { "src/shrink.ts": "one\ntwo\nthree\nfour\n" },
        "base",
      );
      const head = await writeAndCommit(dir, { "src/shrink.ts": "one\nfour\n" }, "head");
      const { result } = await runEngine(dir, base, head);
      expect(result.files[0]?.skipReason).toBeUndefined();
      expect(result.files[0]?.hunks.length).toBeGreaterThan(0);
      expect(result.files[0]?.symbols).toEqual([
        { name: "<module>", kind: "module", startLine: 1, endLine: 2, changedLines: [] },
      ]);
    } finally {
      await cleanup();
    }
  });
});

describe("empty and invalid inputs", () => {
  test("equal SHAs return an empty file list", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const head = await writeAndCommit(dir, { "src/a.ts": "const a = 1;\n" }, "only");
      const { result, calls } = await runEngine(dir, head, head);
      expect(result.baseSha).toBe(head.toLowerCase());
      expect(result.headSha).toBe(head.toLowerCase());
      expect(result.mergeBase).toBe(head.toLowerCase());
      expect(result.files).toEqual([]);
      expect(calls.find((call) => call.level === "info")?.fields).toMatchObject({ filesTotal: 0 });
    } finally {
      await cleanup();
    }
  });

  test("abbreviated SHA fails as GIT_FAILED", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const head = await writeAndCommit(dir, { "src/a.ts": "const a = 1;\n" }, "only");
      const { logger } = makeLogger();
      const error = await new GitDiffEngine({ logger })
        .run({ repoDir: dir, baseSha: head.slice(0, 7), headSha: head, config: defaults() })
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      expect(codeOf(error)).toBe("GIT_FAILED");
    } finally {
      await cleanup();
    }
  });

  test("missing commit fails without fetching", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const head = await writeAndCommit(dir, { "src/a.ts": "const a = 1;\n" }, "only");
      const { logger } = makeLogger();
      const error = await new GitDiffEngine({ logger })
        .run({
          repoDir: dir,
          baseSha: head,
          headSha: "0123456789abcdef0123456789abcdef01234567",
          config: defaults(),
        })
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      expect(codeOf(error)).toBe("GIT_FAILED");
    } finally {
      await cleanup();
    }
  });

  test("non-repository directory fails as GIT_FAILED", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codebleach-p2-07-norepo-"));
    try {
      const { logger } = makeLogger();
      const head = "0123456789abcdef0123456789abcdef01234567";
      const error = await new GitDiffEngine({ logger })
        .run({ repoDir: dir, baseSha: head, headSha: head, config: defaults() })
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      expect(codeOf(error)).toBe("GIT_FAILED");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unrelated histories fail on merge base", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const first = await writeAndCommit(dir, { "a.txt": "a\n" }, "first");
      await git(dir, ["checkout", "--orphan", "unrelated", "--quiet"]);
      await git(dir, ["rm", "-rf", ".", "--quiet"]);
      const second = await writeAndCommit(dir, { "z.txt": "z\n" }, "second root");
      const { logger } = makeLogger();
      const error = await new GitDiffEngine({ logger })
        .run({ repoDir: dir, baseSha: first, headSha: second, config: defaults() })
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      expect(codeOf(error)).toBe("GIT_FAILED");
      expect((error as Error).message).toMatch(/merge base/i);
    } finally {
      await cleanup();
    }
  });
});

describe("worktree and config determinism", () => {
  test("dirty worktree does not affect output", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/app.ts": "one\ntwo\nthree\n" }, "base");
      const head = await writeAndCommit(dir, { "src/app.ts": "one\nTWO\nthree\n" }, "head");
      const before = await runEngine(dir, base, head);
      await writeFile(join(dir, "src/app.ts"), "DIRTY UNCOMMITTED\n");
      await writeFile(join(dir, "src/untracked.ts"), "untracked\n");
      const after = await runEngine(dir, base, head);
      expect(after.result).toEqual(before.result);
    } finally {
      await cleanup();
    }
  });

  test("hostile git config leaves hunks and positions unchanged with no copies", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const body = Array.from({ length: 12 }, (_, index) => `line${index + 1}`).join("\n");
      const base = await writeAndCommit(
        dir,
        { "src/app.ts": `${body}\n`, "src/copy.ts": `${body}\n` },
        "base",
      );
      const changed = body.split("\n");
      changed[1] = "CHANGED";
      changed[6] = "CHANGED";
      const head = await writeAndCommit(
        dir,
        {
          "src/app.ts": `${changed.join("\n")}\n`,
          "src/copy.ts": `${body}\n`,
          "src/clone.ts": `${body}\n`,
        },
        "head",
      );
      const plain = await runEngine(dir, base, head);
      await git(dir, ["config", "diff.interHunkContext", "10"]);
      await git(dir, ["config", "diff.algorithm", "patience"]);
      await git(dir, ["config", "diff.renames", "copies"]);
      try {
        const hostile = await runEngine(dir, base, head);
        expect(hostile.result).toEqual(plain.result);
      } finally {
        await git(dir, ["config", "--unset", "diff.interHunkContext"]);
        await git(dir, ["config", "--unset", "diff.algorithm"]);
        await git(dir, ["config", "--unset", "diff.renames"]);
      }
    } finally {
      await cleanup();
    }
  });

  test("indent heuristic config leaves hunks, positions, and commentable lines unchanged", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      // Deleting one of three identical unindented lines next to an indented
      // block: the indent heuristic slides the deletion hunk (oldLine 3 vs 4).
      const baseLines = ["end;", "def f():", "def f():", "def f():", "    x = 1;", "{", "    foo();"];
      const headLines = ["end;", "def f():", "def f():", "    x = 1;", "{", "    foo();"];
      const base = await writeAndCommit(dir, { "src/app.ts": `${baseLines.join("\n")}\n` }, "base");
      const head = await writeAndCommit(dir, { "src/app.ts": `${headLines.join("\n")}\n` }, "head");
      const plain = await runEngine(dir, base, head);
      await git(dir, ["config", "diff.indentHeuristic", "true"]);
      try {
        const heuristic = await runEngine(dir, base, head);
        await git(dir, ["config", "diff.indentHeuristic", "false"]);
        const noHeuristic = await runEngine(dir, base, head);
        expect(noHeuristic.result).toEqual(heuristic.result);
        expect(heuristic.result).toEqual(plain.result);
        const file = heuristic.result.files[0];
        expect(file?.hunks).toHaveLength(1);
        expect(file?.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 7, newStart: 1, newLines: 6 });
        const lines = file?.hunks[0]?.lines ?? [];
        expect(lines.map((line) => line.kind)).toEqual(["ctx", "ctx", "ctx", "del", "ctx", "ctx", "ctx"]);
        expect(lines.map((line) => [line.oldLine, line.newLine])).toEqual([
          [1, 1],
          [2, 2],
          [3, 3],
          [4, null],
          [5, 4],
          [6, 5],
          [7, 6],
        ]);
        expect(lines.map((line) => line.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(file?.commentableLines).toEqual([1, 2, 3, 4, 5, 6]);
        expect(file?.symbols).toEqual([
          { name: "<module>", kind: "module", startLine: 1, endLine: 6, changedLines: [] },
        ]);
      } finally {
        await git(dir, ["config", "--unset", "diff.indentHeuristic"]).catch(() => {});
      }
    } finally {
      await cleanup();
    }
  });

  test("pinned diff flags cover both invocations including indent heuristic", () => {
    expect(PINNED_DIFF_FLAGS).toEqual([
      "--diff-algorithm=myers",
      "--inter-hunk-context=0",
      "--find-renames=50%",
      "--no-indent-heuristic",
    ]);
  });

  test("logger receives one summary and the engine mints no run id", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/a.ts": "const a = 1;\n" }, "base");
      const head = await writeAndCommit(dir, { "src/a.ts": "const a = 2;\n" }, "head");
      const { calls } = await runEngine(dir, base, head);
      const summaries = calls.filter((call) => call.level === "info");
      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.fields).toMatchObject({
        filesTotal: 1,
        filesAnalyzed: 1,
        filesSkipped: 0,
        additions: 1,
        deletions: 1,
        hunks: 1,
        binaryFiles: 0,
        renamedFiles: 0,
      });
      for (const call of calls) {
        expect(call.fields["runId"]).toBeUndefined();
        expect(call.msg).not.toMatch(/runId/i);
      }
    } finally {
      await cleanup();
    }
  });
});
