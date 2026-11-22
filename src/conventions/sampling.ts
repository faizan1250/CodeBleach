// Phase 6 merge-base sampling (P6-01, plan section 5).
//
// Builds the bounded baseline population that detectors analyze: the exact
// merge-base tree with every PR-touched path removed, ranked by the pinned
// sampling hash and capped by the frozen file/byte budgets. Blobs are read by
// object id only; the working tree and the PR head are never consulted.

import { createHash } from "node:crypto";
import { ReviewerError } from "../core/errors.ts";
import { isRegularBlob, parseBatchContent, parseLsTreeZ } from "../context/snapshot.ts";
import type { SupportedLanguage } from "../context/runtime.ts";
import { batchCheckBlobSizes } from "../diff/blobs.ts";
import { gitFailed } from "../diff/git-exec.ts";
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
  // never desynchronize the stream. Caller aborts propagate; protocol
  // violations fail the run (transport failure, not per-file data).
  const oids = candidates.map((candidate) => candidate.oid);
  const totalBytes = candidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0);
  const result = await runProcess({
    cmd: ["git", "cat-file", "--batch"],
    cwd: repoRoot,
    timeoutMs: SAMPLED_TIMEOUT_MS,
    maxStdoutBytes: totalBytes + oids.length * 128,
    stdinData: `${oids.join("\n")}\n`,
    ...(signal === undefined ? {} : { signal }),
  });
  const frames = parseBatchContent(result.stdout, oids);
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

  // One batch-check process for every candidate size; a missing object fails
  // the run (a merge-base tree must resolve) while non-blob types are
  // defensively skipped.
  const sizes = await batchCheckBlobSizes(input.repoRoot, [...oidByPath.values()]);
  let sizeExcluded = 0;
  const sized: MergeBaseCandidate[] = [];
  for (const [path, oid] of oidByPath) {
    const size = sizes.get(oid);
    if (size === undefined || size.type === "missing") {
      throw gitFailed(
        `merge-base object for "${path}" is missing; fetch sufficient history locally (no fetch is performed automatically)`,
      );
    }
    if (size.type !== "blob" || size.size <= 0 || size.size > MAX_SAMPLED_FILE_BYTES) {
      sizeExcluded += 1;
      continue;
    }
    sized.push({ path, oid, sizeBytes: size.size });
  }

  const rankedPaths = rankPathsForSampling(sized.map((entry) => entry.path));
  const rankIndex = new Map<string, number>();
  rankedPaths.forEach((path, position) => {
    rankIndex.set(path, position);
  });
  const ordered = [...sized].sort((a, b) => {
    const left = rankIndex.get(a.path) ?? Number.MAX_SAFE_INTEGER;
    const right = rankIndex.get(b.path) ?? Number.MAX_SAFE_INTEGER;
    return left - right;
  });
  const selected = selectSampledFiles(ordered);

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
    stats: { listedBlobs, touchedExcluded, ineligibleExcluded, sizeExcluded, contentSkipped },
  };
}
