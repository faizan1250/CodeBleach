// Phase 6 support filtering and stable convention records (P6-02, plan 7).
//
// Pure function over detector candidates: per-detector denominators, frozen
// support/evidence/dominance gates, stable inf- ids, deterministic evidence
// retention, ordering, and run cap. No I/O, no clock, no randomness. Evidence
// paths stay in memory as audit metadata; they never enter the prompt (P6-03).

import { createHash } from "node:crypto";
import type { InferredConvention } from "../types/conventions.ts";
import {
  INFERRED_CONVENTION_ID_PREFIX,
  MAX_CONVENTIONS_PER_RUN,
  MAX_CONVENTION_PATTERN_CHARS,
  MAX_EVIDENCE_PER_CONVENTION,
  MIN_EVIDENCE_FILES,
} from "./constants.ts";
import type { DetectorCandidate } from "./detectors/index.ts";

// Stable id domain: bumping it renames every convention, so it is pinned
// beside the frozen bounds rather than derived from them.
const CONVENTION_ID_DOMAIN = "codebleach-phase6-convention-v1";
const CONVENTION_ID_HEX_CHARS = 16;
const CONTROL_CHAR_PATTERN = /\p{Cc}/u;

// Exact integer forms of the frozen float bounds: MIN_SUPPORT_RATIO (0.75) is
// 3/4 and MIN_DOMINANCE_MARGIN (0.20) is 1/5 of eligible files. Integer
// cross-products keep boundary decisions exact with no float tie drift.
function meetsSupportRatio(matchingFiles: number, eligibleFiles: number): boolean {
  return matchingFiles * 4 >= eligibleFiles * 3;
}

// Dominance of the leading style over the reported runner-up, as a share of
// eligible files. Only meaningful for mutually exclusive classifications
// (error-handling); single-pattern detectors omit the runner-up count.
export function hasDominanceMargin(
  matchingFiles: number,
  runnerUpMatchingFiles: number,
  eligibleFiles: number,
): boolean {
  return (matchingFiles - runnerUpMatchingFiles) * 5 >= eligibleFiles;
}

// Canonical pattern form for id input: surrounding whitespace trimmed,
// interior runs collapsed. Case is preserved; distinct casing is distinct.
function normalizePatternText(pattern: string): string {
  return pattern.trim().replace(/\s+/g, " ");
}

// Stable inf- id from detector name, detector version, and normalized
// pattern. SHA-256 per plan 7.3: the existing repo sha1 helpers serve finding
// fingerprints and prompt hashes in other namespaces, so this new namespace
// takes the stronger hash. Never a ruleId; the advisory boundary rejects
// every ruleId regardless of value.
export function conventionIdFor(detector: string, detectorVersion: number, pattern: string): string {
  const digest = createHash("sha256")
    .update(`${CONVENTION_ID_DOMAIN}\0${detector}\0${detectorVersion}\0${normalizePatternText(pattern)}`)
    .digest("hex")
    .slice(0, CONVENTION_ID_HEX_CHARS);
  return `${INFERRED_CONVENTION_ID_PREFIX}${digest}`;
}

function isSafeCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function comparePaths(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// Applies every P6-02 retention gate; null means the candidate is dropped.
// matchingFiles stays the full pre-truncation count; only evidence is capped.
function toInferredConvention(candidate: DetectorCandidate): InferredConvention | null {
  if (!isSafeCount(candidate.eligibleFiles) || candidate.eligibleFiles <= 0) return null;
  if (!isSafeCount(candidate.matchingFiles) || candidate.matchingFiles > candidate.eligibleFiles) return null;
  if (candidate.matchingFiles < MIN_EVIDENCE_FILES) return null;
  if (!meetsSupportRatio(candidate.matchingFiles, candidate.eligibleFiles)) return null;
  const runnerUp = candidate.runnerUpMatchingFiles ?? 0;
  if (!isSafeCount(runnerUp)) return null;
  if (candidate.runnerUpMatchingFiles !== undefined) {
    if (!hasDominanceMargin(candidate.matchingFiles, runnerUp, candidate.eligibleFiles)) return null;
  }
  if (
    candidate.pattern.length === 0 ||
    candidate.pattern.length > MAX_CONVENTION_PATTERN_CHARS ||
    CONTROL_CHAR_PATTERN.test(candidate.pattern)
  ) {
    return null;
  }
  const evidence = [...candidate.evidence]
    .sort((a, b) => comparePaths(a.file, b.file) || a.startLine - b.startLine || a.endLine - b.endLine)
    .slice(0, MAX_EVIDENCE_PER_CONVENTION)
    .map((entry) => ({
      kind: "source-span" as const,
      file: entry.file,
      startLine: entry.startLine,
      endLine: entry.endLine,
    }));
  return {
    id: conventionIdFor(candidate.detector, candidate.detectorVersion, candidate.pattern),
    detector: candidate.detector,
    detectorVersion: candidate.detectorVersion,
    pattern: candidate.pattern,
    evidence,
    matchingFiles: candidate.matchingFiles,
    eligibleFiles: candidate.eligibleFiles,
    sampledFiles: candidate.sampledFiles,
    supportRatio: candidate.matchingFiles / candidate.eligibleFiles,
  };
}

// Plan 7.4 selection order: higher support (exact cross-product, no float
// drift), higher matching count, detector name, then stable id. All code-unit
// comparisons; never locale, map, or input order.
function compareConventions(a: InferredConvention, b: InferredConvention): number {
  const supportOrder = b.matchingFiles * a.eligibleFiles - a.matchingFiles * b.eligibleFiles;
  if (supportOrder !== 0) return supportOrder;
  if (a.matchingFiles !== b.matchingFiles) return b.matchingFiles - a.matchingFiles;
  const detectorOrder = comparePaths(a.detector, b.detector);
  if (detectorOrder !== 0) return detectorOrder;
  return comparePaths(a.id, b.id);
}

// Retains only high-support patterns, deterministically ordered and capped.
export function filterConventions(candidates: readonly DetectorCandidate[]): InferredConvention[] {
  const retained: InferredConvention[] = [];
  for (const candidate of candidates) {
    const convention = toInferredConvention(candidate);
    if (convention !== null) retained.push(convention);
  }
  retained.sort(compareConventions);
  return retained.slice(0, MAX_CONVENTIONS_PER_RUN);
}
