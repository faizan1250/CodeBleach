import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { DiffEngine } from "../core/contracts.ts";
import { ReviewerError } from "../core/errors.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { ChangedFile, ChangedSymbol, DiffResult } from "../types/diff.ts";
import { DEFAULT_MAX_STDOUT_BYTES, runProcess } from "../utils/spawn.ts";
import { countChangedLines, selectSkipReason } from "./filters.ts";
import { parseNameStatusZ, parseUnifiedDiff } from "./parse.ts";
import type { ParsedFilePatch } from "./parse.ts";
import { getCommentableLines } from "./positions.ts";
import { detectLanguage, normalizeRepoPath } from "./paths.ts";

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

// Structural logger injected through the constructor. Matches the CLI logger
// shape without importing an engine implementation; run() takes no logger.
export interface DiffLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

// Pinned on both diff invocations so user/repo Git config cannot change output.
const PINNED_DIFF_FLAGS: readonly string[] = [
  "--diff-algorithm=myers",
  "--inter-hunk-context=0",
  "--find-renames=50%",
];

function invalidConfig(message: string): ReviewerError {
  return new ReviewerError({ code: "CONFIG_INVALID", message });
}

async function gitDiffBytes(repoRoot: string, args: readonly string[], what: string): Promise<Uint8Array> {
  try {
    return (await runProcess({ cmd: ["git", "diff", ...args], cwd: repoRoot })).stdout;
  } catch (cause) {
    if (cause instanceof ReviewerError && cause.code === "INTERNAL") throw cause;
    throw gitFailed(
      `${what} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}

async function headBlobSizeBytes(repoRoot: string, headSha: string, path: string): Promise<number> {
  let raw: string;
  try {
    const result = await runProcess({
      cmd: ["git", "cat-file", "-s", `${headSha}:${path}`],
      cwd: repoRoot,
    });
    raw = decode(result.stdout).trim();
  } catch (cause) {
    if (cause instanceof ReviewerError && cause.code === "INTERNAL") throw cause;
    throw gitFailed(
      `cannot read head blob size for "${path}": ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
  const size = Number(raw);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw gitFailed(`head blob size for "${path}" is not a valid byte count`);
  }
  return size;
}

async function headBlobContent(
  repoRoot: string,
  headSha: string,
  path: string,
  sizeBytes: number,
): Promise<Uint8Array> {
  try {
    // Bounded by the known blob size: overflow only when the configured byte
    // limit itself exceeds the spawn cap, which fails safe as GIT_FAILED.
    const result = await runProcess({
      cmd: ["git", "show", `${headSha}:${path}`],
      cwd: repoRoot,
      maxStdoutBytes: Math.min(sizeBytes + 1, DEFAULT_MAX_STDOUT_BYTES),
    });
    return result.stdout;
  } catch (cause) {
    if (cause instanceof ReviewerError && cause.code === "INTERNAL") throw cause;
    throw gitFailed(
      `cannot read head blob for "${path}": ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}

// LF count plus one for a final line without a newline; empty blob has no lines.
function countBlobLines(content: Uint8Array): number {
  let lines = 0;
  for (const byte of content) {
    if (byte === 0x0a) lines += 1;
  }
  if (content.length > 0 && content[content.length - 1] !== 0x0a) lines += 1;
  return lines;
}

// Phase 2 placeholder (ADR 0005): one coarse module symbol per eligible file.
// Lives here, not in a separate symbols.ts — a single pure function needs no module.
function moduleSymbol(headLineCount: number, patch: ParsedFilePatch): ChangedSymbol {
  const seen = new Set<number>();
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add" && line.newLine !== null) seen.add(line.newLine);
    }
  }
  return {
    name: "<module>",
    kind: "module",
    startLine: 1,
    endLine: Math.max(1, headLineCount),
    changedLines: [...seen].sort((a, b) => a - b),
  };
}

function skippedFile(
  patch: ParsedFilePatch,
  path: string,
  oldPath: string | null,
  skipReason: NonNullable<ChangedFile["skipReason"]>,
): ChangedFile {
  return {
    path,
    oldPath,
    status: patch.status,
    language: detectLanguage(path),
    skipReason,
    hunks: [],
    commentableLines: [],
    symbols: [],
  };
}

export class GitDiffEngine implements DiffEngine {
  private readonly logger: DiffLogger;

  constructor(deps: { logger: DiffLogger }) {
    const logger = deps?.logger;
    if (
      logger === null ||
      logger === undefined ||
      typeof logger.debug !== "function" ||
      typeof logger.info !== "function" ||
      typeof logger.warn !== "function" ||
      typeof logger.error !== "function"
    ) {
      throw new ReviewerError({
        code: "INTERNAL",
        message: "GitDiffEngine requires a logger with debug/info/warn/error methods",
      });
    }
    this.logger = logger;
  }

  async run(input: {
    repoDir: string;
    baseSha: string;
    headSha: string;
    config: ResolvedConfig;
  }): Promise<DiffResult> {
    if (input === null || input === undefined || typeof input !== "object") {
      throw invalidConfig("GitDiffEngine.run requires an input object");
    }
    const resolved = await resolveRepoAndCommits({
      repoDir: input.repoDir,
      baseSha: input.baseSha,
      headSha: input.headSha,
    });
    const empty: DiffResult = {
      baseSha: resolved.baseSha,
      headSha: resolved.headSha,
      mergeBase: resolved.mergeBase,
      files: [],
    };
    if (resolved.baseSha === resolved.headSha) {
      this.logSummary(empty);
      return empty;
    }
    const [metadataBytes, patchBytes] = await Promise.all([
      gitDiffBytes(
        resolved.repoRoot,
        ["--name-status", "-z", ...PINNED_DIFF_FLAGS, resolved.mergeBase, resolved.headSha, "--"],
        "git diff metadata",
      ),
      gitDiffBytes(
        resolved.repoRoot,
        [
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          ...PINNED_DIFF_FLAGS,
          "--unified=3",
          resolved.mergeBase,
          resolved.headSha,
          "--",
        ],
        "git diff patch",
      ),
    ]);
    const metadata = parseNameStatusZ(metadataBytes);
    const patches = parseUnifiedDiff(new TextDecoder("utf-8", { fatal: false }).decode(patchBytes), metadata);
    const files: ChangedFile[] = [];
    for (const patch of patches) {
      files.push(await this.buildFile(resolved.repoRoot, resolved.headSha, patch, input.config));
    }
    const result: DiffResult = {
      baseSha: resolved.baseSha,
      headSha: resolved.headSha,
      mergeBase: resolved.mergeBase,
      files,
    };
    this.logSummary(result);
    return result;
  }

  // Deleted/binary/lockfile/ignored/line-cap need no blob reads; byte cap
  // needs only cat-file -s; only surviving candidates pay for a blob show.
  private async buildFile(
    repoRoot: string,
    headSha: string,
    patch: ParsedFilePatch,
    config: ResolvedConfig,
  ): Promise<ChangedFile> {
    const path = normalizeRepoPath(patch.path);
    const oldPath = patch.oldPath === null ? null : normalizeRepoPath(patch.oldPath);
    const ignorePaths = config.ignore.paths;
    const maxFileSizeKb = config.review.max_file_size_kb;
    const maxChangedLinesPerFile = config.review.max_changed_lines_per_file;
    const changedLines = countChangedLines(patch.hunks);
    const early = selectSkipReason({
      status: patch.status,
      path,
      binary: patch.binary,
      ignorePaths,
      headBlobBytes: null,
      headSample: null,
      changedLines,
      maxFileSizeKb,
      maxChangedLinesPerFile,
    });
    if (early !== undefined) return skippedFile(patch, path, oldPath, early);
    const headBlobBytes = await headBlobSizeBytes(repoRoot, headSha, path);
    const sized = selectSkipReason({
      status: patch.status,
      path,
      binary: patch.binary,
      ignorePaths,
      headBlobBytes,
      headSample: null,
      changedLines,
      maxFileSizeKb,
      maxChangedLinesPerFile,
    });
    if (sized !== undefined) return skippedFile(patch, path, oldPath, sized);
    const content = await headBlobContent(repoRoot, headSha, path, headBlobBytes);
    const sample = new TextDecoder("utf-8", { fatal: false }).decode(content);
    const final = selectSkipReason({
      status: patch.status,
      path,
      binary: patch.binary,
      ignorePaths,
      headBlobBytes,
      headSample: sample,
      changedLines,
      maxFileSizeKb,
      maxChangedLinesPerFile,
    });
    if (final !== undefined) return skippedFile(patch, path, oldPath, final);
    const language = detectLanguage(path);
    return {
      path,
      oldPath,
      status: patch.status,
      language,
      skipReason: undefined,
      hunks: patch.hunks,
      commentableLines: getCommentableLines(patch.hunks),
      symbols:
        language !== null && patch.hunks.length > 0
          ? [moduleSymbol(countBlobLines(content), patch)]
          : [],
    };
  }

  // Counts only; never patch text, blobs, or secrets.
  private logSummary(result: DiffResult): void {
    let additions = 0;
    let deletions = 0;
    let hunks = 0;
    let binaryFiles = 0;
    let renamedFiles = 0;
    let filesSkipped = 0;
    for (const file of result.files) {
      if (file.skipReason !== undefined) filesSkipped += 1;
      if (file.skipReason === "binary") binaryFiles += 1;
      if (file.status === "renamed") renamedFiles += 1;
      for (const hunk of file.hunks) {
        hunks += 1;
        for (const line of hunk.lines) {
          if (line.kind === "add") additions += 1;
          else if (line.kind === "del") deletions += 1;
        }
      }
    }
    this.logger.info("diff complete", {
      baseSha: result.baseSha,
      headSha: result.headSha,
      mergeBase: result.mergeBase,
      filesTotal: result.files.length,
      filesAnalyzed: result.files.length - filesSkipped,
      filesSkipped,
      additions,
      deletions,
      hunks,
      binaryFiles,
      renamedFiles,
    });
  }
}
