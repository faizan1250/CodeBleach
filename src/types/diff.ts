export type Language = "typescript" | "tsx" | "javascript";

export type DiffSkipReason =
  | "binary"
  | "generated"
  | "too-large"
  | "ignored"
  | "deleted"
  | "lockfile"
  | "unsupported-mode";

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  oldLine: number | null;
  newLine: number | null;
  position: number;
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface ChangedSymbol {
  name: string;
  kind: "function" | "method" | "class" | "module";
  container?: string | undefined;
  startLine: number;
  endLine: number;
  changedLines: number[];
}

export interface ChangedFile {
  path: string;
  oldPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed";
  language: Language | null;
  skipReason?: DiffSkipReason | undefined;
  hunks: DiffHunk[];
  commentableLines: number[];
  symbols: ChangedSymbol[];
}

export interface DiffResult {
  baseSha: string;
  headSha: string;
  mergeBase: string;
  files: ChangedFile[];
}
