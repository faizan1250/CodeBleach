import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../src/utils/spawn.ts";

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
