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

export type EvidenceCheckName = "evidence_bounds" | "evidence_quote";

export interface EvidenceSuccess {
  ok: true;
  checks: CheckResult[];
  /** Verified snapshot side per finding.evidence item, in order (P5-05 attribution input). */
  sides: EvidenceSide[];
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

function sliceLines(text: string, startLine: number, endLine: number): string {
  return text
    .split("\n")
    .slice(startLine - 1, endLine)
    .join("\n");
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
 * redactSource. Never re-mints fingerprints (P5-07 owns identity); never
 * trusts the model boolean (P5-05 owns introduction).
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
  const resolvedSides: EvidenceSide[] = [];

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

    const verify = async (side: EvidenceSide, readPath: string, label: string): Promise<boolean> => {
      const outcome = await matchSide(reader, side, readPath, item.startLine, item.endLine, item.quote);
      if (outcome.kind === "match") {
        resolvedSides.push(side);
        return true;
      }
      if (outcome.kind === "unavailable") {
        noteUnavailable(outcome.result);
        return true;
      }
      checks.push(
        makeCheck(
          "evidence_quote",
          "failed",
          "evidence_quote_not_found",
          `evidence[${index}] quote not found in the ${label} snapshot`,
        ),
      );
      return false;
    };

    if (evidencePath === oldPath) {
      if (!(await verify("base", evidencePath, "merge-base"))) return { ok: false, checks, inconclusive: false };
    } else if (evidencePath !== canonicalPath) {
      // Context-only file: head-side text revalidated against the snapshot.
      if (!(await verify("head", evidencePath, "head"))) return { ok: false, checks, inconclusive: false };
    } else if (inDeleted && !inHead) {
      if (!(await verify("base", oldPath ?? canonicalPath, "merge-base")))
        return { ok: false, checks, inconclusive: false };
    } else if (!inDeleted) {
      // Head-side change evidence, or unchanged lines verified at head;
      // change linkage itself is P5-05's job.
      if (!(await verify("head", canonicalPath, "head"))) return { ok: false, checks, inconclusive: false };
    } else {
      // Replacement overlap: content disambiguates, guessing does not.
      const headOutcome = await matchExact(reader, "head", canonicalPath, item);
      const baseOutcome = await matchExact(reader, "base", oldPath ?? canonicalPath, item);
      if (headOutcome.kind === "unavailable") noteUnavailable(headOutcome.result);
      if (baseOutcome.kind === "unavailable") noteUnavailable(baseOutcome.result);
      if (headOutcome.kind === "unavailable" || baseOutcome.kind === "unavailable") {
        // Keep scanning: the run-level unavailable verdict is recorded below.
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
      } else if (headOutcome.kind === baseOutcome.kind) {
        checks.push(
          makeCheck(
            "evidence_quote",
            "inconclusive",
            "evidence_side_ambiguous",
            `evidence[${index}] side is ambiguous: identical match on both snapshots`,
          ),
        );
        return { ok: false, checks, inconclusive: true };
      } else {
        resolvedSides.push(headOutcome.kind === "match" ? "head" : "base");
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
  return { ok: true, checks, sides: resolvedSides };
}

function intersects(startLine: number, endLine: number, lines: Set<number>): boolean {
  for (let line = startLine; line <= endLine; line += 1) {
    if (lines.has(line)) return true;
  }
  return false;
}

type MatchOutcome = { kind: "match" } | { kind: "mismatch" } | { kind: "unavailable"; result: SnapshotReadResult };

async function readSide(
  reader: ValidationSnapshotReader,
  side: EvidenceSide,
  path: string,
): Promise<{ text: string } | { result: SnapshotReadResult }> {
  const result = side === "head" ? await reader.readHead(path) : await reader.readBase(path);
  if (result.status !== "ok") return { result };
  return { text: result.text };
}

async function matchExact(
  reader: ValidationSnapshotReader,
  side: EvidenceSide,
  path: string,
  item: { startLine: number; endLine: number; quote: string },
): Promise<MatchOutcome> {
  const snapshot = await readSide(reader, side, path);
  if ("result" in snapshot) return { kind: "unavailable", result: snapshot.result };
  const lineCount = snapshot.text.length === 0 ? 0 : snapshot.text.split("\n").length;
  if (item.startLine > lineCount) return { kind: "mismatch" };
  const want = canonicalForm(item.quote, path);
  const exact = canonicalForm(sliceLines(snapshot.text, item.startLine, Math.min(item.endLine, lineCount)), path);
  return want === exact ? { kind: "match" } : { kind: "mismatch" };
}

/** Exact-range match first, then a bounded neighborhood fallback. */
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
  const lineCount = snapshot.text.length === 0 ? 0 : snapshot.text.split("\n").length;
  if (startLine > lineCount) return { kind: "mismatch" };
  const want = canonicalForm(quote, path);
  const clampedEnd = Math.min(endLine, lineCount);
  if (want === canonicalForm(sliceLines(snapshot.text, startLine, clampedEnd), path)) return { kind: "match" };
  const windowStart = Math.max(1, startLine - EVIDENCE_SEARCH_RADIUS);
  const windowEnd = Math.min(lineCount, endLine + EVIDENCE_SEARCH_RADIUS);
  const window = canonicalForm(sliceLines(snapshot.text, windowStart, windowEnd), path);
  return window.includes(want) ? { kind: "match" } : { kind: "mismatch" };
}
