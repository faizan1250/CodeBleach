import type { ChangedFile, Finding } from "../types/index.ts";
import type { AttributionBasis, CheckResult } from "../types/validation.ts";
import { makeCheck } from "./checks.ts";
import type { VerifiedEvidenceLocation } from "./evidence.ts";
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

export interface AttributionUnitView {
  readonly symbol: {
    readonly changedLines: readonly number[];
    readonly deletedLines?: readonly number[] | undefined;
  };
}

export interface AttributionInput {
  finding: Finding;
  unit: AttributionUnitView;
  changedFile: ChangedFile;
  /** P5-02 head-side identity; old-path evidence still attributes the merge-base side. */
  canonicalPath: string;
  /** P5-03 head-side anchor; required for an accepted deleted-line finding. */
  target: ResolvedTarget;
  /** P5-04 verified snapshot location per finding.evidence item, in order. */
  locations: VerifiedEvidenceLocation[];
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
 * intersecting PR-changed lines. The model boolean is never read, and the
 * model's cited ranges are never intersected: only the evidence stage's
 * verified snapshot locations count. Added basis needs a head-side verified
 * location in the primary file spanning an added line inside the originating
 * symbol's changedLines; deleted basis needs a verified old-side location
 * spanning a deleted line inside the originating symbol's deletedLines plus
 * the location anchor. Anything else
 * (context-only, other files, out-of-scope hunks, or deleted lines owned by
 * another symbol) is inconclusive.
 */
export function validateAttribution(input: AttributionInput): AttributionResult {
  const { finding, unit, changedFile, canonicalPath, target, locations } = input;
  const checks: CheckResult[] = [];
  const inconclusive = (detail: string): AttributionFailure => {
    checks.push(makeCheck("introduced_by_pr", "inconclusive", "introduction_inconclusive", detail));
    return { ok: false, checks, introducedByPr: false, inconclusive: true };
  };

  if (locations.length !== finding.evidence.length) {
    return inconclusive("verified evidence locations do not match the cited evidence items");
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

  for (let index = 0; index < finding.evidence.length; index += 1) {
    const location = locations[index];
    if (location === undefined || location.side !== "head") continue;
    if (location.path !== canonicalPath) continue;
    const overlap = intersectRange(location.startLine, location.endLine, added).filter((line) =>
      symbolChanged.has(line),
    );
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
          `added-line evidence ${canonicalPath}:${location.startLine}-${location.endLine} intersects added lines ${overlap.join(",")}`,
        ),
      );
      return { ok: true, checks, introducedByPr: true, basis };
    }
  }

  for (let index = 0; index < finding.evidence.length; index += 1) {
    const location = locations[index];
    if (location === undefined || location.side !== "base") continue;
    if (location.path !== canonicalPath && location.path !== oldPath) continue;
    // Symbol scope is load-bearing: only the originating symbol's deletedLines
    // confer a basis. The file-level deleted set is a cross-check, never a
    // fallback — a verified range over another symbol's deletions stays
    // inconclusive for this unit.
    const overlap = intersectRange(location.startLine, location.endLine, symbolDeleted).filter((line) =>
      deleted.has(line),
    );
    if (overlap.length > 0) {
      const basis: AttributionBasis = {
        kind: "deleted-lines",
        evidenceIndex: index,
        file: location.path,
        lines: overlap,
      };
      checks.push(
        makeCheck(
          "introduced_by_pr",
          "passed",
          "introduced_by_pr_verified",
          `deleted-line evidence ${location.path}:${location.startLine}-${location.endLine} intersects deleted lines ${overlap.join(",")}, anchored at ${target.file}:${target.line}`,
        ),
      );
      return { ok: true, checks, introducedByPr: true, basis };
    }
  }

  return inconclusive("no verified evidence intersects PR added/deleted lines in the originating symbol scope");
}
