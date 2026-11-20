import type { ChangedFile, DiffHunk, DiffSkipReason } from "../types/diff.ts";
import { matchGlob } from "../utils/glob.ts";

const LOCKFILE_BASENAMES: ReadonlySet<string> = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "Gemfile.lock",
  "Pipfile.lock",
  "poetry.lock",
  "uv.lock",
  "composer.lock",
  "go.sum",
  "Podfile.lock",
  "gradle.lockfile",
]);

const GENERATED_MARKERS: readonly string[] = ["@generated", "do not edit", "generated file"];
const GENERATED_HEADER_BYTES = 8192;
const GENERATED_HEADER_LINES = 20;

export function isLockfile(path: string): boolean {
  return LOCKFILE_BASENAMES.has(path.slice(path.lastIndexOf("/") + 1));
}

// Case-insensitive marker search over the header window only (first 8 KiB or
// first 20 lines, whichever comes first), so ordinary source comments that
// mention generated files do not trigger a skip.
export function isGeneratedContent(content: string): boolean {
  const head = content.slice(0, GENERATED_HEADER_BYTES).split("\n", GENERATED_HEADER_LINES).join("\n").toLowerCase();
  return GENERATED_MARKERS.some((marker) => head.includes(marker));
}

export function exceedsFileSizeLimit(blobBytes: number, maxFileSizeKb: number): boolean {
  return blobBytes > maxFileSizeKb * 1024;
}

export function countChangedLines(hunks: readonly DiffHunk[]): number {
  let count = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add" || line.kind === "del") count += 1;
    }
  }
  return count;
}

export function exceedsChangedLineLimit(hunks: readonly DiffHunk[], maxChangedLinesPerFile: number): boolean {
  return countChangedLines(hunks) > maxChangedLinesPerFile;
}

export interface SkipDecisionInput {
  status: ChangedFile["status"];
  path: string;
  binary: boolean;
  unsupportedMode?: boolean | undefined;
  ignorePaths: readonly string[];
  headBlobBytes: number | null;
  headSample: string | null;
  changedLines: number;
  maxFileSizeKb: number;
  maxChangedLinesPerFile: number;
}

// Fixed precedence (ADR 0010): deleted > unsupported-mode > binary >
// lockfile > ignored > too-large > generated. Mode determines readability
// before any content check; binary (numstat) needs no patch; path filters
// run before blob sizes; sizes before patches; generated last.
export function selectSkipReason(input: SkipDecisionInput): DiffSkipReason | undefined {
  if (input.status === "deleted") return "deleted";
  if (input.unsupportedMode === true) return "unsupported-mode";
  if (input.binary) return "binary";
  if (isLockfile(input.path)) return "lockfile";
  for (const pattern of input.ignorePaths) {
    if (matchGlob(input.path, pattern)) return "ignored";
  }
  if (input.headBlobBytes !== null && exceedsFileSizeLimit(input.headBlobBytes, input.maxFileSizeKb)) {
    return "too-large";
  }
  if (input.changedLines > input.maxChangedLinesPerFile) return "too-large";
  if (input.headSample !== null && isGeneratedContent(input.headSample)) return "generated";
  return undefined;
}
