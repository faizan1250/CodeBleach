import { DEFAULT_MAX_PARSE_TIME_MS } from "../config/defaults.ts";
import { ReviewerError } from "../core/errors.ts";
import type { RunBudget } from "./limits.ts";
import { getAdapter } from "./language.ts";
import type { Definition, DefinitionKind } from "./language.ts";
import { parseSource } from "./parser.ts";
import type { ErrorRange } from "./parser.ts";
import { SnapshotReader } from "./snapshot.ts";
import type { ChangedFile, ChangedSymbol, DiffHunk, SymbolKind } from "../types/diff.ts";

export const MODULE_SYMBOL_NAME = "<module>";

export interface MapFileSymbolsInput {
  file: ChangedFile;
  headDefinitions: readonly Definition[];
  headLineCount: number;
  baseDefinitions: readonly Definition[];
  headErrorRanges?: readonly ErrorRange[] | undefined;
  baseErrorRanges?: readonly ErrorRange[] | undefined;
  headCancelled?: boolean | undefined;
}

interface Owner {
  key: string;
  name: string;
  kind: SymbolKind;
  container: string | undefined;
  startLine: number;
  endLine: number;
  occurrence: number;
}

interface Deletion {
  oldLine: number;
  hunkIndex: number;
  position: number;
}

function definitionKindToSymbol(kind: DefinitionKind): SymbolKind {
  return kind;
}

function ownerKey(kind: SymbolKind, container: string | undefined, name: string, occurrence: number): string {
  return `${kind}:${container ?? ""}:${name}#${occurrence}`;
}

function baseKey(kind: SymbolKind, container: string | undefined, name: string): string {
  return `${kind}:${container ?? ""}:${name}`;
}

function spanOf(definition: Definition): number {
  return definition.fullRange.endLine - definition.fullRange.startLine;
}

function inRanges(line: number, ranges: readonly ErrorRange[] | undefined): boolean {
  if (ranges === undefined) return false;
  for (const range of ranges) {
    if (line >= range.startLine && line <= range.endLine) return true;
  }
  return false;
}

/** Smallest/most-specific definition containing the line; null when top-level or error-covered. */
function ownerForLine(
  definitions: readonly Definition[],
  line: number,
  errorRanges: readonly ErrorRange[] | undefined,
): Definition | null {
  if (inRanges(line, errorRanges)) return null;
  let best: Definition | null = null;
  for (const definition of definitions) {
    if (line < definition.fullRange.startLine || line > definition.fullRange.endLine) continue;
    if (best === null) {
      best = definition;
      continue;
    }
    const span = spanOf(definition);
    const bestSpan = spanOf(best);
    if (span < bestSpan || (span === bestSpan && definition.fullRange.startLine > best.fullRange.startLine)) {
      best = definition;
    }
  }
  return best;
}

function occurrenceIndex(definition: Definition, group: readonly Definition[]): number {
  const index = group.indexOf(definition);
  return index === -1 ? 0 : index;
}

function groupByBaseKey(definitions: readonly Definition[]): Map<string, Definition[]> {
  const groups = new Map<string, Definition[]>();
  for (const definition of definitions) {
    const key = baseKey(definitionKindToSymbol(definition.kind), definition.container, definition.name);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [definition]);
    else group.push(definition);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.fullRange.startLine - b.fullRange.startLine || (a.identityKey < b.identityKey ? -1 : 1));
  }
  return groups;
}

function toOwner(definition: Definition, occurrence: number): Owner {
  const kind = definitionKindToSymbol(definition.kind);
  return {
    key: ownerKey(kind, definition.container, definition.name, occurrence),
    name: definition.name,
    kind,
    container: definition.container,
    startLine: definition.fullRange.startLine,
    endLine: definition.fullRange.endLine,
    occurrence,
  };
}

function moduleOwner(headLineCount: number, file: ChangedFile): Owner {
  let endLine = headLineCount;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.newLine !== null && line.newLine > endLine) endLine = line.newLine;
    }
  }
  for (const commentable of file.commentableLines) {
    if (commentable > endLine) endLine = commentable;
  }
  if (endLine < 1) endLine = 1;
  return { key: "module", name: MODULE_SYMBOL_NAME, kind: "module", container: undefined, startLine: 1, endLine, occurrence: 0 };
}

interface AnchorCandidate {
  newLine: number;
  position: number;
  hunkIndex: number;
  distance: number;
  following: boolean;
  inSymbol: boolean;
}

/**
 * Head-side commentable context line anchoring a deletion-only symbol.
 * Candidates come from hunks holding the symbol's deletions; the nearest
 * context line inside the matched head symbol wins, then the nearest
 * same-hunk line. Ties prefer the following line, then the lower newLine.
 */
export function selectAnchorLine(
  file: ChangedFile,
  deletions: readonly Deletion[],
  symbolStartLine: number,
  symbolEndLine: number,
): number | undefined {
  if (deletions.length === 0) return undefined;
  const commentable = new Set(file.commentableLines);
  const byHunk = new Map<number, Deletion[]>();
  for (const deletion of deletions) {
    const group = byHunk.get(deletion.hunkIndex);
    if (group === undefined) byHunk.set(deletion.hunkIndex, [deletion]);
    else group.push(deletion);
  }
  const candidates: AnchorCandidate[] = [];
  file.hunks.forEach((hunk: DiffHunk, hunkIndex: number) => {
    const dels = byHunk.get(hunkIndex);
    if (dels === undefined || dels.length === 0) return;
    for (const line of hunk.lines) {
      if (line.kind !== "ctx" || line.newLine === null) continue;
      if (!commentable.has(line.newLine)) continue;
      let distance = Number.MAX_SAFE_INTEGER;
      let following = false;
      for (const del of dels) {
        const gap = Math.abs(line.position - del.position);
        if (gap < distance || (gap === distance && line.position > del.position && !following)) {
          distance = gap;
          following = line.position > del.position;
        }
      }
      candidates.push({
        newLine: line.newLine,
        position: line.position,
        hunkIndex,
        distance,
        following,
        inSymbol: line.newLine >= symbolStartLine && line.newLine <= symbolEndLine,
      });
    }
  });
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => {
    if (a.inSymbol !== b.inSymbol) return a.inSymbol ? -1 : 1;
    if (a.distance !== b.distance) return a.distance - b.distance;
    if (a.following !== b.following) return a.following ? -1 : 1;
    if (a.newLine !== b.newLine) return a.newLine - b.newLine;
    return a.hunkIndex - b.hunkIndex;
  });
  return candidates[0]?.newLine;
}

function sortedUnique(lines: readonly number[]): number[] {
  return [...new Set(lines)].sort((a, b) => a - b);
}

/**
 * Map a file's added/deleted diff lines to AST-derived ChangedSymbols.
 * Added lines use head-side coordinates; deleted lines use merge-base
 * coordinates and match head symbols by kind + name + container identity.
 * Pure helpers only — Git reads live in mapChangedSymbolsForFile.
 */
export function mapFileSymbols(input: MapFileSymbolsInput): ChangedSymbol[] {
  const { file } = input;
  const headDefinitions = [...input.headDefinitions].sort(
    (a, b) => a.fullRange.startLine - b.fullRange.startLine || (a.identityKey < b.identityKey ? -1 : 1),
  );
  const baseDefinitions = [...input.baseDefinitions].sort(
    (a, b) => a.fullRange.startLine - b.fullRange.startLine || (a.identityKey < b.identityKey ? -1 : 1),
  );
  const headGroups = groupByBaseKey(headDefinitions);
  const owners = new Map<string, Owner>();
  const addedByOwner = new Map<string, number[]>();
  const deletedByOwner = new Map<string, number[]>();
  const deletionsByOwner = new Map<string, Deletion[]>();

  const getModule = (): Owner => {
    let module = owners.get("module");
    if (module === undefined) {
      module = moduleOwner(input.headLineCount, file);
      owners.set("module", module);
    }
    return module;
  };

  const ownerForHead = (newLine: number): Owner => {
    if (input.headCancelled === true) return getModule();
    const definition = ownerForLine(headDefinitions, newLine, input.headErrorRanges);
    if (definition === null) return getModule();
    const key = baseKey(definitionKindToSymbol(definition.kind), definition.container, definition.name);
    const group = headGroups.get(key);
    const occurrence = group === undefined ? 0 : occurrenceIndex(definition, group);
    const owner = toOwner(definition, occurrence);
    const existing = owners.get(owner.key);
    if (existing !== undefined) return existing;
    owners.set(owner.key, owner);
    return owner;
  };

  const ownerForDeletion = (oldLine: number): Owner => {
    const old = ownerForLine(baseDefinitions, oldLine, input.baseErrorRanges);
    if (old === null) return getModule();
    const kind = definitionKindToSymbol(old.kind);
    const key = baseKey(kind, old.container, old.name);
    const headGroup = headGroups.get(key);
    if (headGroup === undefined || headGroup.length === 0) return getModule();
    const baseGroup = groupByBaseKey(baseDefinitions).get(key);
    const occurrence = baseGroup === undefined ? 0 : occurrenceIndex(old, baseGroup);
    const clamped = Math.min(occurrence, headGroup.length - 1);
    const matched = headGroup[clamped];
    if (matched === undefined) return getModule();
    const owner = toOwner(matched, clamped);
    const existing = owners.get(owner.key);
    if (existing !== undefined) return existing;
    owners.set(owner.key, owner);
    return owner;
  };

  file.hunks.forEach((hunk, hunkIndex) => {
    for (const line of hunk.lines) {
      if (line.kind === "add" && line.newLine !== null) {
        const owner = ownerForHead(line.newLine);
        const added = addedByOwner.get(owner.key);
        if (added === undefined) addedByOwner.set(owner.key, [line.newLine]);
        else added.push(line.newLine);
      } else if (line.kind === "del" && line.oldLine !== null) {
        const owner = ownerForDeletion(line.oldLine);
        const deleted = deletedByOwner.get(owner.key);
        if (deleted === undefined) deletedByOwner.set(owner.key, [line.oldLine]);
        else deleted.push(line.oldLine);
        const record: Deletion = { oldLine: line.oldLine, hunkIndex, position: line.position };
        const entries = deletionsByOwner.get(owner.key);
        if (entries === undefined) deletionsByOwner.set(owner.key, [record]);
        else entries.push(record);
      }
    }
  });

  const symbols: ChangedSymbol[] = [];
  for (const [key, owner] of owners) {
    const changedLines = sortedUnique(addedByOwner.get(key) ?? []);
    const deletedLines = sortedUnique(deletedByOwner.get(key) ?? []);
    if (changedLines.length === 0 && deletedLines.length === 0) continue;
    const symbol: ChangedSymbol = {
      name: owner.name,
      kind: owner.kind,
      startLine: owner.startLine,
      endLine: owner.endLine,
      changedLines,
    };
    if (owner.container !== undefined) symbol.container = owner.container;
    if (deletedLines.length > 0) symbol.deletedLines = deletedLines;
    if (changedLines.length === 0 && deletedLines.length > 0) {
      const anchor = selectAnchorLine(file, deletionsByOwner.get(key) ?? [], owner.startLine, owner.endLine);
      if (anchor !== undefined) symbol.anchorLine = anchor;
    }
    symbols.push(symbol);
  }

  symbols.sort((a, b) => {
    const aModule = a.kind === "module" ? 1 : 0;
    const bModule = b.kind === "module" ? 1 : 0;
    if (aModule !== bModule) return aModule - bModule;
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.endLine - b.endLine;
  });
  return symbols;
}

export interface MapFileSymbolsOptions {
  file: ChangedFile;
  reader: SnapshotReader;
  perFileMs?: number | undefined;
  runBudget?: RunBudget | undefined;
}

function gitFailed(message: string, cause?: unknown): ReviewerError {
  return cause === undefined
    ? new ReviewerError({ code: "GIT_FAILED", message })
    : new ReviewerError({ code: "GIT_FAILED", message, cause });
}

function countLines(source: string): number {
  if (source === "") return 0;
  let newlines = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") newlines += 1;
  }
  return source.endsWith("\n") ? newlines : newlines + 1;
}

/**
 * Map one ChangedFile through exact commit snapshots: head source from
 * headSha (path), old source from mergeBase (oldPath). Skipped files and
 * hunk-less files yield no symbols. Working tree is never read.
 */
export async function mapChangedSymbolsForFile(options: MapFileSymbolsOptions): Promise<ChangedSymbol[]> {
  const { file, reader } = options;
  if (file.skipReason !== undefined) return [];
  let hasChanges = false;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if ((line.kind === "add" || line.kind === "del")) {
        hasChanges = true;
        break;
      }
    }
    if (hasChanges) break;
  }
  if (!hasChanges) return [];

  const perFileMs = options.perFileMs ?? DEFAULT_MAX_PARSE_TIME_MS;
  if (file.language === null) {
    let headLineCount = 0;
    try {
      const headText = await reader.readHeadText(file.path);
      headLineCount = countLines(headText);
    } catch {
      headLineCount = 0;
    }
    return mapFileSymbols({ file, headDefinitions: [], headLineCount, baseDefinitions: [] });
  }

  const adapter = getAdapter(file.language);
  const language = adapter.language;

  let headText: string | null = null;
  if (file.status !== "deleted") {
    try {
      headText = await reader.readHeadText(file.path);
    } catch (error) {
      throw error instanceof ReviewerError ? error : gitFailed(`cannot read head snapshot for ${file.path}`, error);
    }
  }
  let baseText: string | null = null;
  if (file.status !== "added") {
    try {
      baseText = await reader.readBaseText(file.oldPath ?? file.path);
    } catch (error) {
      throw error instanceof ReviewerError ? error : gitFailed(`cannot read base snapshot for ${file.oldPath ?? file.path}`, error);
    }
  }

  let headDefinitions: Definition[] = [];
  let headErrorRanges: readonly ErrorRange[] = [];
  let headLineCount = headText === null ? 0 : countLines(headText);
  let headCancelled = false;
  if (headText !== null) {
    const parsed = await parseSource({ source: headText, language, filePath: file.path, perFileMs, runBudget: options.runBudget });
    try {
      if (parsed.tree === null) {
        headCancelled = true;
        headLineCount = parsed.lineCount;
      } else {
        headDefinitions = adapter.extractDefinitions(parsed.tree, parsed.source);
        headErrorRanges = parsed.errorRanges;
        headLineCount = parsed.lineCount;
      }
    } finally {
      parsed.tree?.delete();
    }
  }

  let baseDefinitions: Definition[] = [];
  let baseErrorRanges: readonly ErrorRange[] = [];
  if (baseText !== null) {
    const parsed = await parseSource({ source: baseText, language, filePath: file.oldPath ?? file.path, perFileMs, runBudget: options.runBudget });
    try {
      if (parsed.tree !== null) {
        baseDefinitions = adapter.extractDefinitions(parsed.tree, parsed.source);
        baseErrorRanges = parsed.errorRanges;
      }
    } finally {
      parsed.tree?.delete();
    }
  }

  return mapFileSymbols({
    file,
    headDefinitions,
    headLineCount,
    baseDefinitions,
    headErrorRanges,
    baseErrorRanges,
    ...(headCancelled ? { headCancelled: true as const } : {}),
  });
}
