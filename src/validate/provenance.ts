import type { ChangedFile, DiffResult, Finding, ReviewUnit } from "../types/index.ts";
import type { CheckResult } from "../types/validation.ts";
import { validateSnapshotPath } from "./snapshot.ts";

export type ProvenanceCheckName =
  | "finding_identity"
  | "finding_head_sha"
  | "origin_unit"
  | "origin_file"
  | "finding_path"
  | "finding_symbol"
  | "evidence_provenance";

export interface ProvenanceSuccess {
  ok: true;
  checks: CheckResult[];
  unit: ReviewUnit;
  changedFile: ChangedFile;
  /** Head-side diff path; the only future read/target identity. Never a read grant. */
  canonicalPath: string;
  /** True when the finding named the rename old path and it was canonicalized. */
  viaOldPath: boolean;
}

export interface ProvenanceFailure {
  ok: false;
  checks: CheckResult[];
}

export type ProvenanceResult = ProvenanceSuccess | ProvenanceFailure;

const SKIPPED_DETAIL = "skipped: prerequisite check failed";

function fail(checks: CheckResult[], name: ProvenanceCheckName, detail: string): void {
  checks.push({ name, passed: false, detail });
}

function pass(checks: CheckResult[], name: ProvenanceCheckName, detail?: string): void {
  checks.push(detail === undefined ? { name, passed: true } : { name, passed: true, detail });
}

/** Phase 4 stamps `symbol` from the originating unit, so only exact identity is valid. */
function symbolMatches(finding: Finding, unit: ReviewUnit): boolean {
  return finding.symbol === unit.symbol.name;
}

/**
 * P5-02 provenance: every check is pure and performs no snapshot reads, so an
 * unproven path can never become a Git lookup. Later stages may read only
 * `canonicalPath` (head side) or the rename old path for deleted-line
 * evidence; anything else is rejected here.
 */
export function validateFindingProvenance(finding: Finding, diff: DiffResult, units: ReviewUnit[]): ProvenanceResult {
  const checks: CheckResult[] = [];
  const pending: ProvenanceCheckName[] = [
    "finding_identity",
    "finding_head_sha",
    "origin_unit",
    "origin_file",
    "finding_path",
    "finding_symbol",
    "evidence_provenance",
  ];
  const skipRest = (): ProvenanceResult => {
    for (const name of pending) fail(checks, name, SKIPPED_DETAIL);
    pending.length = 0;
    return { ok: false, checks };
  };
  const next = (name: ProvenanceCheckName): void => {
    pending.splice(pending.indexOf(name), 1);
  };

  if (
    typeof finding.id !== "string" ||
    finding.id.length === 0 ||
    typeof finding.fingerprint !== "string" ||
    finding.fingerprint.length === 0
  ) {
    next("finding_identity");
    fail(checks, "finding_identity", "finding id and fingerprint must be non-empty Phase 4 values");
    return skipRest();
  }
  next("finding_identity");
  pass(checks, "finding_identity");

  if (finding.headSha !== diff.headSha) {
    next("finding_head_sha");
    fail(checks, "finding_head_sha", "finding headSha does not exactly match the diff headSha");
    return skipRest();
  }
  next("finding_head_sha");
  pass(checks, "finding_head_sha");

  const unitId = typeof finding.origin?.unitId === "string" ? finding.origin.unitId : "";
  const unit = units.find((candidate) => candidate.id === unitId);
  if (unit === undefined) {
    next("origin_unit");
    fail(checks, "origin_unit", "finding origin unitId is not in the current review units");
    return skipRest();
  }
  next("origin_unit");
  pass(checks, "origin_unit");

  const unitChecked = validateSnapshotPath(unit.file.path);
  if (!unitChecked.ok) {
    next("origin_file");
    fail(checks, "origin_file", `originating unit file is not a readable repo path: ${unitChecked.reason}`);
    return skipRest();
  }
  const unitPath = unitChecked.path;
  let changedFile: ChangedFile | undefined;
  let headPath = "";
  for (const file of diff.files) {
    const fileChecked = validateSnapshotPath(file.path);
    if (fileChecked.ok && fileChecked.path === unitPath) {
      changedFile = file;
      headPath = fileChecked.path;
      break;
    }
  }
  if (changedFile === undefined) {
    next("origin_file");
    fail(checks, "origin_file", "originating unit does not map to a changed file in this diff");
    return skipRest();
  }
  next("origin_file");
  pass(checks, "origin_file");

  const checkedPath = validateSnapshotPath(finding.file);
  if (!checkedPath.ok) {
    next("finding_path");
    fail(checks, "finding_path", `finding path is not a readable repo path: ${checkedPath.reason}`);
    return skipRest();
  }
  const canonical = checkedPath.path;
  let viaOldPath = false;
  if (canonical !== headPath) {
    const oldChecked =
      changedFile.status === "renamed" && changedFile.oldPath !== null
        ? validateSnapshotPath(changedFile.oldPath)
        : null;
    if (oldChecked?.ok && oldChecked.path === canonical) {
      viaOldPath = true;
    } else {
      next("finding_path");
      const elsewhere = diff.files.find((file) => {
        const fileChecked = validateSnapshotPath(file.path);
        if (fileChecked.ok && fileChecked.path === canonical) return true;
        if (file.status !== "renamed" || file.oldPath === null) return false;
        const oldPathChecked = validateSnapshotPath(file.oldPath);
        return oldPathChecked.ok && oldPathChecked.path === canonical;
      });
      fail(
        checks,
        "finding_path",
        elsewhere === undefined
          ? "finding file is not a changed file in this PR"
          : "finding file belongs to another changed file, not the originating unit's file",
      );
      return skipRest();
    }
  }
  next("finding_path");
  pass(checks, "finding_path", viaOldPath ? "rename old path canonicalized to the head-side path" : undefined);

  if (finding.symbol !== undefined && !symbolMatches(finding, unit)) {
    next("finding_symbol");
    fail(checks, "finding_symbol", "finding symbol does not match the originating unit's symbol");
    return skipRest();
  }
  next("finding_symbol");
  pass(checks, "finding_symbol", finding.symbol === undefined ? "no symbol claimed" : undefined);

  const allowed = new Set<string>([headPath]);
  if (changedFile.status === "renamed" && changedFile.oldPath !== null) {
    const oldChecked = validateSnapshotPath(changedFile.oldPath);
    if (oldChecked.ok) allowed.add(oldChecked.path);
  }
  for (const item of unit.context) {
    const itemChecked = validateSnapshotPath(item.file);
    if (itemChecked.ok) allowed.add(itemChecked.path);
  }
  if (finding.evidence.length === 0) {
    next("evidence_provenance");
    fail(checks, "evidence_provenance", "finding has no evidence");
    return skipRest();
  }
  for (const [index, item] of finding.evidence.entries()) {
    const itemChecked = validateSnapshotPath(item.file);
    if (!itemChecked.ok) {
      next("evidence_provenance");
      fail(checks, "evidence_provenance", `evidence[${index}] path is not a readable repo path`);
      return skipRest();
    }
    if (!allowed.has(itemChecked.path)) {
      next("evidence_provenance");
      fail(checks, "evidence_provenance", `evidence[${index}] file was not supplied to the originating review unit`);
      return skipRest();
    }
  }
  next("evidence_provenance");
  pass(checks, "evidence_provenance");

  return { ok: true, checks, unit, changedFile, canonicalPath: headPath, viaOldPath };
}
