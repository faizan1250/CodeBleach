import { ReviewerError } from "../core/errors.ts";
import type { DiffHunk } from "../types/diff.ts";
import { numberHunkLines } from "./positions.ts";

export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileChangeMetadata {
  status: FileChangeStatus;
  path: string;
  oldPath: string | null;
}

export interface ParsedFilePatch {
  status: FileChangeStatus;
  path: string;
  oldPath: string | null;
  binary: boolean;
  hunks: DiffHunk[];
}

const RENAME_STATUS_PATTERN = /^R[0-9]+$/;
const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";
const GIT_BINARY_PATCH_MARKER = "GIT binary patch";
const BINARY_FILES_PREFIX = "Binary files ";

function parseFailed(message: string): ReviewerError {
  return new ReviewerError({ code: "PARSE_FAILED", message });
}

// Bounds the excerpt embedded in diagnostics; never dumps whole lines/patches.
function excerptLine(line: string): string {
  const short = line.length > 120 ? `${line.slice(0, 120)}…` : line;
  return JSON.stringify(short);
}

// Parses `git diff --name-status -z` output. NUL-delimited fields are
// authoritative, so paths with spaces/quotes/newlines survive intact.
export function parseNameStatusZ(output: Uint8Array): FileChangeMetadata[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    throw parseFailed("name-status output is not valid UTF-8");
  }
  if (text.length === 0) return [];
  if (!text.endsWith("\0")) {
    throw parseFailed("name-status output is truncated (missing NUL terminator)");
  }
  const fields = text.split("\0");
  fields.pop();
  const records: FileChangeMetadata[] = [];
  let index = 0;
  while (index < fields.length) {
    const status = fields[index];
    if (status === "A" || status === "M" || status === "D" || status === "T") {
      const path = fields[index + 1];
      if (path === undefined || path.length === 0) {
        throw parseFailed(`name-status record ${records.length}: status "${status}" is missing its path`);
      }
      records.push({
        status: status === "A" ? "added" : status === "D" ? "deleted" : "modified",
        path,
        oldPath: null,
      });
      index += 2;
    } else if (status !== undefined && RENAME_STATUS_PATTERN.test(status)) {
      const oldPath = fields[index + 1];
      const newPath = fields[index + 2];
      if (oldPath === undefined || newPath === undefined || oldPath.length === 0 || newPath.length === 0) {
        throw parseFailed(`name-status record ${records.length}: rename "${status}" is missing its old/new path pair`);
      }
      records.push({ status: "renamed", path: newPath, oldPath });
      index += 3;
    } else {
      throw parseFailed(`name-status record ${records.length}: unsupported status ${excerptLine(status ?? "")}`);
    }
  }
  return records;
}

export interface RawFileMetadata extends FileChangeMetadata {
  oldMode: string;
  newMode: string;
  oldSha: string;
  newSha: string;
  rawStatus: string;
}

const MODE_PATTERN = /^[0-7]{6}$/;
const OID_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;

// Parses `git diff --raw -z --no-abbrev` output. NUL-delimited fields are
// authoritative; modes and full blob OIDs distinguish symlinks/gitlinks
// (120000/160000) from regular files before any patch is fetched.
export function parseRawDiffZ(output: Uint8Array): RawFileMetadata[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    throw parseFailed("raw diff output is not valid UTF-8");
  }
  if (text.length === 0) return [];
  if (!text.endsWith("\0")) {
    throw parseFailed("raw diff output is truncated (missing NUL terminator)");
  }
  const fields = text.split("\0");
  fields.pop();
  const records: RawFileMetadata[] = [];
  let index = 0;
  while (index < fields.length) {
    const info = fields[index];
    if (info === undefined || !info.startsWith(":")) {
      throw parseFailed(`raw record ${records.length}: missing ':' info ${excerptLine(info ?? "")}`);
    }
    const parts = info.slice(1).split(" ");
    if (parts.length !== 5) {
      throw parseFailed(`raw record ${records.length}: malformed info ${excerptLine(info)}`);
    }
    const [oldMode, newMode, oldSha, newSha, rawStatus] = parts as [string, string, string, string, string];
    if (oldMode === undefined || !MODE_PATTERN.test(oldMode) || newMode === undefined || !MODE_PATTERN.test(newMode)) {
      throw parseFailed(`raw record ${records.length}: invalid mode pair ${excerptLine(info)}`);
    }
    if (oldSha === undefined || !OID_PATTERN.test(oldSha) || newSha === undefined || !OID_PATTERN.test(newSha)) {
      throw parseFailed(`raw record ${records.length}: invalid OIDs ${excerptLine(info)}`);
    }
    if (rawStatus === undefined) {
      throw parseFailed(`raw record ${records.length}: missing status ${excerptLine(info)}`);
    }
    if (rawStatus === "A" || rawStatus === "M" || rawStatus === "D" || rawStatus === "T") {
      const path = fields[index + 1];
      if (path === undefined || path.length === 0) {
        throw parseFailed(`raw record ${records.length}: status "${rawStatus}" is missing its path`);
      }
      records.push({
        status: rawStatus === "A" ? "added" : rawStatus === "D" ? "deleted" : "modified",
        path,
        oldPath: null,
        oldMode,
        newMode,
        oldSha: oldSha.toLowerCase(),
        newSha: newSha.toLowerCase(),
        rawStatus,
      });
      index += 2;
    } else if (RENAME_STATUS_PATTERN.test(rawStatus)) {
      const oldPath = fields[index + 1];
      const newPath = fields[index + 2];
      if (oldPath === undefined || newPath === undefined || oldPath.length === 0 || newPath.length === 0) {
        throw parseFailed(`raw record ${records.length}: rename "${rawStatus}" is missing its old/new path pair`);
      }
      records.push({
        status: "renamed",
        path: newPath,
        oldPath,
        oldMode,
        newMode,
        oldSha: oldSha.toLowerCase(),
        newSha: newSha.toLowerCase(),
        rawStatus,
      });
      index += 3;
    } else {
      throw parseFailed(`raw record ${records.length}: unsupported status ${excerptLine(rawStatus)}`);
    }
  }
  return records;
}

export interface NumstatEntry {
  path: string;
  oldPath: string | null;
  binary: boolean;
}

// Parses `git diff --numstat -z` output for binary detection only (no patch
// needed). Renames arrive as an empty path slot followed by old/new NUL
// fields; binary is `-`/`-`. Order matches --raw under identical flags.
export function parseNumstatZ(output: Uint8Array): NumstatEntry[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    throw parseFailed("numstat output is not valid UTF-8");
  }
  if (text.length === 0) return [];
  if (!text.endsWith("\0")) {
    throw parseFailed("numstat output is truncated (missing NUL terminator)");
  }
  const fields = text.split("\0");
  fields.pop();
  const entries: NumstatEntry[] = [];
  let index = 0;
  while (index < fields.length) {
    const head = fields[index];
    if (head === undefined) {
      throw parseFailed(`numstat record ${entries.length}: truncated`);
    }
    const firstTab = head.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : head.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) {
      throw parseFailed(`numstat record ${entries.length}: malformed counts ${excerptLine(head)}`);
    }
    const added = head.slice(0, firstTab);
    const deleted = head.slice(firstTab + 1, secondTab);
    const rest = head.slice(secondTab + 1);
    if (
      added === undefined ||
      deleted === undefined ||
      !(/^[0-9]+$/.test(added) || added === "-") ||
      !(/^[0-9]+$/.test(deleted) || deleted === "-")
    ) {
      throw parseFailed(`numstat record ${entries.length}: malformed counts ${excerptLine(head)}`);
    }
    const binary = added === "-" || deleted === "-";
    if (rest.length === 0) {
      const oldPath = fields[index + 1];
      const newPath = fields[index + 2];
      if (oldPath === undefined || newPath === undefined || oldPath.length === 0 || newPath.length === 0) {
        throw parseFailed(`numstat record ${entries.length}: rename is missing its old/new path pair`);
      }
      entries.push({ path: newPath, oldPath, binary });
      index += 3;
    } else {
      entries.push({ path: rest, oldPath: null, binary });
      index += 1;
    }
  }
  return entries;
}

function isFileHeaderLine(line: string): boolean {
  return (
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("old mode ") ||
    line.startsWith("new mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("dissimilarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ")
  );
}

interface OpenHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  usedOld: number;
  usedNew: number;
  bodies: { kind: "add" | "del" | "ctx"; text: string }[];
}

function parseHunkHeader(line: string, where: string): Omit<OpenHunk, "usedOld" | "usedNew" | "bodies"> {
  const match = HUNK_HEADER_PATTERN.exec(line);
  if (match === null) {
    throw parseFailed(`${where}: malformed hunk header ${excerptLine(line)}`);
  }
  const oldStart = Number(match[1]);
  const newStart = Number(match[3]);
  const oldLines = match[2] === undefined ? 1 : Number(match[2]);
  const newLines = match[4] === undefined ? 1 : Number(match[4]);
  if (
    !Number.isSafeInteger(oldStart) ||
    !Number.isSafeInteger(newStart) ||
    !Number.isSafeInteger(oldLines) ||
    !Number.isSafeInteger(newLines)
  ) {
    throw parseFailed(`${where}: hunk header has non-numeric ranges ${excerptLine(line)}`);
  }
  return { oldStart, oldLines, newStart, newLines };
}

function formatHunk(open: Pick<OpenHunk, "oldStart" | "oldLines" | "newStart" | "newLines">): string {
  return `@@ -${open.oldStart},${open.oldLines} +${open.newStart},${open.newLines} @@`;
}

// Parses one ordered patch section (already associated with its metadata
// record by position, never by splitting the `diff --git` header on spaces).
function parseFileSection(section: readonly string[], meta: FileChangeMetadata, index: number): ParsedFilePatch {
  const where = `file section ${index} ("${meta.path}")`;
  const hunks: DiffHunk[] = [];
  let binary = false;
  let open: OpenHunk | null = null;
  let position = 0;

  const closeHunk = (): void => {
    if (open === null) return;
    if (open.usedOld !== open.oldLines || open.usedNew !== open.newLines) {
      throw parseFailed(
        `${where}: hunk ${formatHunk(open)} declares ${open.oldLines} old / ${open.newLines} new lines but consumed ${open.usedOld} / ${open.usedNew}`,
      );
    }
    const numbered = numberHunkLines(
      { oldStart: open.oldStart, newStart: open.newStart, bodies: open.bodies },
      position,
    );
    position = numbered.nextPosition;
    hunks.push({
      oldStart: open.oldStart,
      oldLines: open.oldLines,
      newStart: open.newStart,
      newLines: open.newLines,
      lines: numbered.lines,
    });
    open = null;
  };

  for (const line of section) {
    if (binary) continue;
    if (open !== null) {
      if (line === NO_NEWLINE_MARKER) continue;
      const prefix = line[0];
      if (prefix === " " || prefix === "+" || prefix === "-") {
        const kind = prefix === " " ? "ctx" : prefix === "+" ? "add" : "del";
        open.bodies.push({ kind, text: line.slice(1) });
        if (kind === "ctx") {
          open.usedOld += 1;
          open.usedNew += 1;
        } else if (kind === "add") {
          open.usedNew += 1;
        } else {
          open.usedOld += 1;
        }
        continue;
      }
      closeHunk();
    }
    if (line.startsWith("@@ ")) {
      const header = parseHunkHeader(line, where);
      open = { ...header, usedOld: 0, usedNew: 0, bodies: [] };
    } else if (line.startsWith("@@@ ")) {
      throw parseFailed(`${where}: combined merge diffs are not supported`);
    } else if (line === GIT_BINARY_PATCH_MARKER || line.startsWith(BINARY_FILES_PREFIX)) {
      // Binary payloads are opaque; never interpret them as text hunks.
      binary = true;
    } else if (isFileHeaderLine(line)) {
    } else {
      throw parseFailed(`${where}: unexpected line outside hunk ${excerptLine(line)}`);
    }
  }
  closeHunk();
  return { status: meta.status, path: meta.path, oldPath: meta.oldPath, binary, hunks };
}

// Parses unified-diff patch text. Section N belongs to metadata record N;
// a count mismatch fails with PARSE_FAILED, never a partial result.
export function parseUnifiedDiff(patch: string, metadata: FileChangeMetadata[]): ParsedFilePatch[] {
  if (patch.trim().length === 0) {
    if (metadata.length > 0) {
      throw parseFailed(`patch has no file sections but metadata lists ${metadata.length} file(s)`);
    }
    return [];
  }
  const rawLines = patch.split("\n");
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  const sections: string[][] = [];
  for (const line of rawLines) {
    if (line.startsWith("diff --git ")) {
      sections.push([]);
    } else if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      throw parseFailed("combined merge diffs are not supported");
    } else if (sections.length === 0) {
      throw parseFailed(`patch starts with a non-header line ${excerptLine(line)}`);
    } else {
      sections[sections.length - 1]?.push(line);
    }
  }
  if (sections.length !== metadata.length) {
    throw parseFailed(`patch has ${sections.length} file section(s) but metadata lists ${metadata.length}`);
  }
  return sections.map((section, index) => {
    const meta = metadata[index];
    if (meta === undefined) {
      throw parseFailed(`patch section ${index} has no metadata record`);
    }
    return parseFileSection(section, meta, index);
  });
}
