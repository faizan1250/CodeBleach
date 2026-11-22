// Shared detector contracts (P6-01, plan section 6.1).
//
// Detectors are pure synchronous functions over already-sampled data: no
// file reads, no Git, no network, no clock, no randomness, no LLM, and no
// input mutation. Callers own tree lifetimes; detectors retain line numbers
// only. Support thresholds, stable ids, and evidence truncation arrive in
// P6-02; detectors emit full per-file evidence and raw counts.

import type { Tree } from "web-tree-sitter";
import type { SupportedLanguage } from "../../context/runtime.ts";
import type { ConventionEvidence } from "../../types/conventions.ts";

export interface ParsedSampledFile {
  path: string;
  language: SupportedLanguage;
  source: string;
  /** Live parse tree; owned and deleted by the caller. */
  tree: Tree;
}

// Raw per-detector candidate: full evidence and counts, no thresholding and
// no stable id (both P6-02). supportRatio is matching/eligible; a candidate
// is only emitted when eligibleFiles > 0, so the ratio never divides by zero.
// runnerUpMatchingFiles is set only by mutually exclusive classifications
// (error-handling) for the P6-02 dominance margin; single-pattern detectors
// omit it.
export interface DetectorCandidate {
  detector: string;
  detectorVersion: number;
  pattern: string;
  evidence: ConventionEvidence[];
  matchingFiles: number;
  eligibleFiles: number;
  sampledFiles: number;
  supportRatio: number;
  runnerUpMatchingFiles?: number;
}

export interface FileMatch {
  path: string;
  startLine: number;
  endLine: number;
}

function comparePaths(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// Sorts sampled files deterministically by canonical path (code-unit order)
// over a copy; inputs are never mutated.
export function orderSampledFiles(files: readonly ParsedSampledFile[]): ParsedSampledFile[] {
  return [...files].sort((a, b) => comparePaths(a.path, b.path));
}

// Keeps the earliest span per file, sorts by path then lines, and derives
// full counts. P6-02 truncates evidence after counting; detectors never do.
export function toCandidate(input: {
  detector: string;
  detectorVersion: number;
  pattern: string;
  matches: readonly FileMatch[];
  eligibleFiles: number;
  sampledFiles: number;
  runnerUpMatchingFiles?: number;
}): DetectorCandidate | null {
  if (input.eligibleFiles <= 0) return null;
  const earliest = new Map<string, FileMatch>();
  for (const match of input.matches) {
    const kept = earliest.get(match.path);
    if (
      kept === undefined ||
      match.startLine < kept.startLine ||
      (match.startLine === kept.startLine && match.endLine < kept.endLine)
    ) {
      earliest.set(match.path, match);
    }
  }
  const evidence: ConventionEvidence[] = [...earliest.values()]
    .sort((a, b) => comparePaths(a.path, b.path) || a.startLine - b.startLine || a.endLine - b.endLine)
    .map((match) => ({
      kind: "source-span",
      file: match.path,
      startLine: match.startLine,
      endLine: match.endLine,
    }));
  const matchingFiles = earliest.size;
  return {
    detector: input.detector,
    detectorVersion: input.detectorVersion,
    pattern: input.pattern,
    evidence,
    matchingFiles,
    eligibleFiles: input.eligibleFiles,
    sampledFiles: input.sampledFiles,
    supportRatio: matchingFiles / input.eligibleFiles,
    ...(input.runnerUpMatchingFiles === undefined ? {} : { runnerUpMatchingFiles: input.runnerUpMatchingFiles }),
  };
}

export { detectNamingExports } from "./naming.ts";
export { detectErrorHandling } from "./errors.ts";
export { detectCommonWrappers } from "./wrappers.ts";
