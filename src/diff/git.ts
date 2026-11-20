import type { DiffEngine } from "../core/contracts.ts";
import { ReviewerError } from "../core/errors.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { ChangedFile, DiffResult } from "../types/diff.ts";
import { DEFAULT_MAX_STDOUT_BYTES } from "../utils/spawn.ts";
import { countChangedLines, selectSkipReason } from "./filters.ts";
import { parseNumstatZ, parseRawDiffZ } from "./parse.ts";
import type { ParsedFilePatch, RawFileMetadata } from "./parse.ts";
import { getCommentableLines } from "./positions.ts";
import { detectLanguage, normalizeRepoPath } from "./paths.ts";
import { gitDiffBytes, gitFailed, PINNED_DIFF_FLAGS } from "./git-exec.ts";
import { resolveRepoAndCommits } from "./revisions.ts";
import { batchCheckBlobSizes, countBlobLines, headBlobContent, moduleSymbol } from "./blobs.ts";
import { fetchEligiblePatches, isUnsupportedMode, skippedFile } from "./patches.ts";

// Structural logger injected through the constructor. Matches the CLI logger
// shape without importing an engine implementation; run() takes no logger.
export interface DiffLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

function invalidConfig(message: string): ReviewerError {
  return new ReviewerError({ code: "CONFIG_INVALID", message });
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
      headBlobBytes?: number | undefined;
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
      c.headBlobBytes = entry.size;
      sizedCandidates.push(c);
    }

    const patches: ParsedFilePatch[] = await fetchEligiblePatches({
      repoRoot: resolved.repoRoot,
      mergeBase: resolved.mergeBase,
      headSha: resolved.headSha,
      candidates: sizedCandidates.map((c) => ({ status: c.meta.status, path: c.path, oldPath: c.oldPath })),
      patchMaxStdoutBytes: this.patchMaxStdoutBytes,
    });

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
      const c = candidates[ci] as Candidate;
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

// Split compat: the previous public surface of this module stays importable here.
export type { CommitShaLabel, ResolvedRepoCommits } from "./revisions.ts";
export {
  isFullCommitSha,
  normalizeCommitSha,
  resolveCommitSha,
  resolveMergeBase,
  resolveRepoAndCommits,
  resolveRepoRoot,
  resolveRevision,
} from "./revisions.ts";
export { PINNED_DIFF_FLAGS } from "./git-exec.ts";
