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
import type { TreeEntry } from "../context/snapshot.ts";
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

export type SnapshotReadResult =
  | { status: "ok"; text: string; bytes: number }
  | { status: Exclude<SnapshotReadStatus, "ok">; reason: string };

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
 */
export interface ValidationSnapshotSource {
  readonly headSha: string;
  readonly mergeBase: string;
  listHeadFiles(): Promise<Map<string, TreeEntry>>;
  listBaseFiles(): Promise<Map<string, TreeEntry>>;
  readBlobText(oid: string): Promise<string>;
  stats(): { gitCalls: number };
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
      index = side === "head" ? await this.source.listHeadFiles() : await this.source.listBaseFiles();
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
      text = await this.source.readBlobText(entry.oid);
    } catch (error) {
      if (isGitTimeout(error)) return { status: "timeout", reason: "snapshot blob read timed out" };
      if (isGitAbort(error)) return { status: "aborted", reason: "snapshot blob read aborted" };
      if (isSnapshotBlobFailure(error, "missing")) {
        return { status: "not_found", reason: "snapshot blob is missing at this commit" };
      }
      // Transport output-limit is not a content cap: raw overflow propagates
      // as a stage failure, never a success-shaped status.
      if (isSnapshotBlobFailure(error, "per-file-limit") || isSnapshotBlobFailure(error, "cumulative-limit")) {
        return { status: "size_limit", reason: "snapshot blob exceeds the per-file snapshot cap" };
      }
      throw error;
    }
    if (text.includes("\u0000"))
      return { status: "binary", reason: "snapshot blob is binary content, never evidence text" };
    const bytes = new TextEncoder().encode(text).length;
    const fileCap = positiveInt(options?.maxBytes, this.maxFileBytes, "maxBytes");
    if (bytes > fileCap) {
      return { status: "size_limit", reason: `snapshot blob is ${bytes} bytes, above the ${fileCap}-byte file cap` };
    }
    if (this.cachedBytes + bytes > this.maxTotalBytes) {
      return { status: "size_limit", reason: `snapshot total would exceed the ${this.maxTotalBytes}-byte run cap` };
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

  readHead(path: string): Promise<SnapshotReadResult> {
    return Promise.resolve(this.lookup("head", path));
  }

  readBase(path: string): Promise<SnapshotReadResult> {
    return Promise.resolve(this.lookup("base", path));
  }

  readAt(commitSha: string, path: string): Promise<SnapshotReadResult> {
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
