import type { ChangedFile, Finding, ReviewUnit } from "../types/index.ts";
import type { AttributionBasis, CheckResult } from "../types/validation.ts";
import { makeCheck } from "./checks.ts";
import type { EvidenceSide } from "./evidence.ts";
import type { ResolvedTarget } from "./location.ts";
import { validateSnapshotPath } from "./snapshot.ts";

// Check name is stable; P5-08 owns the code set (introduced_by_pr_verified /
// introduction_inconclusive). Attribution never rejects: unprovable linkage
// fails closed, never accepted.
export type AttributionCheckName = "introduced_by_pr";

export interface AttributionSuccess {
  ok: true;
  checks: CheckResult[];
  introducedByPr: true;
  basis: AttributionBasis;
}

export interface AttributionFailure {
  ok: false;
  checks: CheckResult[];
  introducedByPr: false;
  /** Attribution never rejects: unprovable linkage fails closed, never accepted. */
  inconclusive: true;
}

export type AttributionResult = AttributionSuccess | AttributionFailure;

export interface AttributionInput {
  finding: Finding;
  unit: ReviewUnit;
  changedFile: ChangedFile;
  /** P5-02 head-side identity; old-path evidence still attributes the merge-base side. */
  canonicalPath: string;
  /** P5-03 head-side anchor; required for an accepted deleted-line finding. */
  target: ResolvedTarget;
  /** P5-04 verified snapshot side per finding.evidence item, in order. */
  sides: EvidenceSide[];
}

function intersectRange(startLine: number, endLine: number, lines: Set<number>): number[] {
  const overlap: number[] = [];
  for (let line = startLine; line <= endLine; line += 1) {
    if (lines.has(line)) overlap.push(line);
  }
  return overlap;
}

/**
 * P5-05 attribution: code-owned `introducedByPr` from verified evidence
 * intersecting PR-changed lines. The model boolean is never read. Added basis
 * needs a head-side item in the primary file spanning an added line inside
 * the originating symbol's changedLines; deleted basis needs an old-side
 * item spanning a del/deletedLines line plus the location anchor. Anything
 * else (context-only, other files, out-of-scope hunks) is inconclusive.
 */
export function validateAttribution(input: AttributionInput): AttributionResult {
  const { finding, unit, changedFile, canonicalPath, target, sides } = input;
  const checks: CheckResult[] = [];
  const inconclusive = (detail: string): AttributionFailure => {
    checks.push(makeCheck("introduced_by_pr", "inconclusive", "introduction_inconclusive", detail));
    return { ok: false, checks, introducedByPr: false, inconclusive: true };
  };

  if (sides.length !== finding.evidence.length) {
    return inconclusive("verified evidence sides do not match the cited evidence items");
  }

  const added = new Set<number>();
  const deleted = new Set<number>();
  for (const hunk of changedFile.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add" && line.newLine !== null) added.add(line.newLine);
      if (line.kind === "del" && line.oldLine !== null) deleted.add(line.oldLine);
    }
  }
  const symbolChanged = new Set(unit.symbol.changedLines);
  const symbolDeleted = new Set(unit.symbol.deletedLines ?? []);
  const oldChecked =
    changedFile.status === "renamed" && changedFile.oldPath !== null ? validateSnapshotPath(changedFile.oldPath) : null;
  const oldPath = oldChecked?.ok === true ? oldChecked.path : null;

  for (const [index, item] of finding.evidence.entries()) {
    if (sides[index] !== "head") continue;
    const checked = validateSnapshotPath(item.file);
    if (!checked.ok || checked.path !== canonicalPath) continue;
    const overlap = intersectRange(item.startLine, item.endLine, added).filter((line) => symbolChanged.has(line));
    if (overlap.length > 0) {
      const basis: AttributionBasis = {
        kind: "added-lines",
        evidenceIndex: index,
        file: canonicalPath,
        lines: overlap,
      };
      checks.push(
        makeCheck(
          "introduced_by_pr",
          "passed",
          "introduced_by_pr_verified",
          `added-line evidence ${canonicalPath}:${item.startLine}-${item.endLine} intersects added lines ${overlap.join(",")}`,
        ),
      );
      return { ok: true, checks, introducedByPr: true, basis };
    }
  }

  for (const [index, item] of finding.evidence.entries()) {
    if (sides[index] !== "base") continue;
    const checked = validateSnapshotPath(item.file);
    if (!checked.ok || (checked.path !== canonicalPath && checked.path !== oldPath)) continue;
    const removed = new Set([...deleted, ...symbolDeleted]);
    const overlap = intersectRange(item.startLine, item.endLine, removed);
    if (overlap.length > 0) {
      const basis: AttributionBasis = {
        kind: "deleted-lines",
        evidenceIndex: index,
        file: checked.path,
        lines: overlap,
      };
      checks.push(
        makeCheck(
          "introduced_by_pr",
          "passed",
          "introduced_by_pr_verified",
          `deleted-line evidence ${checked.path}:${item.startLine}-${item.endLine} intersects deleted lines ${overlap.join(",")}, anchored at ${target.file}:${target.line}`,
        ),
      );
      return { ok: true, checks, introducedByPr: true, basis };
    }
  }

  return inconclusive("no verified evidence intersects PR added/deleted lines in the originating symbol scope");
}
