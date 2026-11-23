// Phase 6 merge-base sampling (P6-01, plan section 5).
//
// Builds the bounded baseline population that detectors analyze: the exact
// merge-base tree with every PR-touched path removed, ranked by the pinned
// sampling hash and capped by the frozen file/byte budgets. Blobs are read by
// object id only; the working tree and the PR head are never consulted.

import { createHash } from "node:crypto";
import { ReviewerError } from "../core/errors.ts";
import { isRegularBlob, parseBatchCheckLine, parseBatchContent, parseLsTreeZ } from "../context/snapshot.ts";
import type { BatchCheckEntry } from "../context/snapshot.ts";
import type { SupportedLanguage } from "../context/runtime.ts";
import { decode, gitFailed } from "../diff/git-exec.ts";
import { isGeneratedContent, isLockfile } from "../diff/filters.ts";
import { isFullCommitSha } from "../diff/revisions.ts";
import { matchGlob } from "../utils/glob.ts";
import { runProcess } from "../utils/spawn.ts";
import {
  MAX_SAMPLED_FILES,
  MAX_SAMPLED_FILE_BYTES,
  MAX_SAMPLED_TOTAL_BYTES,
  SAMPLING_HASH_DOMAIN,
} from "./constants.ts";

// Every Unicode control character (C0, DEL, C1): rejected in sampled paths
// and, by the same predicate, in every convention-adjacent path check.
const CONTROL_CHAR_PATTERN = /\p{Cc}/u;

const SAMPLED_TIMEOUT_MS = 30_000;

// One bounded `--batch-check` round-trip covers at most this many object ids.
// The merge-base tree can list far more eligible blobs than the frozen caps
// admit, so sizes resolve in rank order through successive batches instead of
// one unbounded request.
export const SAMPLING_SIZE_BATCH_OIDS = 200;

// Per-OID stdout headroom for one `--batch-check` reply line (`<40-hex> SP
// <type> SP <size> LF` is ~60 bytes; 128 mirrors the snapshot batch framing
// slack and keeps one corrupt reply from buffering unbounded metadata).
const SAMPLING_BATCH_CHECK_LINE_BYTES = 128;

const textDecoder = new TextDecoder("utf-8", { fatal: false });

export interface MergeBaseCandidate {
  path: string;
  oid: string;
  sizeBytes: number;
}

export interface SampledSourceFile {
  path: string;
  oid: string;
  sizeBytes: number;
  language: SupportedLanguage;
  source: string;
}

export interface MergeBaseSampleStats {
  listedBlobs: number;
  touchedExcluded: number;
  ineligibleExcluded: number;
  sizeExcluded: number;
  contentSkipped: number;
  sizeBatches: number;
}

export interface MergeBaseSample {
  files: SampledSourceFile[];
  stats: MergeBaseSampleStats;
}

export interface SampleMergeBaseInput {
  repoRoot: string;
  mergeBase: string;
  headSha: string;
  files: ReadonlyArray<{ path: string; oldPath: string | null }>;
  ignorePaths: readonly string[];
  signal?: AbortSignal | undefined;
}

// Canonical repo-relative POSIX path: non-empty, relative, no empty or
// dot-dot segments, no backslashes, no control characters. Ordinary spaces
// and valid Unicode path characters stay eligible.
export function isCanonicalSamplePath(path: string): boolean {
  if (path.length === 0) return false;
  if (CONTROL_CHAR_PATTERN.test(path)) return false;
  if (path.startsWith("/")) return false;
  if (path.includes("\\")) return false;
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") return false;
  }
  return true;
}

function extensionOf(path: string): string | null {
  const slash = path.lastIndexOf("/");
  const base = slash === -1 ? path : path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return base.slice(dot).toLowerCase();
}

// Maps only the four first-cut sampled extensions; anything else is outside
// the population regardless of parser support elsewhere.
export function languageForSampledPath(path: string): SupportedLanguage | null {
  switch (extensionOf(path)) {
    case ".ts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".jsx":
      return "javascript";
    default:
      return null;
  }
}

// Path-level eligibility: canonical shape, supported extension, untouched by
// the PR, not a lockfile, not ignored. Content checks (binary, generated,
// byte caps) need blob reads and run later.
export function isSamplePathEligible(
  path: string,
  touchedPaths: ReadonlySet<string>,
  ignorePaths: readonly string[],
): boolean {
  if (!isCanonicalSamplePath(path)) return false;
  if (languageForSampledPath(path) === null) return false;
  if (touchedPaths.has(path)) return false;
  if (isLockfile(path)) return false;
  for (const pattern of ignorePaths) {
    if (matchGlob(path, pattern)) return false;
  }
  return true;
}

// Every PR-touched path on both rename sides; the PR must not rewrite the
// baseline used to judge it.
export function collectTouchedPaths(
  files: ReadonlyArray<{ path: string; oldPath: string | null }>,
): ReadonlySet<string> {
  const touched = new Set<string>();
  for (const file of files) {
    touched.add(file.path);
    if (file.oldPath !== null) touched.add(file.oldPath);
  }
  return touched;
}

// Deterministic sampling rank: sha256(domain + NUL + canonicalPath)
// ascending, then canonical path by code-unit order. Enumeration order, OS,
// and process timing must not affect the sample.
export function rankPathsForSampling(paths: readonly string[]): string[] {
  const scored = paths.map((path) => ({
    path,
    digest: createHash("sha256").update(`${SAMPLING_HASH_DOMAIN}\0${path}`).digest(),
  }));
  scored.sort((a, b) => {
    const order = Buffer.compare(a.digest, b.digest);
    if (order !== 0) return order;
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });
  return scored.map((entry) => entry.path);
}

// First-fit within the frozen caps over rank-ordered candidates. Candidates
// must already be in sampling rank order; oversize, empty, and over-budget
// entries are skipped without replacement.
export function selectSampledFiles(candidates: readonly MergeBaseCandidate[]): MergeBaseCandidate[] {
  const selected: MergeBaseCandidate[] = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    if (selected.length >= MAX_SAMPLED_FILES) break;
    if (candidate.sizeBytes <= 0 || candidate.sizeBytes > MAX_SAMPLED_FILE_BYTES) continue;
    if (totalBytes + candidate.sizeBytes > MAX_SAMPLED_TOTAL_BYTES) continue;
    selected.push(candidate);
    totalBytes += candidate.sizeBytes;
  }
  return selected;
}

// Exact stdout bound for a size batch: request count times per-line headroom.
export function batchCheckStdoutCap(oidCount: number): number {
  return oidCount * SAMPLING_BATCH_CHECK_LINE_BYTES;
}

// Pure parse of one bounded `--batch-check` reply. Every requested OID must
// appear exactly once; truncated lines, unknown OIDs, missing entries, and
// trailing garbage are explicit transport failures, never partial results.
export function parseBatchCheckOutput(stdout: string, expectedOids: readonly string[]): Map<string, BatchCheckEntry> {
  const wanted = new Set(expectedOids.map((oid) => oid.toLowerCase()));
  const sizes = new Map<string, BatchCheckEntry>();
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const entry = parseBatchCheckLine(line);
    if (!wanted.has(entry.oid)) {
      throw gitFailed(`unexpected batch-check entry for "${entry.oid}"`);
    }
    sizes.set(entry.oid, entry);
  }
  for (const oid of wanted) {
    if (!sizes.has(oid)) {
      throw gitFailed(`incomplete batch-check response (missing entry for "${oid}")`);
    }
  }
  return sizes;
}

// One bounded `--batch-check` round-trip for at most SAMPLING_SIZE_BATCH_OIDS
// object ids. Timeout, output-limit, and abort surface unchanged as GIT_FAILED
// with the runProcess reason; malformed lines fail via parseBatchCheckOutput.
export async function checkMergeBaseSizes(
  repoRoot: string,
  oids: readonly string[],
  signal?: AbortSignal | undefined,
): Promise<Map<string, BatchCheckEntry>> {
  const unique = [...new Set(oids.map((oid) => oid.toLowerCase()))];
  if (unique.length === 0) return new Map();
  if (unique.length > SAMPLING_SIZE_BATCH_OIDS) {
    throw new ReviewerError({
      code: "INTERNAL",
      message: `checkMergeBaseSizes requires at most ${String(SAMPLING_SIZE_BATCH_OIDS)} OIDs per batch`,
    });
  }
  const result = await runProcess({
    cmd: ["git", "cat-file", "--batch-check"],
    cwd: repoRoot,
    timeoutMs: SAMPLED_TIMEOUT_MS,
    maxStdoutBytes: batchCheckStdoutCap(unique.length),
    stdinData: `${unique.join("\n")}\n`,
    ...(signal === undefined ? {} : { signal }),
  });
  return parseBatchCheckOutput(decode(result.stdout), unique);
}

function checkSha(value: string, label: string): string {
  if (!isFullCommitSha(value)) {
    throw new ReviewerError({ code: "INTERNAL", message: `sampleMergeBase requires ${label} to be a full commit SHA` });
  }
  return value.toLowerCase();
}

async function readMergeBaseBlobs(
  repoRoot: string,
  candidates: readonly MergeBaseCandidate[],
  signal: AbortSignal | undefined,
): Promise<Map<string, string>> {
  // One `cat-file --batch` spawn for the whole take-list: framing offsets
  // come from header sizes only, so embedded NUL/LF bytes in blob content
  // never desynchronize the stream. Duplicate OIDs resolve once; path-level
  // files still map back through the shared source. Caller aborts propagate;
  // protocol violations fail the run (transport failure, not per-file data).
  const uniqueOids = [...new Set(candidates.map((candidate) => candidate.oid))];
  const totalBytes = candidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0);
  const result = await runProcess({
    cmd: ["git", "cat-file", "--batch"],
    cwd: repoRoot,
    timeoutMs: SAMPLED_TIMEOUT_MS,
    maxStdoutBytes: totalBytes + uniqueOids.length * 128,
    stdinData: `${uniqueOids.join("\n")}\n`,
    ...(signal === undefined ? {} : { signal }),
  });
  const frames = parseBatchContent(result.stdout, uniqueOids);
  const sources = new Map<string, string>();
  for (const candidate of candidates) {
    const frame = frames.get(candidate.oid.toLowerCase());
    if (frame === undefined || frame.status === "missing") continue;
    sources.set(candidate.oid, textDecoder.decode(frame.bytes));
  }
  return sources;
}

export async function sampleMergeBase(input: SampleMergeBaseInput): Promise<MergeBaseSample> {
  const mergeBase = checkSha(input.mergeBase, "mergeBase");
  checkSha(input.headSha, "headSha");
  const touched = collectTouchedPaths(input.files);

  const treeBytes = (
    await runProcess({
      cmd: ["git", "ls-tree", "-r", "-z", "--full-tree", mergeBase],
      cwd: input.repoRoot,
      timeoutMs: SAMPLED_TIMEOUT_MS,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
  ).stdout;
  const index = parseLsTreeZ(treeBytes);

  let listedBlobs = 0;
  let touchedExcluded = 0;
  let ineligibleExcluded = 0;
  const pathLanguages = new Map<string, SupportedLanguage>();
  const oidByPath = new Map<string, string>();
  for (const [path, entry] of index) {
    if (!isRegularBlob(entry)) continue;
    listedBlobs += 1;
    const language = isCanonicalSamplePath(path) ? languageForSampledPath(path) : null;
    if (language === null) {
      ineligibleExcluded += 1;
      continue;
    }
    if (touched.has(path)) {
      touchedExcluded += 1;
      continue;
    }
    if (isLockfile(path)) {
      ineligibleExcluded += 1;
      continue;
    }
    let ignored = false;
    for (const pattern of input.ignorePaths) {
      if (matchGlob(path, pattern)) {
        ignored = true;
        break;
      }
    }
    if (ignored) {
      ineligibleExcluded += 1;
      continue;
    }
    pathLanguages.set(path, language);
    oidByPath.set(path, entry.oid);
  }

  // Rank-first bounded sizing: eligible paths rank before any size lookup,
  // so enumeration order never affects the sample. Sizes resolve in rank
  // order through successive bounded batches; the next batch issues only
  // while the frozen caps are still unfilled, and oversized entries are
  // skipped in place without disturbing rank order. Duplicate OIDs resolve
  // once but select per path. Stopping early is exact: a full file count, or
  // a full byte budget that not even a 1-byte file could fit, leaves nothing
  // further selectable.
  const rankedPaths = rankPathsForSampling([...oidByPath.keys()]);
  const sized: MergeBaseCandidate[] = [];
  const sizeByOid = new Map<string, BatchCheckEntry>();
  let sizeExcluded = 0;
  let sizeBatches = 0;
  let selected = selectSampledFiles(sized);
  let selectedBytes = 0;
  let cursor = 0;
  while (cursor < rankedPaths.length) {
    input.signal?.throwIfAborted();
    if (selected.length >= MAX_SAMPLED_FILES || selectedBytes >= MAX_SAMPLED_TOTAL_BYTES) break;
    const window: string[] = [];
    const needed: string[] = [];
    const neededSet = new Set<string>();
    for (let index = cursor; index < rankedPaths.length && needed.length < SAMPLING_SIZE_BATCH_OIDS; index += 1) {
      const path = rankedPaths[index];
      if (path === undefined) break;
      window.push(path);
      const oid = oidByPath.get(path);
      if (oid === undefined) continue;
      const key = oid.toLowerCase();
      if (!sizeByOid.has(key) && !neededSet.has(key)) {
        neededSet.add(key);
        needed.push(oid);
      }
    }
    cursor += window.length;
    if (needed.length > 0) {
      const resolved = await checkMergeBaseSizes(input.repoRoot, needed, input.signal);
      sizeBatches += 1;
      for (const [oid, entry] of resolved) sizeByOid.set(oid, entry);
    }
    for (const path of window) {
      const oid = oidByPath.get(path);
      if (oid === undefined) {
        throw new ReviewerError({ code: "INTERNAL", message: `sampleMergeBase has no OID for ranked path "${path}"` });
      }
      const entry = sizeByOid.get(oid.toLowerCase());
      if (entry === undefined) {
        throw new ReviewerError({ code: "INTERNAL", message: `sampleMergeBase has no size for ranked path "${path}"` });
      }
      // A missing object fails the run (a merge-base tree must resolve)
      // while non-blob types are defensively skipped.
      if (entry.type === "missing" || entry.size === null) {
        throw gitFailed(
          `merge-base object for "${path}" is missing; fetch sufficient history locally (no fetch is performed automatically)`,
        );
      }
      if (entry.type !== "blob" || entry.size <= 0 || entry.size > MAX_SAMPLED_FILE_BYTES) {
        sizeExcluded += 1;
        continue;
      }
      sized.push({ path, oid, sizeBytes: entry.size });
    }
    selected = selectSampledFiles(sized);
    selectedBytes = selected.reduce((sum, candidate) => sum + candidate.sizeBytes, 0);
  }

  let contentSkipped = 0;
  const files: SampledSourceFile[] = [];
  const sources =
    selected.length === 0
      ? new Map<string, string>()
      : await readMergeBaseBlobs(input.repoRoot, selected, input.signal);
  for (const candidate of selected) {
    const language = pathLanguages.get(candidate.path);
    if (language === undefined) continue;
    const source = sources.get(candidate.oid);
    if (source === undefined) {
      contentSkipped += 1;
      continue;
    }
    if (source.length === 0 || source.includes("\0") || isGeneratedContent(source)) {
      contentSkipped += 1;
      continue;
    }
    files.push({
      path: candidate.path,
      oid: candidate.oid,
      sizeBytes: candidate.sizeBytes,
      language,
      source,
    });
  }

  return {
    files,
    stats: { listedBlobs, touchedExcluded, ineligibleExcluded, sizeExcluded, contentSkipped, sizeBatches },
  };
}
