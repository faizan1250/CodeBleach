import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ReviewerError } from "../../src/core/errors.ts";
import { SnapshotReader } from "../../src/context/snapshot.ts";
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

function readerFor(
  dir: string,
  headSha: string,
  mergeBase: string,
  options: { maxBlobBytes?: number; maxTotalBytes?: number } = {},
): SnapshotReader {
  return new SnapshotReader({ repoRoot: dir, headSha, mergeBase, ...options });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ReviewerError);
  return (error as ReviewerError).code;
}

describe("head and merge-base snapshots", () => {
  test("reads the committed head blob and ignores worktree edits", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/a.ts": "const v = 1;\n" }, "base");
      const head = await writeAndCommit(dir, { "src/a.ts": "const v = 2;\n" }, "head");
      await writeFile(join(dir, "src/a.ts"), "const v = 999;\n");
      const reader = readerFor(dir, head, base);
      expect(await reader.readHeadText("src/a.ts")).toBe("const v = 2;\n");
      expect(await reader.readBaseText("src/a.ts")).toBe("const v = 1;\n");
    } finally {
      await cleanup();
    }
  });

  test("untracked files are invisible to the index and search", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/a.ts": "function listed(): number { return 1; }\n" }, "base");
      const head = await writeAndCommit(dir, { "src/a.ts": "function listed(): number { return 2; }\n" }, "head");
      await writeFile(join(dir, "src/extra.ts"), "function listed(): number { return 999; }\n");
      const reader = readerFor(dir, head, base);
      expect((await reader.listHeadFiles()).has("src/extra.ts")).toBe(false);
      const matches = await reader.grepHead("listed");
      expect(matches.every((match) => match.path !== "src/extra.ts")).toBe(true);
      expect(matches.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  test("unusual repo paths round-trip through index and read", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "sub/sp ace.ts": "export const x = 1;\n" }, "base");
      const reader = readerFor(dir, base, base);
      expect((await reader.listHeadFiles()).has("sub/sp ace.ts")).toBe(true);
      expect(await reader.readHeadText("sub/sp ace.ts")).toBe("export const x = 1;\n");
    } finally {
      await cleanup();
    }
  });

  test("rename reads old path at merge base and new path at head", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/old.ts": "export const x = 1;\n" }, "base");
      await git(dir, ["mv", "src/old.ts", "src/new.ts"]);
      await git(dir, ["commit", "-m", "rename", "--quiet"]);
      const head = await git(dir, ["rev-parse", "HEAD"]);
      const reader = readerFor(dir, head, base);
      expect(await reader.readBaseText("src/old.ts")).toBe("export const x = 1;\n");
      expect(await reader.readHeadText("src/new.ts")).toBe("export const x = 1;\n");
      expect(await codeOf(reader.readHeadText("src/old.ts"))).toBe("GIT_FAILED");
      expect(await codeOf(reader.readBaseText("src/new.ts"))).toBe("GIT_FAILED");
    } finally {
      await cleanup();
    }
  });

  test("symlink and gitlink entries are not loaded as source", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/real.ts": "export const x = 1;\n" }, "base");
      const blob = await git(dir, ["hash-object", "-w", "src/real.ts"]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `120000,${blob},link.ts`]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `160000,${base},vendor/dep`]);
      await git(dir, ["commit", "-m", "links", "--quiet"]);
      const head = await git(dir, ["rev-parse", "HEAD"]);
      const reader = readerFor(dir, head, base);
      const index = await reader.listHeadFiles();
      expect(index.get("link.ts")?.mode).toBe("120000");
      expect(index.get("vendor/dep")?.type).toBe("commit");
      expect(await codeOf(reader.readHeadText("link.ts"))).toBe("GIT_FAILED");
      expect(await codeOf(reader.readHeadText("vendor/dep"))).toBe("GIT_FAILED");
    } finally {
      await cleanup();
    }
  });

  test("missing object is GIT_FAILED", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/a.ts": "const v = 1;\n" }, "base");
      const reader = readerFor(dir, base, base);
      expect(await codeOf(reader.readBlobText("0".repeat(40)))).toBe("GIT_FAILED");
    } finally {
      await cleanup();
    }
  });

  test("blob-size cap is enforced before reading", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(
        dir,
        { "src/big.ts": `${"x".repeat(100)}\n`, "src/small.ts": "ok\n" },
        "base",
      );
      const reader = readerFor(dir, base, base, { maxBlobBytes: 10 });
      expect(await codeOf(reader.readHeadText("src/big.ts"))).toBe("GIT_FAILED");
      expect(await reader.readHeadText("src/small.ts")).toBe("ok\n");
    } finally {
      await cleanup();
    }
  });

  test("total-bytes cap stops further reads in the run", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(
        dir,
        { "src/one.ts": `${"a".repeat(50)}\n`, "src/two.ts": `${"b".repeat(50)}\n` },
        "base",
      );
      const reader = readerFor(dir, base, base, { maxTotalBytes: 60 });
      expect(await reader.readHeadText("src/one.ts")).toBe(`${"a".repeat(50)}\n`);
      expect(await codeOf(reader.readHeadText("src/two.ts"))).toBe("GIT_FAILED");
      expect(reader.cachedBytes).toBe(51);
    } finally {
      await cleanup();
    }
  });

  test("blob cache is shared by oid across head and base reads", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const content = "const same = true;\n";
      const base = await writeAndCommit(dir, { "src/a.ts": content }, "base");
      const reader = readerFor(dir, base, base);
      expect(await reader.readHeadText("src/a.ts")).toBe(content);
      expect(await reader.readBaseText("src/a.ts")).toBe(content);
      const oid = (await reader.listHeadFiles()).get("src/a.ts")?.oid;
      expect(oid).toBeDefined();
      expect(await reader.readBlobText(oid as string)).toBe(content);
      expect(reader.cachedEntries).toBe(1);
    } finally {
      await cleanup();
    }
  });
});

describe("head commit search", () => {
  test("reports committed matches with path, line, and text", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(
        dir,
        { "src/a.ts": "function target(): number { return 1; }\n// use target here\n" },
        "base",
      );
      const reader = readerFor(dir, base, base);
      expect(await reader.grepHead("target")).toEqual([
        { path: "src/a.ts", line: 1, text: "function target(): number { return 1; }" },
        { path: "src/a.ts", line: 2, text: "// use target here" },
      ]);
    } finally {
      await cleanup();
    }
  });

  test("no match yields an empty list", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/a.ts": "const v = 1;\n" }, "base");
      const reader = readerFor(dir, base, base);
      expect(await reader.grepHead("zzz-no-match-zzz")).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("worktree edits do not affect committed search results", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/a.ts": "function target(): number { return 1; }\n" }, "base");
      await writeFile(join(dir, "src/a.ts"), "function target(): number { return 999; }\n");
      await writeFile(join(dir, "src/worktree-only.ts"), "function target(): number { return 0; }\n");
      const reader = readerFor(dir, base, base);
      expect(await reader.grepHead("target")).toEqual([
        { path: "src/a.ts", line: 1, text: "function target(): number { return 1; }" },
      ]);
    } finally {
      await cleanup();
    }
  });
});
