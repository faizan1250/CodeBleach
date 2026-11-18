import type { DiffHunk, DiffLine } from "../types/diff.ts";
import type { ParsedFilePatch } from "./parse.ts";

export type HunkLineKind = DiffLine["kind"];

// One hunk body before line numbers/positions are assigned. parse.ts collects
// these while validating header counts, then delegates numbering here so the
// counter logic lives in exactly one place.
export interface UnpositionedHunk {
  oldStart: number;
  newStart: number;
  bodies: readonly { kind: HunkLineKind; text: string }[];
}

// Single source of truth for old/new counters and the 1-based per-file GitHub
// position: continues across hunks (thread startPosition through), never
// derived from source line numbers.
export function numberHunkLines(
  hunk: UnpositionedHunk,
  startPosition: number,
): { lines: DiffLine[]; nextPosition: number } {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  let position = startPosition;
  const lines: DiffLine[] = hunk.bodies.map((body) => {
    position += 1;
    if (body.kind === "ctx") {
      const line: DiffLine = { kind: "ctx", oldLine, newLine, position, text: body.text };
      oldLine += 1;
      newLine += 1;
      return line;
    }
    if (body.kind === "add") {
      const line: DiffLine = { kind: "add", oldLine: null, newLine, position, text: body.text };
      newLine += 1;
      return line;
    }
    const line: DiffLine = { kind: "del", oldLine, newLine: null, position, text: body.text };
    oldLine += 1;
    return line;
  });
  return { lines, nextPosition: position };
}

// Recomputes old/new numbers and per-file positions from hunk headers and
// line kinds. Stale incoming numbers are ignored, so the result is idempotent.
export function assignDiffPositions(files: ParsedFilePatch[]): ParsedFilePatch[] {
  return files.map((file) => {
    let position = 0;
    const hunks = file.hunks.map((hunk) => {
      const { lines, nextPosition } = numberHunkLines(
        {
          oldStart: hunk.oldStart,
          newStart: hunk.newStart,
          bodies: hunk.lines.map(({ kind, text }) => ({ kind, text })),
        },
        position,
      );
      position = nextPosition;
      return { ...hunk, lines };
    });
    return { ...file, hunks };
  });
}

// Sorted unique head-side line numbers from add/ctx lines only. Del lines and
// null numbers are excluded. Skipped/binary/deleted files carry empty hunks
// (or del-only lines), so they naturally yield []; callers keep [] for skipped
// files rather than deriving from hunks.
export function getCommentableLines(hunks: readonly DiffHunk[]): number[] {
  const seen = new Set<number>();
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if ((line.kind === "add" || line.kind === "ctx") && line.newLine !== null) {
        seen.add(line.newLine);
      }
    }
  }
  return [...seen].sort((a, b) => a - b);
}
