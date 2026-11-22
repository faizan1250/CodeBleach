import type { ChangedFile, Finding, ReviewUnit } from "../types/index.ts";
import type { CheckResult, ValidationCheckCode } from "../types/validation.ts";
import { normalizeQuoteForFingerprint } from "../review/normalize.ts";
import { redactSource } from "../utils/redact.ts";
import { SKIPPED_DETAIL, makeCheck } from "./checks.ts";
import { validateSnapshotPath } from "./snapshot.ts";
import type { SnapshotReadResult, ValidationSnapshotReader } from "./snapshot.ts";

// P5-04 bounds (ADR 0028: named constants defined and tested here).
export const EVIDENCE_MAX_ITEMS = 8;
export const EVIDENCE_MAX_QUOTE_CHARS = 2000;
export const EVIDENCE_MAX_LINE_SPAN = 50;
export const EVIDENCE_SEARCH_RADIUS = 3;

export type EvidenceSide = "head" | "base";

export interface VerifiedEvidenceLocation {
  /** Snapshot side whose text actually contains the quote. */
  side: EvidenceSide;
  /** Canonical snapshot path that was read. */
  path: string;
  /** Actual 1-based matched line range in that snapshot, never the cited range. */
  startLine: number;
  endLine: number;
}

export type EvidenceCheckName = "evidence_bounds" | "evidence_quote";

export interface EvidenceSuccess {
  ok: true;
  checks: CheckResult[];
  /** Verified snapshot location per finding.evidence item, in order (P5-05 attribution input). */
  locations: VerifiedEvidenceLocation[];
}

export interface EvidenceFailure {
  ok: false;
  checks: CheckResult[];
  /** True when the snapshot could not decide (fail-closed inconclusive, never accepted). */
  inconclusive: boolean;
}

export type EvidenceResult = EvidenceSuccess | EvidenceFailure;

export interface EvidenceInput {
  finding: Finding;
  unit: ReviewUnit;
  changedFile: ChangedFile;
  /** P5-02 head-side identity; old-path evidence still reads the merge-base side. */
  canonicalPath: string;
  reader: ValidationSnapshotReader;
}

/** Symmetric comparison form: redactSource on both sides, then quote normalization. Case-sensitive. */
function canonicalForm(text: string, path: string): string {
  return normalizeQuoteForFingerprint(redactSource(text, path));
}

/** Head-side new lines (add/ctx) and old-side deleted lines from full diff hunks. */
function lineSets(changedFile: ChangedFile): { head: Set<number>; deleted: Set<number> } {
  const head = new Set<number>();
  const deleted = new Set<number>();
  for (const hunk of changedFile.hunks) {
    for (const line of hunk.lines) {
      if (line.newLine !== null && (line.kind === "add" || line.kind === "ctx")) head.add(line.newLine);
      if (line.oldLine !== null && line.kind === "del") deleted.add(line.oldLine);
    }
  }
  return { head, deleted };
}

/** Map a non-ok snapshot read to its stable unavailable code. */
function unavailableCode(result: SnapshotReadResult): ValidationCheckCode {
  if (result.status === "unsupported") return "snapshot_unsupported_object";
  if (result.status === "binary") return "snapshot_binary";
  if (result.status === "size_limit") return "snapshot_size_limit";
  return "evidence_unavailable";
}

/**
 * P5-04 evidence verification. Bounds first (no reads), then per-item side
 * resolution from diff metadata, then exact-snapshot quote comparison via
 * redactSource. Each item resolves to a verified snapshot location (side,
 * canonical path, actual matched lines): exact cited-range first, then a
 * bounded ±radius literal-substring fallback that locates the single actual
 * range and rejects multiples as ambiguous. Never re-mints fingerprints (P5-07 owns identity);
 * never trusts the model boolean (P5-05 owns introduction).
 */
export async function validateEvidence(input: EvidenceInput): Promise<EvidenceResult> {
  const { finding, unit, changedFile, canonicalPath, reader } = input;
  const checks: CheckResult[] = [];

  if (finding.evidence.length === 0) {
    checks.push(makeCheck("evidence_bounds", "failed", "evidence_range_invalid", "finding has no evidence"));
    checks.push(makeCheck("evidence_quote", "skipped", "check_skipped_prerequisite_failed", SKIPPED_DETAIL));
    return { ok: false, checks, inconclusive: false };
  }
  if (finding.evidence.length > EVIDENCE_MAX_ITEMS) {
    checks.push(
      makeCheck(
        "evidence_bounds",
        "failed",
        "evidence_range_invalid",
        `finding has ${finding.evidence.length} evidence items, above the ${EVIDENCE_MAX_ITEMS}-item cap`,
      ),
    );
    checks.push(makeCheck("evidence_quote", "skipped", "check_skipped_prerequisite_failed", SKIPPED_DETAIL));
    return { ok: false, checks, inconclusive: false };
  }
  for (const [index, item] of finding.evidence.entries()) {
    if (
      !Number.isSafeInteger(item.startLine) ||
      !Number.isSafeInteger(item.endLine) ||
      item.startLine < 1 ||
      item.endLine < item.startLine
    ) {
      checks.push(
        makeCheck(
          "evidence_bounds",
          "failed",
          "evidence_range_invalid",
          `evidence[${index}] range is not a valid 1-based line span`,
        ),
      );
      checks.push(makeCheck("evidence_quote", "skipped", "check_skipped_prerequisite_failed", SKIPPED_DETAIL));
      return { ok: false, checks, inconclusive: false };
    }
    if (item.endLine - item.startLine + 1 > EVIDENCE_MAX_LINE_SPAN) {
      checks.push(
        makeCheck(
          "evidence_bounds",
          "failed",
          "evidence_range_invalid",
          `evidence[${index}] spans ${item.endLine - item.startLine + 1} lines, above the ${EVIDENCE_MAX_LINE_SPAN}-line cap`,
        ),
      );
      checks.push(makeCheck("evidence_quote", "skipped", "check_skipped_prerequisite_failed", SKIPPED_DETAIL));
      return { ok: false, checks, inconclusive: false };
    }
    if (item.quote.length > EVIDENCE_MAX_QUOTE_CHARS) {
      checks.push(
        makeCheck(
          "evidence_bounds",
          "failed",
          "evidence_range_invalid",
          `evidence[${index}] quote is ${item.quote.length} chars, above the ${EVIDENCE_MAX_QUOTE_CHARS}-char cap`,
        ),
      );
      checks.push(makeCheck("evidence_quote", "skipped", "check_skipped_prerequisite_failed", SKIPPED_DETAIL));
      return { ok: false, checks, inconclusive: false };
    }
    // An empty anchor never passes, even when the raw string is non-empty.
    if (normalizeQuoteForFingerprint(item.quote).length === 0) {
      checks.push(
        makeCheck(
          "evidence_bounds",
          "failed",
          "evidence_range_invalid",
          `evidence[${index}] quote is empty after normalization`,
        ),
      );
      checks.push(makeCheck("evidence_quote", "skipped", "check_skipped_prerequisite_failed", SKIPPED_DETAIL));
      return { ok: false, checks, inconclusive: false };
    }
  }
  checks.push(makeCheck("evidence_bounds", "passed", "evidence_bounds_ok"));

  // Allowed sources mirror P5-02 provenance: primary head path, rename old
  // path, and files actually supplied in the originating unit's context.
  const oldChecked =
    changedFile.status === "renamed" && changedFile.oldPath !== null ? validateSnapshotPath(changedFile.oldPath) : null;
  const oldPath = oldChecked?.ok === true ? oldChecked.path : null;
  const allowed = new Set<string>([canonicalPath]);
  if (oldPath !== null) allowed.add(oldPath);
  for (const item of unit.context) {
    const itemChecked = validateSnapshotPath(item.file);
    if (itemChecked.ok) allowed.add(itemChecked.path);
  }

  const { head, deleted } = lineSets(changedFile);
  let sawInconclusive: ValidationCheckCode | undefined;
  const resolved: VerifiedEvidenceLocation[] = [];

  const noteUnavailable = (result: SnapshotReadResult): void => {
    if (sawInconclusive === undefined) sawInconclusive = unavailableCode(result);
  };

  for (const [index, item] of finding.evidence.entries()) {
    const checked = validateSnapshotPath(item.file);
    if (!checked.ok || !allowed.has(checked.path)) {
      checks.push(
        makeCheck(
          "evidence_quote",
          "failed",
          "evidence_path_not_allowed",
          `evidence[${index}] file was not supplied to the originating review unit`,
        ),
      );
      return { ok: false, checks, inconclusive: false };
    }
    const evidencePath = checked.path;
    const inHead = evidencePath === oldPath ? false : intersects(item.startLine, item.endLine, head);
    const inDeleted = intersects(item.startLine, item.endLine, deleted);

    // Terminal evidence result for one item, or null to keep scanning.
    const verify = async (side: EvidenceSide, readPath: string, label: string): Promise<EvidenceResult | null> => {
      const outcome = await matchSide(reader, side, readPath, item.startLine, item.endLine, item.quote);
      if (outcome.kind === "match") {
        resolved.push({ side, path: readPath, startLine: outcome.startLine, endLine: outcome.endLine });
        return null;
      }
      if (outcome.kind === "unavailable") {
        noteUnavailable(outcome.result);
        return null;
      }
      if (outcome.kind === "ambiguous") {
        checks.push(
          makeCheck(
            "evidence_quote",
            "inconclusive",
            "evidence_side_ambiguous",
            `evidence[${index}] quote matches multiple locations near lines ${item.startLine}-${item.endLine}; location is ambiguous`,
          ),
        );
        return { ok: false, checks, inconclusive: true };
      }
      checks.push(
        makeCheck(
          "evidence_quote",
          "failed",
          "evidence_quote_not_found",
          `evidence[${index}] quote not found in the ${label} snapshot`,
        ),
      );
      return { ok: false, checks, inconclusive: false };
    };

    if (evidencePath === oldPath) {
      const terminal = await verify("base", evidencePath, "merge-base");
      if (terminal !== null) return terminal;
    } else if (evidencePath !== canonicalPath) {
      // Context-only file: head-side text revalidated against the snapshot.
      const terminal = await verify("head", evidencePath, "head");
      if (terminal !== null) return terminal;
    } else if (inDeleted && !inHead) {
      const terminal = await verify("base", oldPath ?? canonicalPath, "merge-base");
      if (terminal !== null) return terminal;
    } else if (!inDeleted) {
      // Head-side change evidence, or unchanged lines verified at head;
      // change linkage itself is P5-05's job.
      const terminal = await verify("head", canonicalPath, "head");
      if (terminal !== null) return terminal;
    } else {
      // Replacement overlap: content disambiguates, guessing does not. Each
      // side resolves to its own verified location; identical text on both
      // sides, or multiple locations on one side, stays inconclusive.
      const headOutcome = await matchSide(reader, "head", canonicalPath, item.startLine, item.endLine, item.quote);
      const baseOutcome = await matchSide(
        reader,
        "base",
        oldPath ?? canonicalPath,
        item.startLine,
        item.endLine,
        item.quote,
      );
      if (headOutcome.kind === "unavailable") noteUnavailable(headOutcome.result);
      if (baseOutcome.kind === "unavailable") noteUnavailable(baseOutcome.result);
      if (headOutcome.kind === "unavailable" || baseOutcome.kind === "unavailable") {
        // Keep scanning: the run-level unavailable verdict is recorded below.
      } else if (headOutcome.kind === "ambiguous" || baseOutcome.kind === "ambiguous") {
        checks.push(
          makeCheck(
            "evidence_quote",
            "inconclusive",
            "evidence_side_ambiguous",
            `evidence[${index}] quote matches multiple locations; side is ambiguous`,
          ),
        );
        return { ok: false, checks, inconclusive: true };
      } else if (headOutcome.kind !== "match" && baseOutcome.kind !== "match") {
        checks.push(
          makeCheck(
            "evidence_quote",
            "failed",
            "evidence_quote_not_found",
            `evidence[${index}] quote not found on either snapshot side`,
          ),
        );
        return { ok: false, checks, inconclusive: false };
      } else if (headOutcome.kind === "match" && baseOutcome.kind === "match") {
        checks.push(
          makeCheck(
            "evidence_quote",
            "inconclusive",
            "evidence_side_ambiguous",
            `evidence[${index}] side is ambiguous: identical match on both snapshots`,
          ),
        );
        return { ok: false, checks, inconclusive: true };
      } else if (headOutcome.kind === "match") {
        resolved.push({
          side: "head",
          path: canonicalPath,
          startLine: headOutcome.startLine,
          endLine: headOutcome.endLine,
        });
      } else if (baseOutcome.kind === "match") {
        resolved.push({
          side: "base",
          path: oldPath ?? canonicalPath,
          startLine: baseOutcome.startLine,
          endLine: baseOutcome.endLine,
        });
      } else {
        checks.push(
          makeCheck(
            "evidence_quote",
            "failed",
            "evidence_quote_not_found",
            `evidence[${index}] quote not found on either snapshot side`,
          ),
        );
        return { ok: false, checks, inconclusive: false };
      }
    }
  }

  if (sawInconclusive !== undefined) {
    checks.push(
      makeCheck(
        "evidence_quote",
        "inconclusive",
        sawInconclusive,
        "evidence snapshot unavailable; validity is undecided",
      ),
    );
    return { ok: false, checks, inconclusive: true };
  }
  checks.push(makeCheck("evidence_quote", "passed", "evidence_quote_verified"));
  return { ok: true, checks, locations: resolved };
}

function intersects(startLine: number, endLine: number, lines: Set<number>): boolean {
  for (let line = startLine; line <= endLine; line += 1) {
    if (lines.has(line)) return true;
  }
  return false;
}

type MatchOutcome =
  | { kind: "match"; startLine: number; endLine: number }
  | { kind: "mismatch" }
  | { kind: "ambiguous" }
  | { kind: "unavailable"; result: SnapshotReadResult };

async function readSide(
  reader: ValidationSnapshotReader,
  side: EvidenceSide,
  path: string,
): Promise<{ text: string } | { result: SnapshotReadResult }> {
  const result = side === "head" ? await reader.readHead(path) : await reader.readBase(path);
  if (result.status !== "ok") return { result };
  return { text: result.text };
}

/**
 * Normalized window index for literal-substring evidence matching. Each
 * non-blank window line contributes its redactSource + quote-normalized form;
 * segments join with a single space, mirroring normalizeQuoteForFingerprint
 * over the raw window text. The offset table maps every normalized character
 * back to its source line so a match reports actual snapshot coordinates.
 */
interface WindowSegment {
  line: number;
  start: number;
  end: number;
}

interface WindowIndex {
  haystack: string;
  segments: WindowSegment[];
}

function indexWindow(lines: string[], path: string, windowStart: number, windowEnd: number): WindowIndex {
  let haystack = "";
  const segments: WindowSegment[] = [];
  for (let line = windowStart; line <= windowEnd; line += 1) {
    const canonical = normalizeQuoteForFingerprint(redactSource(lines[line - 1] ?? "", path));
    if (canonical.length === 0) continue;
    if (haystack.length > 0) haystack += " ";
    const start = haystack.length;
    haystack += canonical;
    segments.push({ line, start, end: start + canonical.length });
  }
  return { haystack, segments };
}

function lineAtOffset(segments: WindowSegment[], offset: number): number | null {
  for (const segment of segments) {
    if (offset >= segment.start && offset < segment.end) return segment.line;
  }
  return null;
}

/**
 * Literal-substring fallback within the bounded window. Collects every
 * distinct matched source range: none is a mismatch, exactly one verifies at
 * its actual lines, and several are ambiguous (never an arbitrary pick; the
 * same exact range matching repeatedly collapses to one line-level
 * location). An unmappable offset fails closed as ambiguous. Case-sensitive;
 * no fuzzy/Levenshtein/semantic matching.
 */
function locateSubstring(index: WindowIndex, want: string): MatchOutcome {
  const seen = new Map<string, { startLine: number; endLine: number }>();
  let at = index.haystack.indexOf(want);
  while (at >= 0) {
    const startLine = lineAtOffset(index.segments, at);
    const endLine = lineAtOffset(index.segments, at + want.length - 1);
    if (startLine === null || endLine === null) return { kind: "ambiguous" };
    const key = `${startLine}:${endLine}`;
    if (!seen.has(key)) seen.set(key, { startLine, endLine });
    if (seen.size > 1) return { kind: "ambiguous" };
    at = index.haystack.indexOf(want, at + 1);
  }
  if (seen.size === 0) return { kind: "mismatch" };
  const only = seen.values().next();
  if (only.done) return { kind: "mismatch" };
  return { kind: "match", startLine: only.value.startLine, endLine: only.value.endLine };
}

/**
 * Exact cited-range match first, then a bounded literal-substring fallback.
 * The fallback verifies occurrence AND location: it searches only the
 * documented ±radius window for the normalized quote as a literal substring
 * (partial first/last lines, multiline spans, whitespace variation
 * included), identifies the actual range, and rejects multiple distinct
 * ranges as ambiguous. No fuzzy/Levenshtein/semantic matching: comparison is
 * the same redactSource + quote-normalized, case-sensitive form as the exact
 * path.
 */
async function matchSide(
  reader: ValidationSnapshotReader,
  side: EvidenceSide,
  path: string,
  startLine: number,
  endLine: number,
  quote: string,
): Promise<MatchOutcome> {
  const snapshot = await readSide(reader, side, path);
  if ("result" in snapshot) return { kind: "unavailable", result: snapshot.result };
  const lines = snapshot.text.length === 0 ? [] : snapshot.text.split("\n");
  const lineCount = lines.length;
  if (startLine > lineCount) return { kind: "mismatch" };
  const want = canonicalForm(quote, path);
  const clampedEnd = Math.min(endLine, lineCount);
  if (want === canonicalForm(lines.slice(startLine - 1, clampedEnd).join("\n"), path)) {
    return { kind: "match", startLine, endLine: clampedEnd };
  }
  const windowStart = Math.max(1, startLine - EVIDENCE_SEARCH_RADIUS);
  const windowEnd = Math.min(lineCount, endLine + EVIDENCE_SEARCH_RADIUS);
  return locateSubstring(indexWindow(lines, path, windowStart, windowEnd), want);
}
