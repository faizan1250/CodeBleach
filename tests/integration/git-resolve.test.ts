import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewerError } from "../../src/core/errors.ts";
import { resolveCommitSha, resolveMergeBase, resolveRepoAndCommits, resolveRepoRoot } from "../../src/diff/git.ts";
import { runProcess } from "../../src/utils/spawn.ts";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function git(dir: string, args: string[]): Promise<string> {
  const result = await runProcess({ cmd: ["git", ...args], cwd: dir });
  return decode(result.stdout).trim();
}

async function makeRepo(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "codebleach-p2-03-"));
  const cleanup = (): Promise<void> => rm(dir, { recursive: true, force: true });
  try {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.name", "CodeBleach Test"]);
    await git(dir, ["config", "user.email", "p2-03@codebleach.local"]);
    await git(dir, ["config", "commit.gpgsign", "false"]);
    return { dir, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function commitFile(dir: string, name: string, content: string, message: string): Promise<string> {
  await writeFile(join(dir, name), content);
  await git(dir, ["add", name]);
  await git(dir, ["commit", "-m", message, "--quiet"]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function codeOf(error: unknown): string {
  expect(error).toBeInstanceOf(ReviewerError);
  return (error as ReviewerError).code;
}

describe("resolveRepoRoot", () => {
  test("resolves the canonical root of a valid repository", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      expect(await resolveRepoRoot(dir)).toBe(await realpath(dir));
    } finally {
      await cleanup();
    }
  });

  test("rejects a repository subdirectory", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const sub = join(dir, "sub");
      await mkdir(sub, { recursive: true });
      const error = await resolveRepoRoot(sub).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(codeOf(error)).toBe("GIT_FAILED");
      expect((error as Error).message).toMatch(/repository root/);
    } finally {
      await cleanup();
    }
  });

  test("rejects a non-repository directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codebleach-p2-03-norepo-"));
    try {
      const error = await resolveRepoRoot(dir).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(codeOf(error)).toBe("GIT_FAILED");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("scrubbed GIT_DIR does not break resolution", async () => {
    const { dir, cleanup } = await makeRepo();
    const prior = process.env["GIT_DIR"];
    process.env["GIT_DIR"] = join(dir, "does-not-exist");
    try {
      expect(await resolveRepoRoot(dir)).toBe(await realpath(dir));
    } finally {
      if (prior === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = prior;
      await cleanup();
    }
  });

  test("resolves a linked worktree to the worktree root", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      await commitFile(dir, "a.txt", "a\n", "base");
      const worktree = `${dir}-wt`;
      try {
        await git(dir, ["worktree", "add", "--detach", worktree]);
      } catch {
        return;
      }
      try {
        expect(await resolveRepoRoot(worktree)).toBe(await realpath(worktree));
      } finally {
        await git(dir, ["worktree", "remove", "--force", worktree]).catch(() => {});
        await rm(worktree, { recursive: true, force: true });
      }
    } finally {
      await cleanup();
    }
  });
});

describe("resolveCommitSha", () => {
  test("resolves valid base and head SHAs and lowercases input", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await commitFile(dir, "a.txt", "a\n", "base");
      const head = await commitFile(dir, "b.txt", "b\n", "head");
      const root = await resolveRepoRoot(dir);
      expect(await resolveCommitSha(root, base, "baseSha")).toBe(base.toLowerCase());
      expect(await resolveCommitSha(root, head.toUpperCase(), "headSha")).toBe(head.toLowerCase());
    } finally {
      await cleanup();
    }
  });

  test("rejects abbreviated SHAs before Git", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await commitFile(dir, "a.txt", "a\n", "base");
      const error = await resolveCommitSha(dir, base.slice(0, 7), "baseSha").then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(codeOf(error)).toBe("GIT_FAILED");
      expect((error as Error).message).toMatch(/baseSha/);
    } finally {
      await cleanup();
    }
  });

  test("rejects a well-formed but missing commit without fetching", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      await commitFile(dir, "a.txt", "a\n", "base");
      const root = await resolveRepoRoot(dir);
      const missing = "0123456789abcdef0123456789abcdef01234567";
      const error = await resolveCommitSha(root, missing, "headSha").then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(codeOf(error)).toBe("GIT_FAILED");
      expect((error as Error).message).toMatch(/headSha/);
    } finally {
      await cleanup();
    }
  });
});

describe("resolveMergeBase", () => {
  test("finds the merge base of divergent branches", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await commitFile(dir, "a.txt", "a\n", "base");
      await git(dir, ["checkout", "-b", "side-a", "--quiet"]);
      await commitFile(dir, "a.txt", "a-side\n", "side a");
      await git(dir, ["checkout", "-b", "side-b", base, "--quiet"]);
      const head = await commitFile(dir, "b.txt", "b-side\n", "side b");
      const root = await resolveRepoRoot(dir);
      expect(await resolveMergeBase(root, base, head)).toBe(base.toLowerCase());
    } finally {
      await cleanup();
    }
  });

  test("fails on unrelated histories with an actionable message", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const first = await commitFile(dir, "a.txt", "a\n", "first");
      await git(dir, ["checkout", "--orphan", "unrelated", "--quiet"]);
      await git(dir, ["rm", "-rf", ".", "--quiet"]);
      const second = await commitFile(dir, "z.txt", "z\n", "second root");
      const root = await resolveRepoRoot(dir);
      const error = await resolveMergeBase(root, first, second).then(
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

describe("resolveRepoAndCommits", () => {
  test("resolves root, commits, and merge base together", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await commitFile(dir, "a.txt", "a\n", "base");
      const head = await commitFile(dir, "b.txt", "b\n", "head");
      const resolved = await resolveRepoAndCommits({ repoDir: dir, baseSha: base, headSha: head });
      expect(resolved.repoRoot).toBe(await realpath(dir));
      expect(resolved.baseSha).toBe(base.toLowerCase());
      expect(resolved.headSha).toBe(head.toLowerCase());
      expect(resolved.mergeBase).toBe(base.toLowerCase());
    } finally {
      await cleanup();
    }
  });

  test("maps equal SHAs to an empty-diff merge base without Git lookup", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const head = await commitFile(dir, "a.txt", "a\n", "only");
      const resolved = await resolveRepoAndCommits({
        repoDir: dir,
        baseSha: head.toUpperCase(),
        headSha: head,
      });
      expect(resolved.mergeBase).toBe(head.toLowerCase());
      expect(resolved.baseSha).toBe(resolved.headSha);
    } finally {
      await cleanup();
    }
  });
});
