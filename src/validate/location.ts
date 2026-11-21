import type { ChangedFile, Finding, ReviewUnit } from "../types/index.ts";
import type { CheckResult } from "../types/validation.ts";
import type { ValidationSnapshotReader } from "./snapshot.ts";

// ADR 0028 default: relocation stays within the same symbol and this radius.
export const LOCATION_RELOCATION_RADIUS = 5;

export type ResolvedTargetKind = "added" | "context" | "relocated" | "deletion-anchor";

export interface ResolvedTarget {
  /** Canonical head-side path; the only future publishable identity. */
  file: string;
  /** 1-based head-side commentable line. */
  line: number;
  side: "RIGHT";
  kind: ResolvedTargetKind;
  /** Original finding line when the target differs (relocated, deletion-anchor). */
  sourceLine?: number | undefined;
}

export type LocationCheckName = "location_line" | "head_comment_target";

export interface LocationSuccess {
  ok: true;
  checks: CheckResult[];
  target: ResolvedTarget;
}

export interface LocationFailure {
  ok: false;
  checks: CheckResult[];
  /** True when the snapshot could not decide (fail-closed inconclusive, never accepted). */
  inconclusive: boolean;
}

export type LocationResult = LocationSuccess | LocationFailure;

export interface LocationInput {
  finding: Finding;
  unit: ReviewUnit;
  changedFile: ChangedFile;
  /** P5-02 head-side identity; the only read/target path, never the raw model path. */
  canonicalPath: string;
  reader: ValidationSnapshotReader;
}

const SKIPPED_DETAIL = "skipped: prerequisite check failed";

function countHeadLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

/**
 * P5-03 location: resolve a deterministic head-side comment target without
 * treating commentability as proof of introduction (that is P5-05). Order is
 * head identity first (added, then context), then an explicit deleted-line
 * anchor, then same-symbol relocation. Reads only `canonicalPath` at head.
 */
export async function validateLocation(input: LocationInput): Promise<LocationResult> {
  const { finding, unit, changedFile, canonicalPath, reader } = input;
  const checks: CheckResult[] = [];

  if (!Number.isSafeInteger(finding.line) || finding.line < 1) {
    checks.push({ name: "location_line", passed: false, detail: "finding line must be a positive integer" });
    checks.push({ name: "head_comment_target", passed: false, detail: SKIPPED_DETAIL });
    return { ok: false, checks, inconclusive: false };
  }
  checks.push({ name: "location_line", passed: true });

  if (changedFile.status === "deleted") {
    checks.push({
      name: "head_comment_target",
      passed: false,
      detail: "no head-side comment target: file is deleted in this PR",
    });
    return { ok: false, checks, inconclusive: false };
  }

  const snapshot = await reader.readHead(canonicalPath);
  if (snapshot.status !== "ok") {
    checks.push({
      name: "head_comment_target",
      passed: false,
      detail: `head snapshot unavailable (${snapshot.status}); location is undecided`,
    });
    return { ok: false, checks, inconclusive: true };
  }
  const lineCount = countHeadLines(snapshot.text);
  const inHead = finding.line <= lineCount;

  const added = new Set<number>();
  const right = new Set<number>();
  for (const hunk of changedFile.hunks) {
    for (const line of hunk.lines) {
      if (line.newLine !== null && (line.kind === "add" || line.kind === "ctx")) {
        right.add(line.newLine);
        if (line.kind === "add") added.add(line.newLine);
      }
    }
  }
  const commentable = new Set(changedFile.commentableLines);
  const commentableInHead = (line: number): boolean => line >= 1 && line <= lineCount && commentable.has(line);

  if (inHead && added.has(finding.line) && commentable.has(finding.line)) {
    checks.push({ name: "head_comment_target", passed: true, detail: `added target ${canonicalPath}:${finding.line}` });
    return { ok: true, checks, target: { file: canonicalPath, line: finding.line, side: "RIGHT", kind: "added" } };
  }
  if (inHead && right.has(finding.line) && commentable.has(finding.line)) {
    checks.push({
      name: "head_comment_target",
      passed: true,
      detail: `context target ${canonicalPath}:${finding.line}`,
    });
    return {
      ok: true,
      checks,
      target: { file: canonicalPath, line: finding.line, side: "RIGHT", kind: "context" },
    };
  }

  // An explicit deleted-line reference outranks fuzzy nearby-line matching.
  const deletedLines = unit.symbol.deletedLines ?? [];
  if (deletedLines.includes(finding.line)) {
    const anchor = unit.symbol.anchorLine;
    if (anchor !== undefined && Number.isSafeInteger(anchor) && commentableInHead(anchor)) {
      checks.push({
        name: "head_comment_target",
        passed: true,
        detail: `deletion-anchor ${canonicalPath}:${anchor} for deleted line ${finding.line}`,
      });
      return {
        ok: true,
        checks,
        target: { file: canonicalPath, line: anchor, side: "RIGHT", kind: "deletion-anchor", sourceLine: finding.line },
      };
    }
    checks.push({
      name: "head_comment_target",
      passed: false,
      detail: "deleted line has no valid head-side deletion anchor",
    });
    return { ok: false, checks, inconclusive: false };
  }

  const candidates = unit.symbol.changedLines.filter(
    (candidate) =>
      Number.isSafeInteger(candidate) &&
      added.has(candidate) &&
      commentableInHead(candidate) &&
      Math.abs(candidate - finding.line) <= LOCATION_RELOCATION_RADIUS,
  );
  candidates.sort((a, b) => Math.abs(a - finding.line) - Math.abs(b - finding.line) || a - b);
  const relocated = candidates[0];
  if (relocated !== undefined) {
    checks.push({
      name: "head_comment_target",
      passed: true,
      detail: `relocated target ${canonicalPath}:${relocated} from line ${finding.line}`,
    });
    return {
      ok: true,
      checks,
      target: { file: canonicalPath, line: relocated, side: "RIGHT", kind: "relocated", sourceLine: finding.line },
    };
  }

  checks.push({
    name: "head_comment_target",
    passed: false,
    detail: "no commentable head-side target in the same symbol within the relocation radius",
  });
  return { ok: false, checks, inconclusive: false };
}
