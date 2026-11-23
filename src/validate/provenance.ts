import type { ChangedFile, DiffResult, Finding } from "../types/index.ts";
import type { CheckResult } from "../types/validation.ts";
import { SKIPPED_DETAIL, makeCheck } from "./checks.ts";
import { validateSnapshotPath } from "./snapshot.ts";

export type ProvenanceCheckName =
  | "finding_identity"
  | "finding_head_sha"
  | "origin_unit"
  | "origin_file"
  | "finding_path"
  | "finding_symbol"
  | "evidence_provenance";

export interface ProvenanceUnitView {
  readonly id: string;
  readonly file: { readonly path: string };
  readonly symbol: { readonly name: string };
  readonly context: readonly { readonly file: string }[];
}

export interface ProvenanceSuccess<TUnit extends ProvenanceUnitView = ProvenanceUnitView> {
  ok: true;
  checks: CheckResult[];
  unit: TUnit;
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

export type ProvenanceResult<TUnit extends ProvenanceUnitView = ProvenanceUnitView> =
  | ProvenanceSuccess<TUnit>
  | ProvenanceFailure;

/** Phase 4 stamps `symbol` from the originating unit, so only exact identity is valid. */
function symbolMatches(finding: Finding, unit: ProvenanceUnitView): boolean {
  return finding.symbol === unit.symbol.name;
}

/**
 * P5-02 provenance: every check is pure and performs no snapshot reads, so an
 * unproven path can never become a Git lookup. Later stages may read only
 * `canonicalPath` (head side) or the rename old path for deleted-line
 * evidence; anything else is rejected here.
 */
export function validateFindingProvenance<TUnit extends ProvenanceUnitView>(
  finding: Finding,
  diff: DiffResult,
  units: readonly TUnit[],
): ProvenanceResult<TUnit> {
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
  const skipRest = (): ProvenanceFailure => {
    for (const name of pending) {
      checks.push(makeCheck(name, "skipped", "check_skipped_prerequisite_failed", SKIPPED_DETAIL));
    }
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
    checks.push(
      makeCheck(
        "finding_identity",
        "failed",
        "finding_identity_invalid",
        "finding id and fingerprint must be non-empty Phase 4 values",
      ),
    );
    return skipRest();
  }
  next("finding_identity");
  checks.push(makeCheck("finding_identity", "passed", "finding_identity_verified"));

  if (finding.headSha !== diff.headSha) {
    next("finding_head_sha");
    checks.push(
      makeCheck(
        "finding_head_sha",
        "failed",
        "finding_head_sha_mismatch",
        "finding headSha does not exactly match the diff headSha",
      ),
    );
    return skipRest();
  }
  next("finding_head_sha");
  checks.push(makeCheck("finding_head_sha", "passed", "finding_head_sha_match"));

  const unitId = typeof finding.origin?.unitId === "string" ? finding.origin.unitId : "";
  const unit = units.find((candidate) => candidate.id === unitId);
  if (unit === undefined) {
    next("origin_unit");
    checks.push(
      makeCheck(
        "origin_unit",
        "failed",
        "origin_unit_missing",
        "finding origin unitId is not in the current review units",
      ),
    );
    return skipRest();
  }
  next("origin_unit");
  checks.push(makeCheck("origin_unit", "passed", "origin_unit_resolved"));

  const unitChecked = validateSnapshotPath(unit.file.path);
  if (!unitChecked.ok) {
    next("origin_file");
    checks.push(
      makeCheck(
        "origin_file",
        "failed",
        "origin_file_mismatch",
        `originating unit file is not a readable repo path: ${unitChecked.reason}`,
      ),
    );
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
    checks.push(
      makeCheck(
        "origin_file",
        "failed",
        "origin_file_mismatch",
        "originating unit does not map to a changed file in this diff",
      ),
    );
    return skipRest();
  }
  next("origin_file");
  checks.push(makeCheck("origin_file", "passed", "origin_file_resolved"));

  const checkedPath = validateSnapshotPath(finding.file);
  if (!checkedPath.ok) {
    next("finding_path");
    checks.push(
      makeCheck(
        "finding_path",
        "failed",
        "finding_path_invalid",
        `finding path is not a readable repo path: ${checkedPath.reason}`,
      ),
    );
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
      if (elsewhere === undefined) {
        checks.push(
          makeCheck(
            "finding_path",
            "failed",
            "finding_path_not_in_diff",
            "finding file is not a changed file in this PR",
          ),
        );
      } else {
        const oldPathChecked =
          elsewhere.status === "renamed" && elsewhere.oldPath !== null ? validateSnapshotPath(elsewhere.oldPath) : null;
        const viaRenameOldPath = oldPathChecked?.ok === true && oldPathChecked.path === canonical;
        checks.push(
          makeCheck(
            "finding_path",
            "failed",
            viaRenameOldPath ? "rename_path_mapping_invalid" : "origin_file_mismatch",
            viaRenameOldPath
              ? "finding file matches another changed file's rename old path, not the originating unit's file"
              : "finding file belongs to another changed file, not the originating unit's file",
          ),
        );
      }
      return skipRest();
    }
  }
  next("finding_path");
  checks.push(
    makeCheck(
      "finding_path",
      "passed",
      "finding_path_resolved",
      viaOldPath ? "rename old path canonicalized to the head-side path" : undefined,
    ),
  );

  if (finding.symbol !== undefined && !symbolMatches(finding, unit)) {
    next("finding_symbol");
    checks.push(
      makeCheck(
        "finding_symbol",
        "failed",
        "finding_symbol_mismatch",
        "finding symbol does not match the originating unit's symbol",
      ),
    );
    return skipRest();
  }
  next("finding_symbol");
  checks.push(
    makeCheck(
      "finding_symbol",
      "passed",
      "finding_symbol_match",
      finding.symbol === undefined ? "no symbol claimed" : undefined,
    ),
  );

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
    checks.push(makeCheck("evidence_provenance", "failed", "evidence_range_invalid", "finding has no evidence"));
    return skipRest();
  }
  for (const [index, item] of finding.evidence.entries()) {
    const itemChecked = validateSnapshotPath(item.file);
    if (!itemChecked.ok) {
      next("evidence_provenance");
      checks.push(
        makeCheck(
          "evidence_provenance",
          "failed",
          "evidence_path_not_allowed",
          `evidence[${index}] path is not a readable repo path`,
        ),
      );
      return skipRest();
    }
    if (!allowed.has(itemChecked.path)) {
      next("evidence_provenance");
      checks.push(
        makeCheck(
          "evidence_provenance",
          "failed",
          "evidence_path_not_allowed",
          `evidence[${index}] file was not supplied to the originating review unit`,
        ),
      );
      return skipRest();
    }
  }
  next("evidence_provenance");
  checks.push(makeCheck("evidence_provenance", "passed", "evidence_provenance_ok"));

  return { ok: true, checks, unit, changedFile, canonicalPath: headPath, viaOldPath };
}
