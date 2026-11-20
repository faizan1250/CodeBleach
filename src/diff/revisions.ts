import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { ReviewerError } from "../core/errors.ts";
import { runProcess } from "../utils/spawn.ts";
import { decode, gitFailed } from "./git-exec.ts";

export type CommitShaLabel = "baseSha" | "headSha";

export interface ResolvedRepoCommits {
  repoRoot: string;
  baseSha: string;
  headSha: string;
  mergeBase: string;
}

const FULL_SHA_PATTERN = /^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/;

// Full 40-hex (SHA-1) or 64-hex (SHA-256) only; refs and abbreviated SHAs rejected.
export function isFullCommitSha(value: string): boolean {
  return typeof value === "string" && FULL_SHA_PATTERN.test(value);
}

function invalidInput(message: string): ReviewerError {
  return new ReviewerError({ code: "INVALID_INPUT", message });
}

// Validates before any Git call and normalizes to lowercase.
// Dash-prefixed input is INVALID_INPUT (CLI usage error, pre-Git); other
// malformed shapes stay GIT_FAILED so the engine remains full-SHA-only.
export function normalizeCommitSha(value: string, label: CommitShaLabel): string {
  if (typeof value === "string" && value.startsWith("-")) {
    throw invalidInput(`${label} must not start with "-": ${JSON.stringify(value)}`);
  }
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
export async function resolveCommitSha(repoRoot: string, sha: string, label: CommitShaLabel): Promise<string> {
  const normalized = normalizeCommitSha(sha, label);
  let resolved: string;
  try {
    const result = await runProcess({
      cmd: ["git", "rev-parse", "--verify", "--end-of-options", `${normalized}^{commit}`],
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

// CLI-level revision resolution (GREEN, ADR 0010): accepts full SHAs,
// symbolic refs (HEAD, HEAD~1, branches), and unique abbrevs; rejects
// dash-prefixed input pre-Git as INVALID_INPUT; resolves via
// `git rev-parse --verify --end-of-options <rev>^{commit}` argv-only;
// verifies the object is a commit; ambiguous/unknown/malformed revs are
// INVALID_INPUT (exit 2); well-formed-but-missing commits are GIT_FAILED
// with a fetch hint (exit 1). Engine stays full-SHA-only.
export async function resolveRevision(repoRoot: string, rev: string, label: CommitShaLabel): Promise<string> {
  if (typeof rev !== "string" || rev.length === 0) {
    throw invalidInput(`${label} must be a non-empty revision`);
  }
  if (rev.startsWith("-")) {
    throw invalidInput(`${label} revision ${JSON.stringify(rev)} must not start with "-"`);
  }
  let resolved: string;
  try {
    const result = await runProcess({
      cmd: ["git", "rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`],
      cwd: repoRoot,
    });
    resolved = decode(result.stdout).trim().toLowerCase();
  } catch (cause) {
    if (isFullCommitSha(rev)) {
      const lowered = rev.toLowerCase();
      let exists = false;
      try {
        await runProcess({
          cmd: ["git", "cat-file", "-e", lowered],
          cwd: repoRoot,
        });
        exists = true;
      } catch {
        exists = false;
      }
      if (exists) {
        throw invalidInput(`${label} "${lowered}" names a non-commit object; expected a commit (INVALID_INPUT)`);
      }
      throw gitFailed(
        `${label} "${lowered}" does not resolve to a commit; fetch sufficient history locally (no fetch is performed automatically)`,
        cause,
      );
    }
    throw invalidInput(`${label} revision ${JSON.stringify(rev)} does not resolve to a commit (INVALID_INPUT)`);
  }
  if (!isFullCommitSha(resolved)) {
    throw gitFailed(`${label} resolved to an unexpected non-SHA value`);
  }
  return resolved;
}

export async function resolveMergeBase(repoRoot: string, baseSha: string, headSha: string): Promise<string> {
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
