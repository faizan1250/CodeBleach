import type { Finding, Severity } from "../types/index.ts";
import type { CheckResult } from "../types/validation.ts";
import type { ResolvedTarget } from "./location.ts";
import { makeCheck } from "./checks.ts";
import { SEVERITY_RANK } from "./policy.ts";
import { validateSnapshotPath } from "./snapshot.ts";

// Stable check names; P5-08 owns the code set (dedupe_unique,
// duplicate_fingerprint, duplicate_secondary_key, max_findings_ok,
// max_findings_exceeded).
export type DedupeCheckName = "dedupe_fingerprint" | "dedupe_secondary" | "max_findings";

export interface DedupeInput {
  finding: Finding;
  /** P5-02 head-side identity; the secondary key and overlap use this, never the raw model path. */
  canonicalPath: string;
  /** Origin symbol identity (finding.symbol ?? unit symbol name; provenance pins them equal). */
  symbol: string;
  /** Policy-effective severity (rule severity wins); the finding itself is never mutated. */
  effectiveSeverity: Severity;
  /** P5-03 head-side anchor. */
  target: ResolvedTarget;
}

export interface DedupeVerdict {
  retained: boolean;
  /** Fingerprint check always; secondary check only for primary winners (stage-gated). */
  checks: CheckResult[];
  /** Retained finding id this candidate duplicates, when rejected as a duplicate. */
  duplicateOfId?: string | undefined;
}

export interface CapVerdict {
  kept: boolean;
  /** 1-based position in deterministic winner order. */
  rank: number;
}

/** Case-folded, whitespace-collapsed title. Punctuation is intentionally left
 * intact: only exact normalized-title equality merges, so distinct defects
 * keep both records (conservative secondary key). */
export function normalizeDedupeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

function confidenceValue(confidence: number): number {
  return Number.isNaN(confidence) ? Number.NEGATIVE_INFINITY : confidence;
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Total deterministic winner order: effective severity, confidence,
 * canonical path, target line, stored fingerprint, finding id. The id is the
 * final tiebreak so equal fingerprints can never fall back to input order.
 * String order is UTF-16 code-unit order, never locale-dependent. */
function compareDedupeCandidates(a: DedupeInput, b: DedupeInput): number {
  const severity = SEVERITY_RANK[b.effectiveSeverity] - SEVERITY_RANK[a.effectiveSeverity];
  if (severity !== 0) return severity;
  const mine = confidenceValue(a.finding.confidence);
  const theirs = confidenceValue(b.finding.confidence);
  if (mine !== theirs) return mine < theirs ? 1 : -1;
  const path = compareStrings(a.canonicalPath, b.canonicalPath);
  if (path !== 0) return path;
  if (a.target.line !== b.target.line) return a.target.line - b.target.line;
  const fingerprint = compareStrings(a.finding.fingerprint, b.finding.fingerprint);
  if (fingerprint !== 0) return fingerprint;
  return compareStrings(a.finding.id, b.finding.id);
}

function compareByIndex(inputs: readonly DedupeInput[]): (a: number, b: number) => number {
  return (a, b) => {
    const left = inputs[a];
    const right = inputs[b];
    if (left === undefined || right === undefined) return 0;
    const order = compareDedupeCandidates(left, right);
    return order !== 0 ? order : a - b;
  };
}

interface LineSpan {
  file: string;
  start: number;
  end: number;
}

/** Canonicalize evidence paths before comparing so `./x` and `x` spellings of
 * the same file share overlap (safe direction only: false separation, never
 * false merging). */
function canonicalEvidenceFile(file: string): string {
  const checked = validateSnapshotPath(file);
  return checked.ok ? checked.path : file;
}

function candidateSpans(input: DedupeInput): LineSpan[] {
  const spans: LineSpan[] = [{ file: input.canonicalPath, start: input.target.line, end: input.target.line }];
  for (const item of input.finding.evidence) {
    spans.push({ file: canonicalEvidenceFile(item.file), start: item.startLine, end: item.endLine });
  }
  return spans;
}

/** Shared-line overlap on the same file across resolved targets and cited
 * evidence. Near-misses with no shared line stay separate: false separation
 * shows two findings, false merging would hide a defect. */
function rangesOverlap(a: DedupeInput, b: DedupeInput): boolean {
  const right = candidateSpans(b);
  for (const left of candidateSpans(a)) {
    for (const other of right) {
      if (left.file === other.file && left.start <= other.end && other.start <= left.end) return true;
    }
  }
  return false;
}

/**
 * P5-07 same-run dedupe. Pure, no reads: the stored Phase 4 fingerprint is
 * reused verbatim as the primary key (never recomputed), then a conservative
 * secondary key (canonical path + symbol + category + normalized title +
 * overlapping ranges) merges only validated candidates that already passed
 * every earlier stage. Rejected/inconclusive findings never reach this
 * function and consume nothing.
 */
export function resolveDuplicates(inputs: readonly DedupeInput[]): DedupeVerdict[] {
  const verdicts: DedupeVerdict[] = inputs.map(() => ({ retained: true, checks: [] }));

  const primary = new Map<string, number[]>();
  inputs.forEach((input, index) => {
    const group = primary.get(input.finding.fingerprint);
    if (group === undefined) primary.set(input.finding.fingerprint, [index]);
    else group.push(index);
  });

  const orderByIndex = compareByIndex(inputs);
  const winnerIndices: number[] = [];
  for (const group of primary.values()) {
    const ordered = [...group].sort(orderByIndex);
    const first = ordered[0];
    if (first === undefined) continue;
    const winner = inputs[first];
    const winnerVerdict = verdicts[first];
    if (winner === undefined || winnerVerdict === undefined) continue;
    winnerIndices.push(first);
    winnerVerdict.checks.push(makeCheck("dedupe_fingerprint", "passed", "dedupe_unique"));
    for (const other of ordered.slice(1)) {
      const verdict = verdicts[other];
      if (verdict === undefined) continue;
      verdict.retained = false;
      verdict.duplicateOfId = winner.finding.id;
      verdict.checks.push(
        makeCheck(
          "dedupe_fingerprint",
          "failed",
          "duplicate_fingerprint",
          `duplicate of finding ${winner.finding.id} (shared fingerprint)`,
        ),
      );
    }
  }

  const secondary = new Map<string, number[]>();
  for (const index of winnerIndices) {
    const input = inputs[index];
    const verdict = verdicts[index];
    if (input === undefined || verdict === undefined) continue;
    const title = normalizeDedupeTitle(input.finding.title);
    if (title.length === 0) {
      verdict.checks.push(
        makeCheck("dedupe_secondary", "passed", "dedupe_unique", "no comparable title; kept as distinct"),
      );
      continue;
    }
    // \0 separators: adjacent fields can never forge a cross-boundary collision.
    const key = [input.canonicalPath, input.symbol, input.finding.category, title].join("\0");
    const group = secondary.get(key);
    if (group === undefined) secondary.set(key, [index]);
    else group.push(index);
  }

  for (const group of secondary.values()) {
    const retained: number[] = [];
    for (const index of [...group].sort(orderByIndex)) {
      const input = inputs[index];
      const verdict = verdicts[index];
      if (input === undefined || verdict === undefined) continue;
      const match = retained.find((kept) => {
        const other = inputs[kept];
        return other !== undefined && rangesOverlap(other, input);
      });
      if (match === undefined) {
        retained.push(index);
        verdict.checks.push(makeCheck("dedupe_secondary", "passed", "dedupe_unique"));
      } else {
        const other = inputs[match];
        verdict.retained = false;
        verdict.duplicateOfId = other?.finding.id;
        verdict.checks.push(
          makeCheck(
            "dedupe_secondary",
            "failed",
            "duplicate_secondary_key",
            `secondary duplicate of finding ${other?.finding.id ?? "unknown"}: same path, symbol, category, and title with overlapping ranges`,
          ),
        );
      }
    }
  }

  return verdicts;
}

/**
 * `max_findings` over post-dedupe winners only, in deterministic winner
 * order. Rejected, inconclusive, and duplicate findings never consume the
 * cap. A non-positive cap keeps nothing (fail-closed; unreachable via the
 * validated config schema, which requires a positive integer).
 */
export function selectWithinCap(inputs: readonly DedupeInput[], cap: number): CapVerdict[] {
  const limit = Number.isSafeInteger(cap) && cap > 0 ? cap : 0;
  const ranked = inputs
    .map((input, index) => ({ input, index }))
    .sort((a, b) => compareDedupeCandidates(a.input, b.input) || a.index - b.index);
  const verdicts: CapVerdict[] = inputs.map(() => ({ kept: false, rank: 0 }));
  ranked.forEach(({ index }, position) => {
    const verdict = verdicts[index];
    if (verdict === undefined) return;
    verdict.kept = position < limit;
    verdict.rank = position + 1;
  });
  return verdicts;
}
