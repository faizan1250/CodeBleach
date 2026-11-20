import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { DiffEngine } from "../core/contracts.ts";
import { ReviewerError } from "../core/errors.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { ChangedFile, ChangedSymbol, DiffResult } from "../types/diff.ts";
import { DEFAULT_MAX_STDOUT_BYTES, runProcess } from "../utils/spawn.ts";
import { countChangedLines, selectSkipReason } from "./filters.ts";
import { parseNumstatZ, parseRawDiffZ, parseUnifiedDiff } from "./parse.ts";
import type { ParsedFilePatch, RawFileMetadata } from "./parse.ts";
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

// Structural logger injected through the constructor. Matches the CLI logger
// shape without importing an engine implementation; run() takes no logger.
export interface DiffLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

// Pinned on both diff invocations so user/repo Git config cannot change output.
// Explicit flags override diff.algorithm, diff.interHunkContext,
// diff.renames, and diff.indentHeuristic alike (ADR 0008/0009).
// GREEN keeps the same pins for raw, numstat, and patch alike so file
// ordering and rename detection agree across metadata and patch.
export const PINNED_DIFF_FLAGS: readonly string[] = [
  "--diff-algorithm=myers",
  "--inter-hunk-context=0",
  "--find-renames=50%",
  "--no-indent-heuristic",
];

// Git file modes that the engine cannot review as text (ADR 0010):
// 120000 symlink, 160000 gitlink, either side including transitions.
// 100644<->100755 chmod stays supported.
function isUnsupportedMode(oldMode: string, newMode: string): boolean {
  return oldMode === "120000" || newMode === "120000" || oldMode === "160000" || newMode === "160000";
}

function invalidConfig(message: string): ReviewerError {
  return new ReviewerError({ code: "CONFIG_INVALID", message });
}

async function gitDiffBytes(
  repoRoot: string,
  args: readonly string[],
  what: string,
  maxStdoutBytes?: number,
): Promise<Uint8Array> {
  try {
    return (
      await runProcess({
        cmd: ["git", "diff", ...args],
        cwd: repoRoot,
        ...(maxStdoutBytes === undefined ? {} : { maxStdoutBytes }),
      })
    ).stdout;
  } catch (cause) {
    if (cause instanceof ReviewerError && cause.code === "INTERNAL") throw cause;
    throw gitFailed(`${what} failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause);
  }
}

async function headBlobContent(
  repoRoot: string,
  headSha: string,
  path: string,
  sizeBytes: number,
): Promise<Uint8Array> {
  try {
    // Bounded by the known blob size. The schema ceiling on max_file_size_kb
    // keeps sizeBytes+1 within the spawn cap, so overflow via size alone is
    // unreachable; anything unexpected still fails safe as GIT_FAILED.
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

// Head-side blob sizes via `git cat-file --batch-check` (one process, no
// working-tree reads). Input is new blob OIDs from --raw; gitlinks never
// reach here (unsupported-mode filtered first, never sent as blob). Missing
// objects are GIT_FAILED with a fetch hint; non-blob types are returned for
// defensive unsupported-mode handling by the caller.
async function batchCheckBlobSizes(
  repoRoot: string,
  shas: readonly string[],
): Promise<Map<string, { type: string; size: number }>> {
  if (shas.length === 0) return new Map();
  const unique = [...new Set(shas)];
  let stdout: string;
  try {
    const result = await runProcess({
      cmd: ["git", "cat-file", "--batch-check"],
      cwd: repoRoot,
      stdinData: `${unique.join("\n")}\n`,
    });
    stdout = decode(result.stdout);
  } catch (cause) {
    if (cause instanceof ReviewerError && cause.code === "INTERNAL") throw cause;
    throw gitFailed(
      `cannot batch-check head blob sizes: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
  const map = new Map<string, { type: string; size: number }>();
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const parts = line.split(" ");
    if (parts.length < 2) {
      throw gitFailed(`unexpected batch-check line ${JSON.stringify(line)}`);
    }
    const [sha, kind] = parts as [string, string];
    if (kind === "missing") {
      // Caller maps SHA back to a path for a fetch-hint error.
      map.set(sha, { type: "missing", size: -1 });
      continue;
    }
    if (parts.length !== 3) {
      throw gitFailed(`unexpected batch-check line ${JSON.stringify(line)}`);
    }
    const size = Number(parts[2]);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw gitFailed(`batch-check size for "${sha}" is not a valid byte count`);
    }
    map.set(sha, { type: kind, size });
  }
  return map;
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
  status: ParsedFilePatch["status"],
  path: string,
  oldPath: string | null,
  skipReason: NonNullable<ChangedFile["skipReason"]>,
): ChangedFile {
  return {
    path,
    oldPath,
    status,
    language: detectLanguage(path),
    skipReason,
    hunks: [],
    commentableLines: [],
    symbols: [],
  };
}

export class GitDiffEngine implements DiffEngine {
  private readonly logger: DiffLogger;
  // Patch-diff stdout cap only (bytes). Defaults to the spawn cap; metadata,
  // blob-size, and blob-show paths keep their own caps. Per-stream enforcement
  // lives in runProcess; no global mutable state. Rationale: ADR 0009 ceiling
  // keeps an accepted blob's show under the spawn cap, so a small test cap
  // exposes missing early lockfile/size filtering as GIT_FAILED overflow.
  private readonly patchMaxStdoutBytes: number;

  constructor(deps: { logger: DiffLogger; patchMaxStdoutBytes?: number }) {
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
    this.patchMaxStdoutBytes = deps?.patchMaxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  }

  async run(input: { repoDir: string; baseSha: string; headSha: string; config: ResolvedConfig }): Promise<DiffResult> {
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
    // GREEN processing order (ADR 0010): raw metadata -> classify modes ->
    // unsupported skip -> numstat -> path/binary filters -> blob sizes
    // (batch-check) -> patches ONLY for eligible -> parse -> positions.
    // Never fetches the full patch for rejectable files.
    const [rawBytes, numstatBytes] = await Promise.all([
      gitDiffBytes(
        resolved.repoRoot,
        ["--raw", "-z", "--no-abbrev", ...PINNED_DIFF_FLAGS, resolved.mergeBase, resolved.headSha, "--"],
        "git diff raw metadata",
      ),
      gitDiffBytes(
        resolved.repoRoot,
        ["--numstat", "-z", ...PINNED_DIFF_FLAGS, resolved.mergeBase, resolved.headSha, "--"],
        "git diff numstat",
      ),
    ]);
    // Raw metadata parsing: old/new mode, blob SHAs, status, renames, paths.
    const rawMetadata = parseRawDiffZ(rawBytes);
    const numstat = parseNumstatZ(numstatBytes);
    if (numstat.length !== rawMetadata.length) {
      throw new ReviewerError({
        code: "PARSE_FAILED",
        message: `raw metadata lists ${rawMetadata.length} file(s) but numstat lists ${numstat.length}`,
      });
    }
    const ignorePaths = input.config.ignore.paths;
    const maxFileSizeKb = input.config.review.max_file_size_kb;
    const maxChangedLinesPerFile = input.config.review.max_changed_lines_per_file;

    interface Candidate {
      meta: RawFileMetadata;
      path: string;
      oldPath: string | null;
      unsupportedMode: boolean;
      binary: boolean;
    }
    const candidates: Candidate[] = [];
    const earlySkipped: ChangedFile[] = [];
    // Preserve raw order for deterministic output; track index for merge.
    const order: Array<{ kind: "skipped"; file: ChangedFile } | { kind: "candidate"; index: number }> = [];
    for (let i = 0; i < rawMetadata.length; i += 1) {
      const meta = rawMetadata[i] as RawFileMetadata;
      const num = numstat[i] as { path: string; oldPath: string | null; binary: boolean };
      const path = normalizeRepoPath(meta.path);
      const oldPath = meta.oldPath === null ? null : normalizeRepoPath(meta.oldPath);
      const unsupportedMode = isUnsupportedMode(meta.oldMode, meta.newMode);
      const binary = num.binary;
      // Early path/binary filters before any blob or patch (lockfile/ignore
      // need only the path; deleted/unsupported/binary need no content).
      const early = selectSkipReason({
        status: meta.status,
        path,
        binary,
        unsupportedMode,
        ignorePaths,
        headBlobBytes: null,
        headSample: null,
        changedLines: 0,
        maxFileSizeKb,
        maxChangedLinesPerFile,
      });
      // Note: changedLines 0 here avoids premature line-cap skips; the line
      // cap is enforced after the eligible-only patch is parsed.
      if (early !== undefined) {
        const file = skippedFile(meta.status, path, oldPath, early);
        earlySkipped.push(file);
        order.push({ kind: "skipped", file });
        continue;
      }
      const idx = candidates.length;
      candidates.push({ meta, path, oldPath, unsupportedMode, binary });
      order.push({ kind: "candidate", index: idx });
    }

    // Blob sizes via batch-check (head-side, additions/renames only; deleted
    // and already-skipped files never reach here; gitlinks never sent as blob
    // because unsupported-mode filtered above).
    const sizeBySha = await batchCheckBlobSizes(
      resolved.repoRoot,
      candidates.map((c) => c.meta.newSha),
    );
    const sizedCandidates: Candidate[] = [];
    const sizedSkipped = new Map<number, ChangedFile>();
    for (let i = 0; i < candidates.length; i += 1) {
      const c = candidates[i] as Candidate;
      // Deleted has no head blob; already skipped above, but guard anyway.
      if (c.meta.status === "deleted") {
        sizedSkipped.set(i, skippedFile(c.meta.status, c.path, c.oldPath, "deleted"));
        continue;
      }
      const entry = sizeBySha.get(c.meta.newSha);
      if (entry === undefined) {
        throw gitFailed(`batch-check missing size for "${c.path}"`);
      }
      if (entry.type === "missing") {
        throw gitFailed(
          `head object for "${c.path}" is missing; fetch sufficient history locally (no fetch is performed automatically)`,
        );
      }
      if (entry.type !== "blob") {
        // Defensive: non-blob head (e.g. unexpected commit) is not reviewable
        // as text; keep it observable without a patch body.
        sizedSkipped.set(i, skippedFile(c.meta.status, c.path, c.oldPath, "unsupported-mode"));
        continue;
      }
      const tooLarge = selectSkipReason({
        status: c.meta.status,
        path: c.path,
        binary: c.binary,
        unsupportedMode: c.unsupportedMode,
        ignorePaths,
        headBlobBytes: entry.size,
        headSample: null,
        changedLines: 0,
        maxFileSizeKb,
        maxChangedLinesPerFile,
      });
      if (tooLarge !== undefined) {
        sizedSkipped.set(i, skippedFile(c.meta.status, c.path, c.oldPath, tooLarge));
        continue;
      }
      // Attach size for later blob-show cap without re-querying.
      (c as Candidate & { headBlobBytes?: number }).headBlobBytes = entry.size;
      sizedCandidates.push(c);
    }

    // Patches ONLY for eligible survivors (safe pathspec, argv arrays, no
    // shell). Genuine over-cap stays GIT_FAILED (no truncate).
    let patches: ParsedFilePatch[] = [];
    if (sizedCandidates.length > 0) {
      const pathspec: string[] = [];
      for (const c of sizedCandidates) {
        if (c.meta.status === "renamed" && c.oldPath !== null) {
          pathspec.push(c.oldPath, c.path);
        } else {
          pathspec.push(c.path);
        }
      }
      const uniquePaths = [...new Set(pathspec)];
      const patchBytes = await gitDiffBytes(
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
          ...uniquePaths,
        ],
        "git diff patch",
        this.patchMaxStdoutBytes,
      );
      const eligibleMeta = sizedCandidates.map((c) => ({
        status: c.meta.status,
        path: c.meta.path,
        oldPath: c.meta.oldPath,
      }));
      patches = parseUnifiedDiff(new TextDecoder("utf-8", { fatal: false }).decode(patchBytes), eligibleMeta);
    }
    if (patches.length !== sizedCandidates.length) {
      throw new ReviewerError({
        code: "PARSE_FAILED",
        message: `patch has ${patches.length} file section(s) but ${sizedCandidates.length} eligible file(s) expected`,
      });
    }

    const filesByOrder: ChangedFile[] = [];
    const candidateIndexToSized = new Map<Candidate, number>();
    sizedCandidates.forEach((c, si) => {
      candidateIndexToSized.set(c, si);
    });
    for (const slot of order) {
      if (slot.kind === "skipped") {
        filesByOrder.push(slot.file);
        continue;
      }
      const ci = slot.index;
      const sizeSkipped = sizedSkipped.get(ci);
      if (sizeSkipped !== undefined) {
        filesByOrder.push(sizeSkipped);
        continue;
      }
      const c = candidates[ci] as Candidate & { headBlobBytes?: number };
      const si = candidateIndexToSized.get(c) as number;
      const patch = patches[si] as ParsedFilePatch;
      const changedLines = countChangedLines(patch.hunks);
      // Line-cap and binary-from-patch checks before any blob content.
      const lineSkip = selectSkipReason({
        status: c.meta.status,
        path: c.path,
        binary: c.binary || patch.binary,
        unsupportedMode: c.unsupportedMode,
        ignorePaths,
        headBlobBytes: c.headBlobBytes ?? null,
        headSample: null,
        changedLines,
        maxFileSizeKb,
        maxChangedLinesPerFile,
      });
      if (lineSkip !== undefined) {
        filesByOrder.push(skippedFile(c.meta.status, c.path, c.oldPath, lineSkip));
        continue;
      }
      const headBlobBytes = c.headBlobBytes ?? 0;
      const content = await headBlobContent(resolved.repoRoot, resolved.headSha, c.path, headBlobBytes);
      const sample = new TextDecoder("utf-8", { fatal: false }).decode(content);
      const final = selectSkipReason({
        status: c.meta.status,
        path: c.path,
        binary: c.binary || patch.binary,
        unsupportedMode: c.unsupportedMode,
        ignorePaths,
        headBlobBytes,
        headSample: sample,
        changedLines,
        maxFileSizeKb,
        maxChangedLinesPerFile,
      });
      if (final !== undefined) {
        filesByOrder.push(skippedFile(c.meta.status, c.path, c.oldPath, final));
        continue;
      }
      const language = detectLanguage(c.path);
      filesByOrder.push({
        path: c.path,
        oldPath: c.oldPath,
        status: c.meta.status,
        language,
        skipReason: undefined,
        hunks: patch.hunks,
        commentableLines: getCommentableLines(patch.hunks),
        symbols: language !== null && patch.hunks.length > 0 ? [moduleSymbol(countBlobLines(content), patch)] : [],
      });
    }
    const result: DiffResult = {
      baseSha: resolved.baseSha,
      headSha: resolved.headSha,
      mergeBase: resolved.mergeBase,
      files: filesByOrder,
    };
    this.logSummary(result);
    return result;
  }

  // Deleted/binary/lockfile/ignored/line-cap need no blob reads; byte cap
  // needs only batch-check sizes; only surviving candidates pay for a patch
  // and then a bounded blob show for generated-header inspection.

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
