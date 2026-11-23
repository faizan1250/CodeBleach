import { MAX_ADVISORY_FINDINGS_PER_RUN } from "../conventions/constants.ts";
import type { Finding } from "../types/index.ts";
import type {
  AdvisoryConflictMetadata,
  PendingAdvisoryCandidate,
  PrimaryValidationResult,
  ValidationHandoffEntry,
  ValidationHandoffLocation,
} from "../types/conventions.ts";
import { validateSnapshotPath } from "./snapshot.ts";

function isSafeLine(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

// Verified head-side intervals only; base sides never enter handoff, so a
// malformed check covers path shape and line order on the non-empty list.
function isValidHandoffLocation(location: ValidationHandoffLocation): boolean {
  if (location === null || location === undefined || typeof location !== "object") return false;
  if (validateSnapshotPath(location.path).ok !== true) return false;
  if (!isSafeLine(location.startLine) || !isSafeLine(location.endLine)) return false;
  return location.endLine >= location.startLine;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Primary handoff integrity (plan 11.2). Every accepted primary finding needs
 * exactly one entry keyed by its findingId; rejected findings need none. An
 * empty headLocations list is valid (base-only evidence, no head-side overlap
 * possible). Missing/duplicate associations, unknown extra ids, or malformed
 * non-empty locations invalidate the whole run: advisories drop, primaries stay.
 */
export function validatePrimaryHandoffStructure(primary: PrimaryValidationResult): { ok: true } | { ok: false } {
  const acceptedIds = new Set<string>();
  for (const item of primary.findings) {
    if (item.status === "accepted") acceptedIds.add(item.finding.id);
  }
  const seen = new Set<string>();
  for (const entry of primary.handoff) {
    if (!acceptedIds.has(entry.findingId) || seen.has(entry.findingId)) return { ok: false };
    seen.add(entry.findingId);
    for (const location of entry.headLocations) {
      if (!isValidHandoffLocation(location)) return { ok: false };
    }
  }
  if (seen.size !== acceptedIds.size) return { ok: false };
  return { ok: true };
}

/** Candidate-local handoff check: a mismatch or malformed list drops only that advisory. */
export function validateAdvisoryHandoffEntry(candidate: PendingAdvisoryCandidate): boolean {
  if (candidate.handoff.findingId !== candidate.findingId) return false;
  for (const location of candidate.handoff.headLocations) {
    if (!isValidHandoffLocation(location)) return false;
  }
  return true;
}

function intervalsOverlap(a: ValidationHandoffLocation, b: ValidationHandoffLocation): boolean {
  return a.path === b.path && Math.max(a.startLine, b.startLine) <= Math.min(a.endLine, b.endLine);
}

/**
 * C1-C3 suppression (plan 11.1). Same canonical path with at least one shared
 * verified head-side line suppresses the advisory; adjacency, other paths, and
 * cited ranges never participate. Primary records are never touched.
 */
export function suppressOverlappingAdvisory(
  primary: readonly ValidationHandoffEntry[],
  advisories: readonly PendingAdvisoryCandidate[],
): { retained: PendingAdvisoryCandidate[]; suppressed: number } {
  const retained: PendingAdvisoryCandidate[] = [];
  let suppressed = 0;
  for (const candidate of advisories) {
    let overlaps = false;
    for (const actual of candidate.handoff.headLocations) {
      for (const entry of primary) {
        if (entry.headLocations.some((other) => intervalsOverlap(actual, other))) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) break;
    }
    if (overlaps) suppressed += 1;
    else retained.push(candidate);
  }
  return { retained, suppressed };
}

interface AdvisoryRankKey {
  confidence: number;
  path: string;
  startLine: number;
  fingerprint: string;
  id: string;
}

// Deterministic winner order (plan 11.3): confidence, canonical path,
// earliest verified start, fingerprint, then finding id.
function advisoryRankKey(candidate: PendingAdvisoryCandidate): AdvisoryRankKey {
  const locations = [...candidate.handoff.headLocations].sort(
    (a, b) => compareStrings(a.path, b.path) || a.startLine - b.startLine || a.endLine - b.endLine,
  );
  const first = locations[0];
  return {
    confidence: candidate.pendingFields.finding.confidence,
    path: first?.path ?? candidate.pendingFields.finding.file,
    startLine: first?.startLine ?? Number.MAX_SAFE_INTEGER,
    fingerprint: candidate.pendingFields.finding.fingerprint,
    id: candidate.findingId,
  };
}

function compareAdvisoryRank(a: AdvisoryRankKey, b: AdvisoryRankKey): number {
  const confidence = Number.isNaN(a.confidence) ? Number.NEGATIVE_INFINITY : a.confidence;
  const other = Number.isNaN(b.confidence) ? Number.NEGATIVE_INFINITY : b.confidence;
  if (confidence !== other) return confidence < other ? 1 : -1;
  const path = compareStrings(a.path, b.path);
  if (path !== 0) return path;
  if (a.startLine !== b.startLine) return a.startLine - b.startLine;
  const fingerprint = compareStrings(a.fingerprint, b.fingerprint);
  if (fingerprint !== 0) return fingerprint;
  return compareStrings(a.id, b.id);
}

/**
 * Advisory-only dedupe (plan 11.3). Greedy in winner order: the highest-ranked
 * candidate overlapping no already-kept interval survives. The primary
 * resolveDuplicates implementation is untouched.
 */
export function dedupeAdvisoryCandidates(candidates: readonly PendingAdvisoryCandidate[]): {
  retained: PendingAdvisoryCandidate[];
  duplicates: number;
} {
  const ranked = candidates.map((candidate) => ({ candidate, key: advisoryRankKey(candidate) }));
  ranked.sort((a, b) => compareAdvisoryRank(a.key, b.key));
  const retained: PendingAdvisoryCandidate[] = [];
  let duplicates = 0;
  for (const entry of ranked) {
    const clash = retained.some((kept) =>
      entry.candidate.handoff.headLocations.some((actual) =>
        kept.handoff.headLocations.some((other) => intervalsOverlap(actual, other)),
      ),
    );
    if (clash) duplicates += 1;
    else retained.push(entry.candidate);
  }
  return { retained, duplicates };
}

/** Advisory-only cap of five in deterministic winner order (plan 9.3/12). */
export function capAdvisoryCandidates(candidates: readonly PendingAdvisoryCandidate[]): {
  kept: PendingAdvisoryCandidate[];
  overflow: number;
} {
  const ranked = candidates.map((candidate) => ({ candidate, key: advisoryRankKey(candidate) }));
  ranked.sort((a, b) => compareAdvisoryRank(a.key, b.key));
  const kept = ranked.slice(0, MAX_ADVISORY_FINDINGS_PER_RUN).map((entry) => entry.candidate);
  return { kept, overflow: Math.max(0, ranked.length - kept.length) };
}

/**
 * Orchestration-side boundary gate (plan 12 step 2). The engine schema and the
 * isolated policy already enforce these, but trusted code re-checks exact
 * category/severity, absent ruleId, and stamped provenance before validation.
 */
export function gateAdvisoryBoundary(findings: readonly Finding[]): { passed: Finding[]; rejected: number } {
  const passed: Finding[] = [];
  let rejected = 0;
  for (const candidate of findings) {
    if (
      candidate.category !== "convention" ||
      candidate.severity !== "low" ||
      candidate.ruleId !== undefined ||
      candidate.origin.pass !== "convention-advisory"
    ) {
      rejected += 1;
      continue;
    }
    passed.push(candidate);
  }
  return { passed, rejected };
}

export interface AdvisoryMergeResult {
  retained: PendingAdvisoryCandidate[];
  metadata: AdvisoryConflictMetadata;
}

function emptyMetadata(): AdvisoryConflictMetadata {
  return { suppressed: 0, advisoryDuplicates: 0, unmappableExcluded: 0, codes: [] };
}

/**
 * Full merge filter in plan section 12 order: primary structure, candidate-local
 * handoff, suppression, advisory dedupe, advisory cap. Pure and fail-open: a
 * broken global association discards every advisory with a bounded code while
 * the caller keeps the finalized primaries unchanged.
 */
export function resolveAdvisoryMerge(
  primary: PrimaryValidationResult,
  advisories: readonly PendingAdvisoryCandidate[],
): AdvisoryMergeResult {
  const metadata = emptyMetadata();
  if (validatePrimaryHandoffStructure(primary).ok !== true) {
    metadata.unmappableExcluded = advisories.length;
    metadata.codes.push("primary_handoff_invalid");
    return { retained: [], metadata };
  }
  const seen = new Set<string>();
  const mappable: PendingAdvisoryCandidate[] = [];
  for (const candidate of advisories) {
    if (seen.has(candidate.findingId) || !validateAdvisoryHandoffEntry(candidate)) {
      metadata.unmappableExcluded += 1;
      continue;
    }
    seen.add(candidate.findingId);
    mappable.push(candidate);
  }
  if (metadata.unmappableExcluded > 0) metadata.codes.push("advisory_handoff_excluded");
  const suppressed = suppressOverlappingAdvisory(primary.handoff, mappable);
  metadata.suppressed = suppressed.suppressed;
  if (suppressed.suppressed > 0) metadata.codes.push("advisory_suppressed_by_primary");
  const deduped = dedupeAdvisoryCandidates(suppressed.retained);
  metadata.advisoryDuplicates = deduped.duplicates;
  if (deduped.duplicates > 0) metadata.codes.push("advisory_duplicates_merged");
  const capped = capAdvisoryCandidates(deduped.retained);
  if (capped.overflow > 0) metadata.codes.push("advisory_cap_overflow");
  return { retained: capped.kept, metadata };
}
