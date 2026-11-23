// Phase 6 lean advisory projection (P6-03, plan sections 4.3 and 9.2).
//
// Projects ReviewUnit[] into ConventionAdvisoryUnit[] without carrying
// explicit rules or full review context. Changed-symbol name/kind/signature
// and complete source come from re-parsing the pinned snapshot side with the
// existing language adapters; the projection never slices a partial body out
// of context text, so a withheld source is always null, never truncated.
// Snapshot access arrives through an injected reader: pipeline composition
// (P6-05) pins it to the run SHAs, tests substitute in-memory texts.

import { createHash } from "node:crypto";
import { DEFAULT_MAX_PARSE_TIME_MS } from "../config/defaults.ts";
import type { ConventionAdvisoryUnitProjector } from "../core/contracts.ts";
import { ReviewerError } from "../core/errors.ts";
import { getAdapter } from "../context/language.ts";
import type { Definition, TypeDefinition } from "../context/language.ts";
import { parseSource } from "../context/parser.ts";
import { SnapshotReader } from "../context/snapshot.ts";
import type { ChangedSymbol, DiffHunk, DiffLine, DiffResult, Language, ReviewUnit } from "../types/index.ts";
import type { ConventionAdvisoryProjectionResult, ConventionAdvisoryUnit } from "../types/conventions.ts";
import { MAX_ADVISORY_SYMBOL_SOURCE_TOKENS, MAX_ADVISORY_UNIT_TOKENS } from "./constants.ts";
import { countAdvisoryTokens } from "./token-budget.ts";

// Minimal snapshot surface the projector needs. Production passes a wrapper
// around the run-pinned SnapshotReader (see snapshotReaderTexts); tests pass
// in-memory texts. Reads never touch the working tree.
export interface AdvisorySnapshotTexts {
  readHeadText(path: string, signal?: AbortSignal | undefined): Promise<string | null>;
  readBaseText(path: string, signal?: AbortSignal | undefined): Promise<string | null>;
}

// Adapts the run-pinned SnapshotReader to the projector seam. Missing blobs,
// size caps, and Git failures degrade to null so one unreadable file cannot
// sink the projection; caller abort still propagates.
export function snapshotReaderTexts(reader: SnapshotReader): AdvisorySnapshotTexts {
  return {
    readHeadText: async (path: string, signal?: AbortSignal | undefined): Promise<string | null> => {
      try {
        return await reader.readHeadText(path, signal === undefined ? undefined : { signal });
      } catch {
        signal?.throwIfAborted();
        return null;
      }
    },
    readBaseText: async (path: string, signal?: AbortSignal | undefined): Promise<string | null> => {
      try {
        return await reader.readBaseText(path, signal === undefined ? undefined : { signal });
      } catch {
        signal?.throwIfAborted();
        return null;
      }
    },
  };
}

// Stable visit order across changed paths (mirrors the sampling rank shape:
// sha256 digest ascending, then code-unit path order). A distinct domain
// keeps advisory ordering independent of the sampling policy version.
const ADVISORY_ORDER_HASH_DOMAIN = "codebleach-phase6-advisory-order-v1";

// Unchanged context kept per side of each changed line (plan 9.2).
const MAX_PROJECTION_CONTEXT_LINES = 2;
// Per-hunk context-plus-hunk target in tokens; changed lines are sacred and
// never removed to meet it (plan 9.2).
const MAX_PROJECTED_HUNK_TOKENS = 500;
// Marker for units whose symbol the AST adapter cannot identify. The
// projection keeps the unit-scoped hunks and never falls back to full
// ReviewUnit context (plan 9.2).
const UNKNOWN_SYMBOL_NAME = "unknown";
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

interface AdvisoryOrderKey {
  digest: Buffer;
  path: string;
  startLine: number;
  name: string;
  kind: string;
  id: string;
}

function orderKey(unit: ConventionAdvisoryUnit | ReviewUnit): AdvisoryOrderKey {
  const path = "path" in unit ? unit.path : unit.file.path;
  const symbol = unit.symbol;
  const id = "unitId" in unit ? unit.unitId : unit.id;
  return {
    digest: createHash("sha256").update(`${ADVISORY_ORDER_HASH_DOMAIN}\0${path}`).digest(),
    path,
    startLine: symbol.startLine,
    name: symbol.name,
    kind: symbol.kind,
    id,
  };
}

// Shared comparator: identical order for advisory and review units.
function compareOrderKeys(a: AdvisoryOrderKey, b: AdvisoryOrderKey): number {
  const digestOrder = Buffer.compare(a.digest, b.digest);
  if (digestOrder !== 0) return digestOrder;
  const pathOrder = compareStrings(a.path, b.path);
  if (pathOrder !== 0) return pathOrder;
  if (a.startLine !== b.startLine) return a.startLine - b.startLine;
  const nameOrder = compareStrings(a.name, b.name);
  if (nameOrder !== 0) return nameOrder;
  const kindOrder = compareStrings(a.kind, b.kind);
  if (kindOrder !== 0) return kindOrder;
  return compareStrings(a.id, b.id);
}

// Deterministic order: stable path-hash visit order, then start line,
// symbol, then unit id. Idempotent: projecting or packing an already
// ordered set changes nothing.
export function orderAdvisoryUnits(units: readonly ConventionAdvisoryUnit[]): ConventionAdvisoryUnit[] {
  const scored = units.map((unit) => ({ unit, key: orderKey(unit) }));
  scored.sort((a, b) => compareOrderKeys(a.key, b.key));
  return scored.map((entry) => entry.unit);
}

function orderReviewUnits(units: readonly ReviewUnit[]): ReviewUnit[] {
  const scored = units.map((unit) => ({ unit, key: orderKey(unit) }));
  scored.sort((a, b) => compareOrderKeys(a.key, b.key));
  return scored.map((entry) => entry.unit);
}

// Control characters are rejected from prompt-adjacent paths (plan 17.3);
// locked discovery policy already excludes them from the baseline.
function isAdvisoryPathEligible(path: string): boolean {
  return path.length > 0 && !CONTROL_CHARACTER_PATTERN.test(path);
}

// Deleted symbols (changed only on the merge-base side) project from base;
// everything else projects from head. Deleted files never reach the
// projector (the context engine emits no units for them) but stay base-side
// by status as a guard.
function advisorySide(unit: ReviewUnit): "head" | "base" {
  if (unit.file.status === "deleted") return "base";
  const symbol = unit.symbol;
  if (symbol.changedLines.length === 0 && (symbol.deletedLines?.length ?? 0) > 0) return "base";
  return "head";
}

interface ParsedFileShapes {
  definitions: Definition[];
  types: TypeDefinition[];
}

// Parses one snapshot side in memory and extracts plain shape data only; the
// native tree is deleted before return. Null means no usable AST (missing
// text, unsupported parse, timeout, or adapter failure): callers degrade to
// hunks with the unknown marker rather than failing the run.
async function parseFileShapes(text: string, language: Language, filePath: string): Promise<ParsedFileShapes | null> {
  let parsed: Awaited<ReturnType<typeof parseSource>>;
  try {
    parsed = await parseSource({ source: text, language, filePath, perFileMs: DEFAULT_MAX_PARSE_TIME_MS });
  } catch {
    return null;
  }
  if (parsed.tree === null) return null;
  try {
    const adapter = getAdapter(language);
    return {
      definitions: adapter.extractDefinitions(parsed.tree, parsed.source),
      types: adapter.extractTypes(parsed.tree, parsed.source),
    };
  } catch {
    return null;
  } finally {
    parsed.tree.delete();
  }
}

// Mirrors the context engine definition lookup (src/context/engine.ts
// findDefinitionText): same name/kind/container match with the same
// start-line tiebreak. Returns complete signature and source; never slices.
function matchSymbolShapes(
  parsed: ParsedFileShapes,
  symbol: ChangedSymbol,
): { signature: string; source: string } | null {
  if (symbol.kind === "type") {
    const same = parsed.types.filter((type) => type.name === symbol.name);
    const picked =
      same.length === 1 ? same[0] : (same.find((type) => type.range.startLine === symbol.startLine) ?? same[0]);
    if (picked === undefined) return null;
    const firstLine = picked.text.split("\n")[0] ?? "";
    return { signature: firstLine, source: picked.text };
  }
  if (symbol.kind === "module") return null;
  const same = parsed.definitions.filter(
    (definition) =>
      definition.name === symbol.name &&
      definition.kind === symbol.kind &&
      (definition.container ?? undefined) === (symbol.container ?? undefined),
  );
  const picked =
    same.length === 1
      ? same[0]
      : (same.find((definition) => definition.fullRange.startLine === symbol.startLine) ?? same[0]);
  if (picked === undefined) return null;
  return { signature: picked.signatureText, source: picked.fullText };
}

function prefixDiffLine(line: DiffLine): string {
  if (line.kind === "add") return `+${line.text}`;
  if (line.kind === "del") return `-${line.text}`;
  return ` ${line.text}`;
}

function serializeTrimmedHunk(baseStartLine: number, headStartLine: number, lines: readonly string[]): string {
  let oldCount = 0;
  let newCount = 0;
  for (const line of lines) {
    if (line.startsWith("+")) newCount += 1;
    else if (line.startsWith("-")) oldCount += 1;
    else {
      oldCount += 1;
      newCount += 1;
    }
  }
  return [`@@ -${baseStartLine},${oldCount} +${headStartLine},${newCount} @@`, ...lines].join("\n");
}

// Unit-scoped hunks: every added/deleted line survives; unchanged context
// survives only within two lines of a change, then only while the hunk stays
// within the context-plus-hunk token target. Farthest-from-change context
// drops first (ties drop the later line). Deterministic and change-safe.
function trimHunkLines(lines: readonly DiffLine[], baseStartLine: number, headStartLine: number): string[] {
  const changed = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && line.kind !== "ctx") changed.add(index);
  }
  if (changed.size === 0) return [];
  const distanceToChange = (index: number): number => {
    let distance = Number.MAX_SAFE_INTEGER;
    for (const anchor of changed) {
      const gap = Math.abs(index - anchor);
      if (gap < distance) distance = gap;
    }
    return distance;
  };
  const kept: Array<{ text: string; kind: DiffLine["kind"]; distance: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const distance = distanceToChange(index);
    if (line.kind !== "ctx" || distance <= MAX_PROJECTION_CONTEXT_LINES) {
      kept.push({ text: prefixDiffLine(line), kind: line.kind, distance });
    }
  }
  const measureKept = (): number =>
    countAdvisoryTokens(
      serializeTrimmedHunk(
        baseStartLine,
        headStartLine,
        kept.map((entry) => entry.text),
      ),
    );
  while (measureKept() > MAX_PROJECTED_HUNK_TOKENS) {
    let drop = -1;
    let dropDistance = -1;
    for (let index = 0; index < kept.length; index += 1) {
      const entry = kept[index];
      if (entry === undefined || entry.kind !== "ctx") continue;
      if (entry.distance >= dropDistance) {
        dropDistance = entry.distance;
        drop = index;
      }
    }
    if (drop === -1) break;
    kept.splice(drop, 1);
  }
  return kept.map((entry) => entry.text);
}

// Prompt-bound serialization. Changed lines always survive; unchanged
// context lines duplicating complete source content are dropped by exact text
// match (the source already carries them). This is also the measured form:
// the token budget applies to exactly what the model would receive.
export function serializeConventionAdvisoryUnit(unit: ConventionAdvisoryUnit): string {
  const blocks: string[] = [
    `path: ${unit.path}`,
    `unit: ${unit.unitId}`,
    `language: ${unit.language}`,
    `symbol: ${unit.symbol.kind} ${unit.symbol.name} (${unit.symbol.side}, line ${unit.symbol.startLine})`,
    "signature:",
    unit.symbol.signature,
    "source:",
    unit.changedSymbolSource ?? "omitted",
    "diff:",
  ];
  const sourceLines = unit.changedSymbolSource === null ? null : new Set(unit.changedSymbolSource.split("\n"));
  for (const hunk of unit.diffHunks) {
    const emitted = hunk.lines.filter((line) => {
      if (!line.startsWith(" ")) return true;
      if (sourceLines === null) return true;
      return !sourceLines.has(line.slice(1));
    });
    blocks.push(serializeTrimmedHunk(hunk.baseStartLine, hunk.headStartLine, emitted));
  }
  return blocks.join("\n");
}

export interface ConventionAdvisoryUnitProjectorDeps {
  snapshot: AdvisorySnapshotTexts;
}

export class ConventionAdvisoryUnitProjectorImpl implements ConventionAdvisoryUnitProjector {
  private readonly snapshot: AdvisorySnapshotTexts;

  constructor(deps: ConventionAdvisoryUnitProjectorDeps) {
    const snapshot = (deps as ConventionAdvisoryUnitProjectorDeps | null | undefined)?.snapshot;
    if (
      snapshot === null ||
      snapshot === undefined ||
      typeof snapshot.readHeadText !== "function" ||
      typeof snapshot.readBaseText !== "function"
    ) {
      throw new ReviewerError({
        code: "INTERNAL",
        message: "ConventionAdvisoryUnitProjectorImpl requires a snapshot with readHeadText/readBaseText methods",
      });
    }
    this.snapshot = snapshot;
  }

  // The diff is accepted for interface conformance; the snapshot reader is
  // pre-pinned to the run SHAs by pipeline composition, so projection needs
  // no diff lookup beyond the units themselves.
  async project(input: {
    units: ReviewUnit[];
    diff: DiffResult;
    signal?: AbortSignal | undefined;
  }): Promise<ConventionAdvisoryProjectionResult> {
    const ordered = orderReviewUnits(input.units);
    const signal = input.signal;
    const parses = new Map<string, ParsedFileShapes | null>();
    const projected: ConventionAdvisoryUnit[] = [];
    let skippedUnits = 0;

    for (const unit of ordered) {
      signal?.throwIfAborted();
      const path = unit.file.path;
      if (!isAdvisoryPathEligible(path)) {
        skippedUnits += 1;
        continue;
      }
      const side = advisorySide(unit);
      const readPath = side === "head" ? path : (unit.file.oldPath ?? path);
      let text: string | null = null;
      try {
        text =
          side === "head"
            ? await this.snapshot.readHeadText(readPath, signal)
            : await this.snapshot.readBaseText(readPath, signal);
      } catch {
        signal?.throwIfAborted();
        text = null;
      }

      let matched: { signature: string; source: string } | null = null;
      const language = unit.file.language;
      if (text !== null && language !== null && unit.symbol.kind !== "module") {
        const cacheKey = `${side}\0${readPath}`;
        let parsed = parses.get(cacheKey);
        if (parsed === undefined) {
          signal?.throwIfAborted();
          parsed = await parseFileShapes(text, language, readPath);
          parses.set(cacheKey, parsed);
        }
        if (parsed !== null) matched = matchSymbolShapes(parsed, unit.symbol);
      }

      const symbol =
        matched === null
          ? {
              name: UNKNOWN_SYMBOL_NAME,
              kind: UNKNOWN_SYMBOL_NAME,
              signature: `unknown symbol in ${path}`,
              side,
              startLine: unit.symbol.startLine,
            }
          : {
              name: unit.symbol.name,
              kind: unit.symbol.kind,
              signature: matched.signature,
              side,
              startLine: unit.symbol.startLine,
            };
      const changedSymbolSource =
        matched !== null && countAdvisoryTokens(matched.source) <= MAX_ADVISORY_SYMBOL_SOURCE_TOKENS
          ? matched.source
          : null;

      const diffHunks = unit.diff.hunks.flatMap((hunk: DiffHunk) => {
        const lines = trimHunkLines(hunk.lines, hunk.oldStart, hunk.newStart);
        if (lines.length === 0) return [];
        return [{ baseStartLine: hunk.oldStart, headStartLine: hunk.newStart, lines }];
      });
      const hasChangedLine = diffHunks.some((hunk) =>
        hunk.lines.some((line) => line.startsWith("+") || line.startsWith("-")),
      );
      if (!hasChangedLine && changedSymbolSource === null) {
        skippedUnits += 1;
        continue;
      }

      const candidate: ConventionAdvisoryUnit = {
        unitId: unit.id,
        path,
        language: language ?? "unknown",
        symbol,
        diffHunks,
        changedSymbolSource,
      };
      if (countAdvisoryTokens(serializeConventionAdvisoryUnit(candidate)) > MAX_ADVISORY_UNIT_TOKENS) {
        skippedUnits += 1;
        continue;
      }
      projected.push(candidate);
    }
    return { units: projected, skippedUnits };
  }
}

/**
 * Run-pinned projector factory (P6-05 composition seam). The CLI binds the
 * repository directory once; every project() call pins a fresh
 * SnapshotReader to that run's diff SHAs, so projection reads the same
 * base/head snapshot as validation and never the working tree or a moving ref.
 */
export function createPinnedAdvisoryProjector(repoDir: string): ConventionAdvisoryUnitProjector {
  if (typeof repoDir !== "string" || repoDir.length === 0) {
    throw new ReviewerError({
      code: "INTERNAL",
      message: "createPinnedAdvisoryProjector requires a non-empty repoDir",
    });
  }
  return {
    project: (input) => {
      const reader = new SnapshotReader({
        repoRoot: repoDir,
        headSha: input.diff.headSha,
        mergeBase: input.diff.mergeBase,
      });
      return new ConventionAdvisoryUnitProjectorImpl({ snapshot: snapshotReaderTexts(reader) }).project(input);
    },
  };
}
