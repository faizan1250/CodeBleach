import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import { ReviewerError } from "../../src/core/errors.ts";
import type { DiffResult } from "../../src/types/index.ts";
import { runProcess } from "../../src/utils/spawn.ts";
import { GitValidationSnapshotReader } from "../../src/validate/snapshot.ts";
import { createValidationEngine } from "../../src/validate/engine.ts";
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
  options?: { maxFileBytes?: number | undefined; maxTotalBytes?: number | undefined },
): GitValidationSnapshotReader {
  return new GitValidationSnapshotReader({ repoDir: dir, headSha, mergeBase, ...(options ?? {}) });
}

describe("validation snapshot against real commits", () => {
  test("dirty worktree cannot influence head or base reads", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/a.ts": "const v = 1;\n" }, "base");
      const head = await writeAndCommit(dir, { "src/a.ts": "const v = 2;\n" }, "head");
      await writeFile(join(dir, "src/a.ts"), "const v = 999;\n");
      const reader = readerFor(dir, head, base);
      expect(await reader.readHead("src/a.ts")).toEqual({ status: "ok", text: "const v = 2;\n", bytes: 13 });
      expect(await reader.readBase("src/a.ts")).toEqual({ status: "ok", text: "const v = 1;\n", bytes: 13 });
    } finally {
      await cleanup();
    }
  });

  test("rename reads the old path at merge base and the new path at head", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/old.ts": "export const x = 1;\n" }, "base");
      await git(dir, ["mv", "src/old.ts", "src/new.ts"]);
      await git(dir, ["commit", "-m", "rename", "--quiet"]);
      const head = await git(dir, ["rev-parse", "HEAD"]);
      const reader = readerFor(dir, head, base);
      expect((await reader.readBase("src/old.ts")).status).toBe("ok");
      expect((await reader.readHead("src/new.ts")).status).toBe("ok");
      expect((await reader.readHead("src/old.ts")).status).toBe("not_found");
      expect((await reader.readBase("src/new.ts")).status).toBe("not_found");
    } finally {
      await cleanup();
    }
  });

  test("missing path is not_found and unapproved paths never spawn git", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/a.ts": "const v = 1;\n" }, "base");
      const reader = readerFor(dir, base, base);
      expect((await reader.readHead("src/gone.ts")).status).toBe("not_found");
      const before = reader.stats().gitCalls;
      expect((await reader.readHead("/abs.ts")).status).toBe("invalid_path");
      expect((await reader.readHead("../up.ts")).status).toBe("invalid_path");
      expect(reader.stats().gitCalls).toBe(before);
    } finally {
      await cleanup();
    }
  });

  test("symlink entries are unsupported", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/real.ts": "export const x = 1;\n" }, "base");
      const blob = await git(dir, ["hash-object", "-w", "src/real.ts"]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `120000,${blob},link.ts`]);
      await git(dir, ["commit", "-m", "links", "--quiet"]);
      const head = await git(dir, ["rev-parse", "HEAD"]);
      const reader = readerFor(dir, head, base);
      expect((await reader.readHead("link.ts")).status).toBe("unsupported");
    } finally {
      await cleanup();
    }
  });

  test("binary blobs are binary, never ok", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const full = join(dir, "src", "bin.dat");
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, new Uint8Array([0x61, 0x00, 0x0a, 0xff, 0x62]));
      await git(dir, ["add", "-A"]);
      await git(dir, ["commit", "-m", "binary", "--quiet"]);
      const base = await git(dir, ["rev-parse", "HEAD"]);
      const reader = readerFor(dir, base, base);
      expect((await reader.readHead("src/bin.dat")).status).toBe("binary");
    } finally {
      await cleanup();
    }
  });

  test("per-file cap is enforced deterministically", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/a.ts": `${"x".repeat(100)}\n` }, "base");
      const reader = readerFor(dir, base, base, { maxFileBytes: 10 });
      expect((await reader.readHead("src/a.ts")).status).toBe("size_limit");
    } finally {
      await cleanup();
    }
  });

  test("cumulative total cap is enforced deterministically", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/a.ts": "aaa", "src/b.ts": "bbb" }, "base");
      const reader = readerFor(dir, base, base, { maxTotalBytes: 5 });
      expect((await reader.readHead("src/a.ts")).status).toBe("ok");
      expect((await reader.readHead("src/b.ts")).status).toBe("size_limit");
    } finally {
      await cleanup();
    }
  });

  test("committed tree pointing at a missing blob reads as not_found", async () => {
    const { dir, cleanup } = await makeRepo();
    let head = "";
    try {
      const base = await writeAndCommit(dir, { "src/a.ts": "const v = 1;\n" }, "base");
      const ghostOid = "f".repeat(40);
      const treeOut = await runProcess({
        cmd: ["git", "mktree", "--missing"],
        cwd: dir,
        stdinData: `100644 blob ${ghostOid}\tghost.ts\n`,
      });
      const tree = new TextDecoder().decode(treeOut.stdout).trim();
      const commitOut = await runProcess({
        cmd: ["git", "commit-tree", tree, "-p", base, "-m", "ghost"],
        cwd: dir,
      });
      head = new TextDecoder().decode(commitOut.stdout).trim();
      await git(dir, ["update-ref", "HEAD", head]);
      const reader = readerFor(dir, head, base);
      expect((await reader.readHead("ghost.ts")).status).toBe("not_found");
      expect((await reader.readBase("src/a.ts")).status).toBe("ok");
    } finally {
      await cleanup();
    }
  });

  test("repeated evidence reads are deduplicated within one run", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/a.ts": "const v = 1;\n" }, "base");
      const reader = readerFor(dir, base, base);
      expect((await reader.readHead("src/a.ts")).status).toBe("ok");
      const afterFirst = reader.stats().gitCalls;
      expect((await reader.readHead("src/a.ts")).status).toBe("ok");
      expect(reader.stats().gitCalls).toBe(afterFirst);
      expect(reader.stats().cacheHits).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("fresh reader per run starts with an empty cache", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/a.ts": "const v = 1;\n" }, "base");
      const first = readerFor(dir, base, base);
      expect((await first.readHead("src/a.ts")).status).toBe("ok");
      expect(first.stats().entries).toBe(1);
      const second = readerFor(dir, base, base);
      expect(second.stats().entries).toBe(0);
      expect((await second.readHead("src/a.ts")).status).toBe("ok");
      expect(second.stats().cacheHits).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("engine wiring never accepts, even with a contradictory worktree", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/a.ts": "const v = 1;\n" }, "base");
      const head = await writeAndCommit(dir, { "src/a.ts": "const v = 2;\n" }, "head");
      await writeFile(join(dir, "src/a.ts"), "const v = 999;\n");
      const engine = createValidationEngine({ repoDir: dir });
      const diff: DiffResult = { baseSha: base, headSha: head, mergeBase: base, files: [] };
      const result = await engine.validate([], diff, [], ConfigFileSchema.parse({}));
      expect(result).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("corrupt repository fails loudly instead of returning empty success", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const missing = join(dir, "definitely-not-a-repo");
      await rm(missing, { recursive: true, force: true });
      const reader = readerFor(missing, "c".repeat(40), "d".repeat(40));
      await expect(reader.readHead("src/a.ts")).rejects.toThrow(ReviewerError);
    } finally {
      await cleanup();
    }
  });
});
