import { ReviewerError } from "../core/errors.ts";
import {
  DEFAULT_MAX_SNAPSHOT_BLOB_BYTES,
  DEFAULT_MAX_SNAPSHOT_TOTAL_BYTES,
  DEFAULT_SNAPSHOT_TIMEOUT_MS,
  SnapshotReader,
  isGitAbort,
  isGitTimeout,
  isRegularBlob,
  isSnapshotBlobFailure,
} from "../context/snapshot.ts";
import type { SnapshotBlobFailureKind, TreeEntry } from "../context/snapshot.ts";
import { normalizeRepoPath } from "../review/normalize.ts";

// Per-run (commit SHA, path) entry bound. Plain text only, never Tree/WASM
// handles; the engine builds a fresh reader per validate() call, so the map
// is dropped at run end without explicit disposal.
export const DEFAULT_VALIDATION_SNAPSHOT_MAX_ENTRIES = 256;

const FULL_SHA_PATTERN = /^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/;

/** Control characters (C0, DEL, C1) never belong in a Git path lookup. */
function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index);
    if (code === undefined) continue;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
    if (code > 0xffff) index += 1;
  }
  return false;
}

function internal(message: string): ReviewerError {
  return new ReviewerError({ code: "INTERNAL", message });
}

function positiveInt(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw internal(`ValidationSnapshotReader requires ${label} to be a positive integer`);
  }
  return resolved;
}

function normalizeCommitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !FULL_SHA_PATTERN.test(value)) {
    throw internal(`ValidationSnapshotReader requires ${label} to be a full 40- or 64-character hex commit SHA`);
  }
  return value.toLowerCase();
}

export type ValidationSnapshotSide = "head" | "base";

export type SnapshotReadStatus =
  | "ok"
  | "not_found"
  | "unsupported"
  | "binary"
  | "size_limit"
  | "invalid_path"
  | "sha_mismatch"
  | "aborted"
  | "timeout";

/** Which run cap a `size_limit` hit: one oversized blob vs the cumulative run total. */
export type SnapshotBlobCapKind = Exclude<SnapshotBlobFailureKind, "missing">;

export type SnapshotReadResult =
  | { status: "ok"; text: string; bytes: number }
  | {
      status: "size_limit";
      reason: string;
      /** Which run cap fired: one oversized blob vs the cumulative run total. */
      kind: SnapshotBlobCapKind;
      sizeBytes?: number | undefined;
      limitBytes?: number | undefined;
    }
  | { status: Exclude<SnapshotReadStatus, "ok" | "size_limit">; reason: string };

export interface ValidationSnapshotReadOptions {
  maxBytes?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface ValidationSnapshotStats {
  reads: number;
  cacheHits: number;
  entries: number;
  cachedBytes: number;
  gitCalls: number;
}

/**
 * Narrow structural source behind the validation adapter. The production
 * source is the Phase 4 `SnapshotReader` (exact commit snapshots, never the
 * working tree); tests inject a scripted source with the same shape.
 * The optional signal is the SAME AbortSignal the caller passed to the
 * reader: the source must forward it to the underlying Git subprocess so
 * in-flight reads are killed and reaped, never orphaned.
 */
export interface ValidationSnapshotSource {
  readonly headSha: string;
  readonly mergeBase: string;
  listHeadFiles(options?: ValidationSourceReadOptions | undefined): Promise<Map<string, TreeEntry>>;
  listBaseFiles(options?: ValidationSourceReadOptions | undefined): Promise<Map<string, TreeEntry>>;
  readBlobText(oid: string, options?: ValidationSourceReadOptions | undefined): Promise<string>;
  stats(): { gitCalls: number };
}

/** Caller cancellation for one source read; the reader forwards its own signal verbatim. */
export interface ValidationSourceReadOptions {
  signal?: AbortSignal | undefined;
}

/**
 * Fail-closed repo-relative path check. Null means the path must never reach
 * Git: empty, absolute/drive-prefixed, traversal, or control characters.
 * Clean paths return their canonical POSIX identity.
 */
export function validateSnapshotPath(path: unknown): { ok: true; path: string } | { ok: false; reason: string } {
  if (typeof path !== "string") return { ok: false, reason: "snapshot path must be a string" };
  const normalized = normalizeRepoPath(path);
  if (normalized === null) {
    return { ok: false, reason: "snapshot path is empty, absolute, or escapes the repository" };
  }
  if (hasControlChars(normalized)) {
    return { ok: false, reason: "snapshot path contains control characters" };
  }
  return { ok: true, path: normalized };
}

/**
 * Typed byte counts/limits from a blob-cap failure cause. Reads only the
 * structured cause fields (`SnapshotBlobFailureDetails`); the human-readable
 * message is never parsed.
 */
function blobCapNumbers(error: unknown): { sizeBytes?: number | undefined; limitBytes?: number | undefined } {
  if (!(error instanceof ReviewerError)) return {};
  const cause = error.cause;
  if (typeof cause !== "object" || cause === null) return {};
  const details = cause as { sizeBytes?: unknown; limitBytes?: unknown };
  const numbers: { sizeBytes?: number | undefined; limitBytes?: number | undefined } = {};
  if (typeof details.sizeBytes === "number" && Number.isSafeInteger(details.sizeBytes) && details.sizeBytes >= 0) {
    numbers.sizeBytes = details.sizeBytes;
  }
  if (typeof details.limitBytes === "number" && Number.isSafeInteger(details.limitBytes) && details.limitBytes >= 1) {
    numbers.limitBytes = details.limitBytes;
  }
  return numbers;
}

export interface ValidationSnapshotReader {
  readonly headSha: string;
  readonly mergeBase: string;
  readHead(path: string, options?: ValidationSnapshotReadOptions | undefined): Promise<SnapshotReadResult>;
  readBase(path: string, options?: ValidationSnapshotReadOptions | undefined): Promise<SnapshotReadResult>;
  readAt(
    commitSha: string,
    path: string,
    options?: ValidationSnapshotReadOptions | undefined,
  ): Promise<SnapshotReadResult>;
  stats(): ValidationSnapshotStats;
  /** Release retained per-run text; the underlying blob cache stays run-scoped. */
  clear(): void;
}

export interface GitValidationSnapshotReaderOptions {
  repoDir: string;
  headSha: string;
  mergeBase: string;
  maxFileBytes?: number | undefined;
  maxTotalBytes?: number | undefined;
  maxEntries?: number | undefined;
  timeoutMs?: number | undefined;
  source?: ValidationSnapshotSource | undefined;
}

/**
 * Read-only adapter over exact commit snapshots for validation. Head-side
 * reads are pinned to `diff.headSha`, removed-line reads to `diff.mergeBase`;
 * the working tree is never consulted. Only provenance-checked paths should
 * be passed in (P5-02 owns membership); this layer still rejects unsafe paths
 * and unallowed SHAs before any Git call and keeps typed outcomes for every
 * known content state. Protocol corruption propagates as a stage-level
 * `ReviewerError`, never a success-shaped status.
 */
export class GitValidationSnapshotReader implements ValidationSnapshotReader {
  readonly headSha: string;
  readonly mergeBase: string;
  private readonly source: ValidationSnapshotSource;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxEntries: number;
  private readonly cache = new Map<string, { text: string; bytes: number }>();
  private cachedBytes = 0;
  private reads = 0;
  private cacheHits = 0;

  constructor(options: GitValidationSnapshotReaderOptions) {
    if (options === null || options === undefined || typeof options !== "object") {
      throw internal("GitValidationSnapshotReader requires an options object");
    }
    if (typeof options.repoDir !== "string" || options.repoDir.length === 0) {
      throw internal("GitValidationSnapshotReader requires repoDir to be a non-empty path");
    }
    const headSha = normalizeCommitSha(options.headSha, "headSha");
    const mergeBase = normalizeCommitSha(options.mergeBase, "mergeBase");
    this.headSha = headSha;
    this.mergeBase = mergeBase;
    this.maxFileBytes = positiveInt(options.maxFileBytes, DEFAULT_MAX_SNAPSHOT_BLOB_BYTES, "maxFileBytes");
    this.maxTotalBytes = positiveInt(options.maxTotalBytes, DEFAULT_MAX_SNAPSHOT_TOTAL_BYTES, "maxTotalBytes");
    this.maxEntries = positiveInt(options.maxEntries, DEFAULT_VALIDATION_SNAPSHOT_MAX_ENTRIES, "maxEntries");
    const timeoutMs = positiveInt(options.timeoutMs, DEFAULT_SNAPSHOT_TIMEOUT_MS, "timeoutMs");
    this.source =
      options.source ??
      new SnapshotReader({
        repoRoot: options.repoDir,
        headSha,
        mergeBase,
        maxBlobBytes: this.maxFileBytes,
        maxTotalBytes: this.maxTotalBytes,
        timeoutMs,
      });
  }

  readHead(path: string, options?: ValidationSnapshotReadOptions | undefined): Promise<SnapshotReadResult> {
    return this.readAt(this.headSha, path, options);
  }

  readBase(path: string, options?: ValidationSnapshotReadOptions | undefined): Promise<SnapshotReadResult> {
    return this.readAt(this.mergeBase, path, options);
  }

  async readAt(
    commitSha: string,
    path: string,
    options?: ValidationSnapshotReadOptions | undefined,
  ): Promise<SnapshotReadResult> {
    this.reads += 1;
    const sha = typeof commitSha === "string" ? commitSha.toLowerCase() : "";
    if (!FULL_SHA_PATTERN.test(sha)) {
      throw internal("ValidationSnapshotReader requires commitSha to be a full 40- or 64-character hex commit SHA");
    }
    if (sha !== this.headSha && sha !== this.mergeBase) {
      return { status: "sha_mismatch", reason: `commit ${sha} is not this run's head or merge-base snapshot` };
    }
    if (options?.signal?.aborted === true) {
      return { status: "aborted", reason: "snapshot read aborted before the first Git call" };
    }
    const checked = validateSnapshotPath(path);
    if (!checked.ok) return { status: "invalid_path", reason: checked.reason };
    const canonical = checked.path;
    const key = `${sha}\u0000${canonical}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.cacheHits += 1;
      return { status: "ok", text: cached.text, bytes: cached.bytes };
    }
    const side: ValidationSnapshotSide = sha === this.headSha ? "head" : "base";
    let index: Map<string, TreeEntry>;
    try {
      // The SAME caller signal reaches the Git subprocess: abort kills and
      // reaps the in-flight child, surfacing below as typed "aborted".
      const sourceOptions = { signal: options?.signal };
      index =
        side === "head"
          ? await this.source.listHeadFiles(sourceOptions)
          : await this.source.listBaseFiles(sourceOptions);
    } catch (error) {
      if (isGitTimeout(error)) return { status: "timeout", reason: "snapshot index read timed out" };
      if (isGitAbort(error)) return { status: "aborted", reason: "snapshot index read aborted" };
      throw error;
    }
    const entry = index.get(canonical);
    if (entry === undefined) return { status: "not_found", reason: `path is not in the ${side} snapshot` };
    if (!isRegularBlob(entry)) {
      return {
        status: "unsupported",
        reason: `path in the ${side} snapshot is not a regular file (mode ${entry.mode}, type ${entry.type})`,
      };
    }
    let text: string;
    try {
      text = await this.source.readBlobText(entry.oid, { signal: options?.signal });
    } catch (error) {
      if (isGitTimeout(error)) return { status: "timeout", reason: "snapshot blob read timed out" };
      if (isGitAbort(error)) return { status: "aborted", reason: "snapshot blob read aborted" };
      if (isSnapshotBlobFailure(error, "missing")) {
        return { status: "not_found", reason: "snapshot blob is missing at this commit" };
      }
      // Transport output-limit is not a content cap: raw overflow propagates
      // as a stage failure, never a success-shaped status. Typed blob-cap
      // failures keep their kind: the per-file cap names the per-file byte
      // cap, the cumulative cap names the total run cap, and both preserve
      // the typed byte counts/limits from the cause (never message parsing).
      if (isSnapshotBlobFailure(error, "per-file-limit")) {
        const numbers = blobCapNumbers(error);
        return numbers.sizeBytes !== undefined && numbers.limitBytes !== undefined
          ? {
              status: "size_limit",
              kind: "per-file-limit",
              sizeBytes: numbers.sizeBytes,
              limitBytes: numbers.limitBytes,
              reason: `snapshot blob is ${numbers.sizeBytes} bytes, above the ${numbers.limitBytes}-byte per-file snapshot cap`,
            }
          : { status: "size_limit", kind: "per-file-limit", reason: "snapshot blob exceeds the per-file snapshot cap" };
      }
      if (isSnapshotBlobFailure(error, "cumulative-limit")) {
        const numbers = blobCapNumbers(error);
        return numbers.sizeBytes !== undefined && numbers.limitBytes !== undefined
          ? {
              status: "size_limit",
              kind: "cumulative-limit",
              sizeBytes: numbers.sizeBytes,
              limitBytes: numbers.limitBytes,
              reason: `snapshot total ${numbers.sizeBytes} bytes would exceed the ${numbers.limitBytes}-byte run cap`,
            }
          : { status: "size_limit", kind: "cumulative-limit", reason: "snapshot total exceeds the run cap" };
      }
      throw error;
    }
    if (text.includes("\u0000"))
      return { status: "binary", reason: "snapshot blob is binary content, never evidence text" };
    const bytes = new TextEncoder().encode(text).length;
    const fileCap = positiveInt(options?.maxBytes, this.maxFileBytes, "maxBytes");
    if (bytes > fileCap) {
      return {
        status: "size_limit",
        kind: "per-file-limit",
        sizeBytes: bytes,
        limitBytes: fileCap,
        reason: `snapshot blob is ${bytes} bytes, above the ${fileCap}-byte per-file snapshot cap`,
      };
    }
    if (this.cachedBytes + bytes > this.maxTotalBytes) {
      return {
        status: "size_limit",
        kind: "cumulative-limit",
        sizeBytes: this.cachedBytes + bytes,
        limitBytes: this.maxTotalBytes,
        reason: `snapshot total ${this.cachedBytes + bytes} bytes would exceed the ${this.maxTotalBytes}-byte run cap`,
      };
    }
    if (this.cache.size < this.maxEntries) {
      this.cache.set(key, { text, bytes });
      this.cachedBytes += bytes;
    }
    return { status: "ok", text, bytes };
  }

  stats(): ValidationSnapshotStats {
    return {
      reads: this.reads,
      cacheHits: this.cacheHits,
      entries: this.cache.size,
      cachedBytes: this.cachedBytes,
      gitCalls: this.source.stats().gitCalls,
    };
  }

  clear(): void {
    this.cache.clear();
    this.cachedBytes = 0;
  }
}

export interface FakeSnapshotScript {
  head?: Readonly<Record<string, SnapshotReadResult>> | undefined;
  base?: Readonly<Record<string, SnapshotReadResult>> | undefined;
}

/**
 * Scripted reader for tests: records every read, never touches git or the
 * filesystem. Script keys resolve through the same path canonicalization as
 * the real reader. Unscripted paths throw loudly so unexpected reads fail tests.
 */
export class FakeValidationSnapshotReader implements ValidationSnapshotReader {
  readonly headSha: string;
  readonly mergeBase: string;
  readonly reads: { side: ValidationSnapshotSide; path: string }[] = [];
  cleared = 0;
  private readonly script = new Map<string, SnapshotReadResult>();

  constructor(input: { headSha: string; mergeBase: string; script?: FakeSnapshotScript | undefined }) {
    this.headSha = normalizeCommitSha(input.headSha, "headSha");
    this.mergeBase = normalizeCommitSha(input.mergeBase, "mergeBase");
    for (const [side, table] of [
      ["head", input.script?.head],
      ["base", input.script?.base],
    ] as const) {
      if (table === undefined) continue;
      for (const [path, result] of Object.entries(table)) {
        this.script.set(`${side}\u0000${path}`, result);
      }
    }
  }

  readHead(path: string, options?: ValidationSnapshotReadOptions | undefined): Promise<SnapshotReadResult> {
    if (options?.signal?.aborted === true) {
      return Promise.resolve({ status: "aborted", reason: "snapshot read aborted before the first Git call" });
    }
    return Promise.resolve(this.lookup("head", path));
  }

  readBase(path: string, options?: ValidationSnapshotReadOptions | undefined): Promise<SnapshotReadResult> {
    if (options?.signal?.aborted === true) {
      return Promise.resolve({ status: "aborted", reason: "snapshot read aborted before the first Git call" });
    }
    return Promise.resolve(this.lookup("base", path));
  }

  readAt(
    commitSha: string,
    path: string,
    options?: ValidationSnapshotReadOptions | undefined,
  ): Promise<SnapshotReadResult> {
    if (options?.signal?.aborted === true) {
      return Promise.resolve({ status: "aborted", reason: "snapshot read aborted before the first Git call" });
    }
    const sha = typeof commitSha === "string" ? commitSha.toLowerCase() : "";
    if (!FULL_SHA_PATTERN.test(sha)) {
      throw internal("ValidationSnapshotReader requires commitSha to be a full 40- or 64-character hex commit SHA");
    }
    if (sha !== this.headSha && sha !== this.mergeBase) {
      return Promise.resolve({
        status: "sha_mismatch",
        reason: `commit ${sha} is not this run's head or merge-base snapshot`,
      });
    }
    return Promise.resolve(this.lookup(sha === this.headSha ? "head" : "base", path));
  }

  stats(): ValidationSnapshotStats {
    return { reads: this.reads.length, cacheHits: 0, entries: 0, cachedBytes: 0, gitCalls: 0 };
  }

  clear(): void {
    this.cleared += 1;
  }

  private lookup(side: ValidationSnapshotSide, path: string): SnapshotReadResult {
    this.reads.push({ side, path });
    const checked = validateSnapshotPath(path);
    const hit = this.script.get(`${side}\u0000${checked.ok ? checked.path : path}`);
    if (hit === undefined) throw new Error(`FakeValidationSnapshotReader: no scripted result for ${side}:${path}`);
    return hit;
  }
}
