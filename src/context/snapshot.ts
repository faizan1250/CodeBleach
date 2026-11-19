import { ReviewerError } from "../core/errors.ts";
import type { RunBudget } from "./limits.ts";
import { DEFAULT_MAX_STDOUT_BYTES, runProcess } from "../utils/spawn.ts";

// Per-blob ceiling keeps one oversized object from exhausting the run.
export const DEFAULT_MAX_SNAPSHOT_BLOB_BYTES = 1_048_576;
// Cumulative ceiling for all blobs retained by one reader (one run).
export const DEFAULT_MAX_SNAPSHOT_TOTAL_BYTES = 33_554_432;
// Cap for one candidate-search output; matches are small by construction.
export const DEFAULT_MAX_GREP_BYTES = 4_194_304;
export const DEFAULT_SNAPSHOT_TIMEOUT_MS = 30_000;

export interface TreeEntry {
  mode: string;
  type: "blob" | "tree" | "commit";
  oid: string;
  path: string;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface SnapshotReaderOptions {
  repoRoot: string;
  headSha: string;
  mergeBase: string;
  maxBlobBytes?: number | undefined;
  maxTotalBytes?: number | undefined;
  timeoutMs?: number | undefined;
  maxGrepBytes?: number | undefined;
  runBudget?: RunBudget | undefined;
}

export interface GrepOptions {
  paths?: readonly string[] | undefined;
  maxCount?: number | undefined;
}

const FULL_SHA_PATTERN = /^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/;
const TAB = 0x09;
const LF = 0x0a;
const NUL = 0x00;

const textDecoder = new TextDecoder("utf-8", { fatal: false });

function decodeText(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

function internal(message: string): ReviewerError {
  return new ReviewerError({ code: "INTERNAL", message });
}

function gitFailed(message: string, cause?: unknown): ReviewerError {
  return cause === undefined
    ? new ReviewerError({ code: "GIT_FAILED", message })
    : new ReviewerError({ code: "GIT_FAILED", message, cause });
}

function parseFailed(message: string): ReviewerError {
  return new ReviewerError({ code: "PARSE_FAILED", message });
}

function normalizeSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !FULL_SHA_PATTERN.test(value)) {
    throw internal(`SnapshotReader requires ${label} to be a full 40- or 64-character hex commit SHA`);
  }
  return value.toLowerCase();
}

function positiveInt(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw internal(`SnapshotReader requires ${label} to be a positive integer`);
  }
  return resolved;
}

// No-match grep exits 1; every other git failure propagates.
function isGrepNoMatch(error: unknown): boolean {
  if (!(error instanceof ReviewerError) || error.code !== "GIT_FAILED") return false;
  const cause = error.cause;
  if (typeof cause !== "object" || cause === null) return false;
  if (!("reason" in cause) || !("exitCode" in cause)) return false;
  const details = cause as { reason: unknown; exitCode: unknown };
  return details.reason === "exit" && details.exitCode === 1;
}

/**
 * True only for an actual timed-out Git subprocess (`runProcess` reason
 * "timeout"). Deadline skips, parse cancellations, and non-timeout Git
 * failures (exit, output-limit, abort) never qualify.
 */
export function isGitTimeout(error: unknown): boolean {
  if (!(error instanceof ReviewerError) || error.code !== "GIT_FAILED") return false;
  const cause = error.cause;
  if (typeof cause !== "object" || cause === null) return false;
  if (!("reason" in cause)) return false;
  return (cause as { reason: unknown }).reason === "timeout";
}

/**
 * True only when a Git subprocess exceeded its stdout/stderr byte cap
 * (`runProcess` reason "output-limit"). Candidate caps, budgets, timeouts,
 * and parse cancellations never qualify.
 */
export function isGitOutputLimit(error: unknown): boolean {
  if (!(error instanceof ReviewerError) || error.code !== "GIT_FAILED") return false;
  const cause = error.cause;
  if (typeof cause !== "object" || cause === null) return false;
  if (!("reason" in cause)) return false;
  return (cause as { reason: unknown }).reason === "output-limit";
}

/** Parse `git ls-tree -r -z --full-tree` output; split metadata from path at the first tab only. */
export function parseLsTreeZ(bytes: Uint8Array): Map<string, TreeEntry> {
  const index = new Map<string, TreeEntry>();
  let start = 0;
  for (let cursor = 0; cursor <= bytes.length; cursor += 1) {
    if (cursor === bytes.length || bytes[cursor] === NUL) {
      if (cursor > start) {
        const entry = parseLsTreeRecord(bytes.subarray(start, cursor));
        index.set(entry.path, entry);
      }
      start = cursor + 1;
    }
  }
  return index;
}

function parseLsTreeRecord(record: Uint8Array): TreeEntry {
  let tab = -1;
  for (let cursor = 0; cursor < record.length; cursor += 1) {
    if (record[cursor] === TAB) {
      tab = cursor;
      break;
    }
  }
  if (tab < 0) throw parseFailed("ls-tree record has no metadata/path tab separator");
  const meta = decodeText(record.subarray(0, tab)).split(" ");
  if (meta.length !== 3) throw parseFailed("ls-tree record metadata is not '<mode> <type> <oid>'");
  const [mode, type, oid] = meta as [string, string, string];
  if (mode === undefined || !/^[0-7]{6}$/.test(mode)) throw parseFailed("ls-tree record has an invalid mode");
  if (type !== "blob" && type !== "tree" && type !== "commit") {
    throw parseFailed(`ls-tree record has unexpected type ${JSON.stringify(type)}`);
  }
  if (oid === undefined || !FULL_SHA_PATTERN.test(oid)) throw parseFailed("ls-tree record has an invalid object id");
  const path = decodeText(record.subarray(tab + 1));
  if (path.length === 0) throw parseFailed("ls-tree record has an empty path");
  return { mode, type, oid: oid.toLowerCase(), path };
}

/** Regular files only; symlinks, gitlinks, and trees are never source. */
export function isRegularBlob(entry: TreeEntry): boolean {
  return entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755");
}

/**
 * Parse `git grep -z` output: `<tree>:<path> NUL <line> NUL <text> LF`.
 * Scanning NUL/LF delimiters keeps newlines inside paths unambiguous.
 */
export function parseGrepZ(buffer: Uint8Array, treePrefix: string): GrepMatch[] {
  if (treePrefix.length === 0) throw internal("parseGrepZ requires a non-empty tree prefix");
  const matches: GrepMatch[] = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const pathEnd = indexOfByte(buffer, NUL, cursor);
    if (pathEnd < 0) throw parseFailed("truncated grep record (missing path terminator)");
    const lineEnd = indexOfByte(buffer, NUL, pathEnd + 1);
    if (lineEnd < 0) throw parseFailed("truncated grep record (missing line terminator)");
    let textEnd = indexOfByte(buffer, LF, lineEnd + 1);
    if (textEnd < 0) textEnd = buffer.length;
    const rawPath = decodeText(buffer.subarray(cursor, pathEnd));
    if (!rawPath.startsWith(treePrefix)) {
      throw parseFailed(
        `grep pathname ${JSON.stringify(rawPath.slice(0, 80))} does not start with the searched tree`,
      );
    }
    const lineText = decodeText(buffer.subarray(pathEnd + 1, lineEnd));
    if (!/^[0-9]+$/.test(lineText)) throw parseFailed("grep record has a non-numeric line number");
    const line = Number(lineText);
    if (!Number.isSafeInteger(line) || line < 1) throw parseFailed("grep record has an invalid line number");
    matches.push({
      path: rawPath.slice(treePrefix.length),
      line,
      text: decodeText(buffer.subarray(lineEnd + 1, textEnd)),
    });
    cursor = textEnd + 1;
  }
  return matches;
}

function indexOfByte(buffer: Uint8Array, byte: number, from: number): number {
  for (let cursor = from; cursor < buffer.length; cursor += 1) {
    if (buffer[cursor] === byte) return cursor;
  }
  return -1;
}

/**
 * Reads exact commit snapshots through safe Git argv calls. Head-side
 * definitions, imports, callers, and tests come from headSha; old-side
 * sources for deletions come from mergeBase. The working tree is never read.
 */
export class SnapshotReader {
  private readonly repoRoot: string;
  private readonly head: string;
  private readonly base: string;
  private readonly maxBlobBytes: number;
  private readonly maxTotalBytes: number;
  private readonly timeoutMs: number;
  private readonly maxGrepBytes: number;
  private readonly runBudget: RunBudget | undefined;
  private headIndex: Map<string, TreeEntry> | null = null;
  private baseIndex: Map<string, TreeEntry> | null = null;
  private readonly blobCache = new Map<string, string>();
  private cachedTotalBytes = 0;

  constructor(options: SnapshotReaderOptions) {
    if (options === null || options === undefined || typeof options !== "object") {
      throw internal("SnapshotReader requires an options object");
    }
    if (typeof options.repoRoot !== "string" || options.repoRoot.length === 0) {
      throw internal("SnapshotReader requires repoRoot to be a non-empty path");
    }
    this.repoRoot = options.repoRoot;
    this.head = normalizeSha(options.headSha, "headSha");
    this.base = normalizeSha(options.mergeBase, "mergeBase");
    this.maxBlobBytes = positiveInt(options.maxBlobBytes, DEFAULT_MAX_SNAPSHOT_BLOB_BYTES, "maxBlobBytes");
    this.maxTotalBytes = positiveInt(options.maxTotalBytes, DEFAULT_MAX_SNAPSHOT_TOTAL_BYTES, "maxTotalBytes");
    this.timeoutMs = positiveInt(options.timeoutMs, DEFAULT_SNAPSHOT_TIMEOUT_MS, "timeoutMs");
    this.maxGrepBytes = positiveInt(options.maxGrepBytes, DEFAULT_MAX_GREP_BYTES, "maxGrepBytes");
    this.runBudget = options.runBudget;
  }

  get headSha(): string {
    return this.head;
  }

  get mergeBase(): string {
    return this.base;
  }

  get cachedBytes(): number {
    return this.cachedTotalBytes;
  }

  get cachedEntries(): number {
    return this.blobCache.size;
  }

  /** Tracked-file index of the head commit; repo-relative POSIX paths. */
  async listHeadFiles(): Promise<Map<string, TreeEntry>> {
    if (this.headIndex === null) {
      this.headIndex = parseLsTreeZ(
        await this.runGit(["ls-tree", "-r", "-z", "--full-tree", this.head], "git ls-tree (head)"),
      );
    }
    // Copy so callers cannot mutate the cached index.
    return new Map(this.headIndex);
  }

  /** Tracked-file index of the merge-base commit; repo-relative POSIX paths. */
  async listBaseFiles(): Promise<Map<string, TreeEntry>> {
    if (this.baseIndex === null) {
      this.baseIndex = parseLsTreeZ(
        await this.runGit(["ls-tree", "-r", "-z", "--full-tree", this.base], "git ls-tree (base)"),
      );
    }
    // Copy so callers cannot mutate the cached index.
    return new Map(this.baseIndex);
  }

  /** Head-side source for a tracked regular file; renames resolve via path at head. */
  async readHeadText(path: string): Promise<string> {
    return this.readTreePath(await this.listHeadFiles(), path, "head");
  }

  /** Merge-base-side source for a tracked regular file; renames resolve via oldPath at base. */
  async readBaseText(path: string): Promise<string> {
    return this.readTreePath(await this.listBaseFiles(), path, "base");
  }

  /** Blob content by object id, cached per reader; size-checked before reading. */
  async readBlobText(oid: string): Promise<string> {
    const normalized = typeof oid === "string" ? oid.toLowerCase() : "";
    if (!FULL_SHA_PATTERN.test(normalized)) {
      throw internal("SnapshotReader requires readBlobText oid to be a full hex object id");
    }
    const cached = this.blobCache.get(normalized);
    if (cached !== undefined) return cached;
    const sizeText = decodeText(await this.runGit(["cat-file", "-s", normalized], "blob size lookup")).trim();
    if (!/^[0-9]+$/.test(sizeText)) throw gitFailed(`cannot determine size of blob ${normalized}`);
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0) throw gitFailed(`blob ${normalized} has an invalid size`);
    if (size > this.maxBlobBytes) {
      throw gitFailed(`blob ${normalized} is ${size} bytes, above the ${this.maxBlobBytes}-byte per-blob snapshot cap`);
    }
    if (this.cachedTotalBytes + size > this.maxTotalBytes) {
      throw gitFailed(
        `snapshot total ${this.cachedTotalBytes + size} bytes would exceed the ${this.maxTotalBytes}-byte run cap`,
      );
    }
    const content = await this.runGit(
      ["cat-file", "blob", normalized],
      "blob read",
      Math.min(size + 1, DEFAULT_MAX_STDOUT_BYTES),
    );
    const text = decodeText(content);
    this.blobCache.set(normalized, text);
    this.cachedTotalBytes += size;
    return text;
  }

  /**
   * Fixed-string word search over tracked head-commit files. Untracked and
   * worktree-only content never matches because the commit tree is searched.
   */
  async grepHead(pattern: string, options: GrepOptions = {}): Promise<GrepMatch[]> {
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw internal("SnapshotReader requires grepHead pattern to be a non-empty string");
    }
    const resolved: GrepOptions = options ?? {};
    const paths = resolved.paths ?? [];
    for (const path of paths) {
      if (typeof path !== "string" || path.length === 0) {
        throw internal("SnapshotReader requires grepHead paths to be non-empty strings");
      }
    }
    const args: string[] = ["grep", "-I", "--line-number", "-z", "--no-textconv", "-F", "-w"];
    if (resolved.maxCount !== undefined) {
      if (!Number.isSafeInteger(resolved.maxCount) || resolved.maxCount < 1) {
        throw internal("SnapshotReader requires grepHead maxCount to be a positive integer");
      }
      args.push("-m", String(resolved.maxCount));
    }
    args.push("-e", pattern, this.head, "--", ...paths);
    let stdout: Uint8Array;
    try {
      stdout = await this.runGit(args, "git grep (head)", this.maxGrepBytes);
    } catch (error) {
      if (isGrepNoMatch(error)) return [];
      throw error;
    }
    return parseGrepZ(stdout, `${this.head}:`);
  }

  private async readTreePath(index: Map<string, TreeEntry>, path: string, label: string): Promise<string> {
    if (typeof path !== "string" || path.length === 0) {
      throw internal(`SnapshotReader requires a non-empty repository path (${label})`);
    }
    const entry = index.get(path);
    if (entry === undefined) throw gitFailed(`path "${path}" is not in the ${label} tree`);
    if (!isRegularBlob(entry)) {
      throw gitFailed(
        `path "${path}" in the ${label} tree is not a regular file (mode ${entry.mode}, type ${entry.type})`,
      );
    }
    return this.readBlobText(entry.oid);
  }

  private timeoutFor(): number {
    const remaining = this.runBudget?.remainingRunMs();
    const timeout = remaining === undefined ? this.timeoutMs : Math.min(this.timeoutMs, remaining);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw gitFailed("snapshot read skipped: context run deadline exceeded");
    }
    return timeout;
  }

  private async runGit(args: readonly string[], what: string, maxStdoutBytes?: number): Promise<Uint8Array> {
    // Single attempt per call; no retry. Each timed-out invocation surfaces
    // exactly once so callers can count timed-out Git queries without dedupe.
    try {
      const result = await runProcess({
        cmd: ["git", ...args],
        cwd: this.repoRoot,
        timeoutMs: this.timeoutFor(),
        ...(maxStdoutBytes === undefined ? {} : { maxStdoutBytes }),
      });
      return result.stdout;
    } catch (error) {
      if (error instanceof ReviewerError) throw error;
      throw gitFailed(`${what} failed: ${error instanceof Error ? error.message : String(error)}`, error);
    }
  }
}
