import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { ReviewerError } from "../core/errors.ts";
import { runProcess } from "../utils/spawn.ts";

export type CommitShaLabel = "baseSha" | "headSha";

export interface ResolvedRepoCommits {
  repoRoot: string;
  baseSha: string;
  headSha: string;
  mergeBase: string;
}

const FULL_SHA_PATTERN = /^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/;

function gitFailed(message: string, cause?: unknown): ReviewerError {
  return cause === undefined
    ? new ReviewerError({ code: "GIT_FAILED", message })
    : new ReviewerError({ code: "GIT_FAILED", message, cause });
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

// Full 40-hex (SHA-1) or 64-hex (SHA-256) only; refs and abbreviated SHAs rejected.
export function isFullCommitSha(value: string): boolean {
  return typeof value === "string" && FULL_SHA_PATTERN.test(value);
}

// Validates before any Git call and normalizes to lowercase.
export function normalizeCommitSha(value: string, label: CommitShaLabel): string {
  if (!isFullCommitSha(value)) {
    throw gitFailed(`${label} must be a full 40- or 64-character hex commit SHA`);
  }
  return value.toLowerCase();
}

// Resolves repoDir to its canonical absolute path and requires it to be the
// repository root itself (subdirectories rejected so later Git reads are rooted).
export async function resolveRepoRoot(repoDir: string): Promise<string> {
  if (typeof repoDir !== "string" || repoDir.length === 0) {
    throw gitFailed("repoDir must be a non-empty path");
  }
  let canonical: string;
  try {
    canonical = await realpath(resolve(repoDir));
  } catch (cause) {
    throw gitFailed(`cannot access repoDir "${repoDir}"`, cause);
  }
  let toplevelRaw: string;
  try {
    const result = await runProcess({ cmd: ["git", "rev-parse", "--show-toplevel"], cwd: canonical });
    toplevelRaw = decode(result.stdout).replace(/\r?\n$/, "");
  } catch (cause) {
    throw gitFailed(`"${repoDir}" is not inside a Git repository`, cause);
  }
  let canonicalTop: string;
  try {
    canonicalTop = await realpath(resolve(toplevelRaw));
  } catch (cause) {
    throw gitFailed(`cannot resolve repository top-level "${toplevelRaw}"`, cause);
  }
  if (canonicalTop !== canonical) {
    throw gitFailed(`repoDir "${repoDir}" must be the repository root ("${canonicalTop}")`);
  }
  return canonical;
}

// Verifies the SHA names a commit object; caller validates shape first via normalizeCommitSha.
export async function resolveCommitSha(
  repoRoot: string,
  sha: string,
  label: CommitShaLabel,
): Promise<string> {
  const normalized = normalizeCommitSha(sha, label);
  let resolved: string;
  try {
    const result = await runProcess({
      cmd: ["git", "rev-parse", "--verify", `${normalized}^{commit}`],
      cwd: repoRoot,
    });
    resolved = decode(result.stdout).trim().toLowerCase();
  } catch (cause) {
    throw gitFailed(
      `${label} "${normalized}" does not resolve to a commit; fetch sufficient history locally (no fetch is performed automatically)`,
      cause,
    );
  }
  if (!isFullCommitSha(resolved)) {
    throw gitFailed(`${label} resolved to an unexpected non-SHA value`);
  }
  return resolved;
}

export async function resolveMergeBase(
  repoRoot: string,
  baseSha: string,
  headSha: string,
): Promise<string> {
  let mergeBase: string;
  try {
    const result = await runProcess({ cmd: ["git", "merge-base", baseSha, headSha], cwd: repoRoot });
    mergeBase = decode(result.stdout).trim().toLowerCase();
  } catch (cause) {
    throw gitFailed(
      "no merge base between base and head; unrelated histories or shallow checkout require fetching sufficient history locally (no fetch is performed automatically)",
      cause,
    );
  }
  if (!isFullCommitSha(mergeBase)) {
    throw gitFailed("merge-base returned an unexpected non-SHA value");
  }
  return mergeBase;
}

// Validates root and both SHAs, then resolves the merge base.
// Equal SHAs short-circuit: mergeBase is that commit, no Git lookup needed.
export async function resolveRepoAndCommits(input: {
  repoDir: string;
  baseSha: string;
  headSha: string;
}): Promise<ResolvedRepoCommits> {
  const repoRoot = await resolveRepoRoot(input.repoDir);
  const baseSha = await resolveCommitSha(repoRoot, input.baseSha, "baseSha");
  const headSha = await resolveCommitSha(repoRoot, input.headSha, "headSha");
  const mergeBase = baseSha === headSha ? baseSha : await resolveMergeBase(repoRoot, baseSha, headSha);
  return { repoRoot, baseSha, headSha, mergeBase };
}
