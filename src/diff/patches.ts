import { ReviewerError } from "../core/errors.ts";
import type { ChangedFile } from "../types/diff.ts";
import { gitDiffBytes, PINNED_DIFF_FLAGS } from "./git-exec.ts";
import { parseUnifiedDiff, type FileChangeMetadata, type ParsedFilePatch } from "./parse.ts";
import { detectLanguage } from "./paths.ts";

// Git file modes that the engine cannot review as text (ADR 0010):
// 120000 symlink, 160000 gitlink, either side including transitions.
// 100644<->100755 chmod stays supported.
export function isUnsupportedMode(oldMode: string, newMode: string): boolean {
  return oldMode === "120000" || newMode === "120000" || oldMode === "160000" || newMode === "160000";
}

export function skippedFile(
  status: ParsedFilePatch["status"],
  path: string,
  oldPath: string | null,
  skipReason: NonNullable<ChangedFile["skipReason"]>,
): ChangedFile {
  return {
    path,
    oldPath,
    status,
    language: detectLanguage(path),
    skipReason,
    hunks: [],
    commentableLines: [],
    symbols: [],
  };
}

export interface PatchCandidate {
  status: FileChangeMetadata["status"];
  path: string;
  oldPath: string | null;
}

// Renames contribute both sides so the patch covers the pair; deduped to one
// argv entry per path (safe pathspec, argv arrays, no shell).
export function buildPatchPathspec(candidates: readonly PatchCandidate[]): string[] {
  const pathspec: string[] = [];
  for (const candidate of candidates) {
    if (candidate.status === "renamed" && candidate.oldPath !== null) {
      pathspec.push(candidate.oldPath, candidate.path);
    } else {
      pathspec.push(candidate.path);
    }
  }
  return [...new Set(pathspec)];
}

// Patch bytes ONLY for eligible survivors. Genuine over-cap stays GIT_FAILED
// (no truncate).
export async function fetchEligiblePatches(input: {
  repoRoot: string;
  mergeBase: string;
  headSha: string;
  candidates: PatchCandidate[];
  patchMaxStdoutBytes: number;
}): Promise<ParsedFilePatch[]> {
  if (input.candidates.length === 0) return [];
  const patchBytes = await gitDiffBytes(
    input.repoRoot,
    [
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      ...PINNED_DIFF_FLAGS,
      "--unified=3",
      input.mergeBase,
      input.headSha,
      "--",
      ...buildPatchPathspec(input.candidates),
    ],
    "git diff patch",
    input.patchMaxStdoutBytes,
  );
  const eligibleMeta: FileChangeMetadata[] = input.candidates.map((candidate) => ({
    status: candidate.status,
    path: candidate.path,
    oldPath: candidate.oldPath,
  }));
  // Positional match only: section N belongs to metadata record N, and the
  // parsed path is unused downstream (assembly uses the candidate paths).
  const patches = parseUnifiedDiff(new TextDecoder("utf-8", { fatal: false }).decode(patchBytes), eligibleMeta);
  if (patches.length !== input.candidates.length) {
    throw new ReviewerError({
      code: "PARSE_FAILED",
      message: `patch has ${patches.length} file section(s) but ${input.candidates.length} eligible file(s) expected`,
    });
  }
  return patches;
}
