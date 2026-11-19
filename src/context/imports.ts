import { DEFAULT_MAX_PARSE_TIME_MS } from "../config/defaults.ts";
import { detectLanguage } from "../diff/paths.ts";
import { getAdapter } from "./language.ts";
import type { Definition, ExportReference, ImportKind, ImportReference, TypeDefinition } from "./language.ts";
import type { RunBudget } from "./limits.ts";
import { parseSource } from "./parser.ts";
import { isRegularBlob } from "./snapshot.ts";
import type { SnapshotReader, TreeEntry } from "./snapshot.ts";

// Relative-only import/type resolution against the head commit snapshot.
// Best-effort by design: package imports, escapes, misses, and ambiguous
// re-exports yield diagnostics and never fail the run. Callees, callers,
// tests, rules, and ranking consume this output in later tickets.

export const MAX_RESOLVED_IMPORTS_PER_FILE = 16;
export const MAX_REEXPORT_DEPTH = 8;

const PROBE_EXTENSIONS = [".ts", ".tsx", ".js"] as const;
const PROBE_INDEX_FILES = ["index.ts", "index.tsx", "index.js"] as const;

export type ImportSkipReason =
  | "package-import"
  | "outside-repo"
  | "not-found"
  | "not-source"
  | "parse-cancelled"
  | "export-not-found"
  | "ambiguous-reexport"
  | "depth-exceeded"
  | "cap-reached";

export interface ImportDiagnostic {
  importerPath: string;
  specifier: string;
  reason: ImportSkipReason;
}

export interface ResolvedImport {
  importerPath: string;
  specifier: string;
  targetPath: string;
  kind: ImportKind;
  localName: string | null;
  importedName: string | null;
  definition: Definition | TypeDefinition | null;
  availableExports?: readonly string[] | undefined;
  reason: string;
}

export type TargetPick =
  | { status: "found"; path: string }
  | { status: "not-source"; path: string }
  | { status: "not-found" };

export function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  );
}

/** Resolve a relative specifier against the importer; null when it escapes the repo. */
export function resolveRelativePath(importerPath: string, specifier: string): string | null {
  if (!isRelativeSpecifier(specifier) || specifier.includes("\0")) return null;
  const slash = importerPath.lastIndexOf("/");
  const parts: string[] = slash === -1 ? [] : importerPath.slice(0, slash).split("/");
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length === 0 ? null : parts.join("/");
}

/** Deterministic probe order: exact path, sibling extensions, then index files. */
export function candidatePaths(resolvedBase: string): string[] {
  return [
    resolvedBase,
    ...PROBE_EXTENSIONS.map((extension) => `${resolvedBase}${extension}`),
    ...PROBE_INDEX_FILES.map((file) => `${resolvedBase}/${file}`),
  ];
}

/** First candidate present in the head index; non-regular blobs never resolve. */
export function pickTarget(
  candidates: readonly string[],
  headIndex: ReadonlyMap<string, TreeEntry>,
): TargetPick {
  let nonSource: string | null = null;
  for (const candidate of candidates) {
    const entry = headIndex.get(candidate);
    if (entry === undefined) continue;
    if (isRegularBlob(entry)) return { status: "found", path: candidate };
    nonSource ??= candidate;
  }
  return nonSource === null ? { status: "not-found" } : { status: "not-source", path: nonSource };
}

export function importReason(kind: ImportKind, reexported: boolean): string {
  if (kind === "named") return reexported ? "relative named re-export" : "relative named import";
  if (kind === "default") return reexported ? "relative default re-export" : "relative default import";
  if (kind === "namespace") return "relative namespace import";
  if (kind === "type-only") return "relative type-only import";
  return "relative side-effect import";
}

interface ParsedTarget {
  path: string;
  definitions: Definition[];
  types: TypeDefinition[];
  localExports: Map<string, string>;
  reExports: ExportReference[];
}

type TargetLoad =
  | { status: "parsed"; target: ParsedTarget }
  | { status: "read-failed" }
  | { status: "parse-cancelled" };

interface ResolveContext {
  reader: SnapshotReader;
  headIndex: ReadonlyMap<string, TreeEntry>;
  perFileMs: number;
  runBudget: RunBudget | undefined;
  cache: Map<string, TargetLoad>;
}

async function loadTarget(path: string, context: ResolveContext): Promise<TargetLoad> {
  const cached = context.cache.get(path);
  if (cached !== undefined) return cached;
  let loaded: TargetLoad;
  try {
    const language = detectLanguage(path);
    if (language === null) {
      loaded = { status: "read-failed" };
    } else {
      const source = await context.reader.readHeadText(path);
      const parsed = await parseSource({
        source,
        language,
        filePath: path,
        perFileMs: context.perFileMs,
        runBudget: context.runBudget,
      });
      try {
        if (parsed.tree === null) {
          loaded = { status: "parse-cancelled" };
        } else {
          const adapter = getAdapter(language);
          const localExports = new Map<string, string>();
          const reExports: ExportReference[] = [];
          for (const ref of adapter.extractExports(parsed.tree, parsed.source)) {
            if (ref.sourceSpecifier === null) {
              if (ref.exportedName !== null && ref.localName !== null) {
                localExports.set(ref.exportedName, ref.localName);
              }
            } else {
              reExports.push(ref);
            }
          }
          loaded = {
            status: "parsed",
            target: {
              path,
              definitions: adapter.extractDefinitions(parsed.tree, parsed.source),
              types: adapter.extractTypes(parsed.tree, parsed.source),
              localExports,
              reExports,
            },
          };
        }
      } finally {
        parsed.tree?.delete();
      }
    }
  } catch {
    loaded = { status: "read-failed" };
  }
  context.cache.set(path, loaded);
  return loaded;
}

function exportedDefinition(
  target: ParsedTarget,
  name: string,
  typeOnly: boolean,
): Definition | TypeDefinition | null {
  const aliased = target.localExports.get(name);
  const matches = (candidate: string, exported: boolean): boolean =>
    candidate === name && (exported || aliased === candidate);
  if (typeOnly) {
    for (const type of target.types) {
      if (matches(type.name, type.exported)) return type;
    }
    for (const definition of target.definitions) {
      if (matches(definition.name, definition.exported)) return definition;
    }
    return null;
  }
  for (const definition of target.definitions) {
    if (matches(definition.name, definition.exported)) return definition;
  }
  for (const type of target.types) {
    if (matches(type.name, type.exported)) return type;
  }
  return null;
}

/** Direct declaration for an exported name, including `export { local as name }`. */
function findDirect(target: ParsedTarget, wanted: string, typeOnly: boolean): Definition | TypeDefinition | null {
  if (wanted === "default") {
    for (const definition of target.definitions) {
      if (definition.exported && definition.exportKind === "default") return definition;
    }
    for (const type of target.types) {
      if (type.exported && type.exportKind === "default") return type;
    }
  }
  const direct = exportedDefinition(target, wanted, typeOnly);
  if (direct !== null) return direct;
  // `export { foo as default }` maps through the local export table.
  const local = target.localExports.get(wanted);
  if (local !== undefined && local !== wanted) {
    return exportedDefinition(target, local, typeOnly) ?? findUnaliased(target, local, typeOnly);
  }
  return null;
}

function findUnaliased(
  target: ParsedTarget,
  name: string,
  typeOnly: boolean,
): Definition | TypeDefinition | null {
  if (typeOnly) {
    for (const type of target.types) {
      if (type.name === name) return type;
    }
  }
  for (const definition of target.definitions) {
    if (definition.name === name) return definition;
  }
  for (const type of target.types) {
    if (type.name === name) return type;
  }
  return null;
}

type ExportResolution =
  | { status: "found"; definition: Definition | TypeDefinition; targetPath: string }
  | { status: "missing" }
  | { status: "ambiguous" }
  | { status: "depth-exceeded" };

/**
 * Resolve an exported name through relative re-export chains. `export *`
 * never forwards `default` per ES semantics; ambiguous stars are reported,
 * never guessed.
 */
async function resolveExported(
  targetPath: string,
  wanted: string,
  typeOnly: boolean,
  context: ResolveContext,
  depth: number,
  visited: Set<string>,
): Promise<ExportResolution> {
  if (depth > MAX_REEXPORT_DEPTH) return { status: "depth-exceeded" };
  const visitKey = `${targetPath}\0${wanted}`;
  if (visited.has(visitKey)) return { status: "missing" };
  visited.add(visitKey);
  const loaded = await loadTarget(targetPath, context);
  if (loaded.status !== "parsed") return { status: "missing" };
  const target = loaded.target;
  const direct = findDirect(target, wanted, typeOnly);
  if (direct !== null) return { status: "found", definition: direct, targetPath };
  const hits: Array<{ definition: Definition | TypeDefinition; targetPath: string }> = [];
  let ambiguous = false;
  let depthExceeded = false;
  for (const ref of target.reExports) {
    if (ref.sourceSpecifier === null || !isRelativeSpecifier(ref.sourceSpecifier)) continue;
    if (ref.kind === "star") {
      if (wanted === "default") continue;
    } else if (ref.kind === "named") {
      if (ref.exportedName !== wanted) continue;
    } else {
      continue;
    }
    const base = resolveRelativePath(targetPath, ref.sourceSpecifier);
    if (base === null) continue;
    const pick = pickTarget(candidatePaths(base), context.headIndex);
    if (pick.status !== "found") continue;
    const nested = await resolveExported(
      pick.path,
      ref.kind === "named" ? (ref.localName ?? wanted) : wanted,
      typeOnly,
      context,
      depth + 1,
      visited,
    );
    if (nested.status === "found") {
      const duplicate = hits.some(
        (hit) => hit.targetPath === nested.targetPath && hit.definition.name === nested.definition.name,
      );
      if (!duplicate) hits.push({ definition: nested.definition, targetPath: nested.targetPath });
    } else if (nested.status === "ambiguous") {
      ambiguous = true;
    } else if (nested.status === "depth-exceeded") {
      depthExceeded = true;
    }
  }
  if (hits.length > 1 || (hits.length === 1 && ambiguous)) return { status: "ambiguous" };
  const single = hits[0];
  if (single !== undefined && !ambiguous) return { status: "found", ...single };
  if (ambiguous) return { status: "ambiguous" };
  if (depthExceeded) return { status: "depth-exceeded" };
  return { status: "missing" };
}

function exportNamesOf(target: ParsedTarget): string[] {
  const names = new Set<string>();
  for (const definition of target.definitions) {
    if (!definition.exported) continue;
    names.add(definition.name);
    if (definition.exportKind === "default" && definition.name !== "default") names.add("default");
  }
  for (const type of target.types) {
    if (!type.exported) continue;
    names.add(type.name);
    if (type.exportKind === "default" && type.name !== "default") names.add("default");
  }
  for (const name of target.localExports.keys()) names.add(name);
  for (const ref of target.reExports) {
    if (ref.kind === "named" && ref.exportedName !== null) names.add(ref.exportedName);
  }
  return [...names].sort();
}

export interface ResolveImportsOptions {
  importerPath: string;
  reader: SnapshotReader;
  perFileMs?: number | undefined;
  runBudget?: RunBudget | undefined;
  maxResolved?: number | undefined;
}

export interface ResolveImportsResult {
  resolved: ResolvedImport[];
  diagnostics: ImportDiagnostic[];
}

function diagnostic(importerPath: string, specifier: string, reason: ImportSkipReason): ImportDiagnostic {
  return { importerPath, specifier, reason };
}

/**
 * Resolve an importer's relative imports against the head snapshot. Reads
 * head-side blobs only; the working tree is never consulted.
 */
export async function resolveImportsForFile(options: ResolveImportsOptions): Promise<ResolveImportsResult> {
  const { importerPath, reader } = options;
  const perFileMs = options.perFileMs ?? DEFAULT_MAX_PARSE_TIME_MS;
  const maxResolved = options.maxResolved ?? MAX_RESOLVED_IMPORTS_PER_FILE;
  const resolved: ResolvedImport[] = [];
  const diagnostics: ImportDiagnostic[] = [];
  const language = detectLanguage(importerPath);
  if (language === null) return { resolved, diagnostics };
  const source = await reader.readHeadText(importerPath);
  const parsed = await parseSource({
    source,
    language,
    filePath: importerPath,
    perFileMs,
    runBudget: options.runBudget,
  });
  if (parsed.tree === null) return { resolved, diagnostics };
  let imports: ImportReference[];
  try {
    imports = getAdapter(language).extractImports(parsed.tree, parsed.source);
  } finally {
    parsed.tree.delete();
  }
  const context: ResolveContext = {
    reader,
    headIndex: await reader.listHeadFiles(),
    perFileMs,
    runBudget: options.runBudget,
    cache: new Map(),
  };
  let processed = 0;
  for (const ref of imports) {
    if (processed >= maxResolved) {
      diagnostics.push(diagnostic(importerPath, ref.sourceSpecifier, "cap-reached"));
      continue;
    }
    processed += 1;
    if (!isRelativeSpecifier(ref.sourceSpecifier)) {
      diagnostics.push(diagnostic(importerPath, ref.sourceSpecifier, "package-import"));
      continue;
    }
    const base = resolveRelativePath(importerPath, ref.sourceSpecifier);
    if (base === null) {
      diagnostics.push(diagnostic(importerPath, ref.sourceSpecifier, "outside-repo"));
      continue;
    }
    const pick = pickTarget(candidatePaths(base), context.headIndex);
    if (pick.status === "not-found") {
      diagnostics.push(diagnostic(importerPath, ref.sourceSpecifier, "not-found"));
      continue;
    }
    if (pick.status === "not-source" || detectLanguage(pick.path) === null) {
      diagnostics.push(diagnostic(importerPath, ref.sourceSpecifier, "not-source"));
      continue;
    }
    const targetPath = pick.status === "found" ? pick.path : base;
    if (ref.kind === "side-effect") {
      resolved.push({
        importerPath,
        specifier: ref.sourceSpecifier,
        targetPath,
        kind: ref.kind,
        localName: null,
        importedName: null,
        definition: null,
        reason: importReason(ref.kind, false),
      });
      continue;
    }
    if (ref.kind === "namespace") {
      const loaded = await loadTarget(targetPath, context);
      if (loaded.status === "parse-cancelled") {
        diagnostics.push(diagnostic(importerPath, ref.sourceSpecifier, "parse-cancelled"));
        continue;
      }
      if (loaded.status !== "parsed") {
        diagnostics.push(diagnostic(importerPath, ref.sourceSpecifier, "not-found"));
        continue;
      }
      resolved.push({
        importerPath,
        specifier: ref.sourceSpecifier,
        targetPath,
        kind: ref.kind,
        localName: ref.localName,
        importedName: null,
        definition: null,
        availableExports: exportNamesOf(loaded.target),
        reason: importReason(ref.kind, false),
      });
      continue;
    }
    const wanted = ref.kind === "default" ? "default" : (ref.importedName ?? ref.localName);
    if (wanted === null) {
      diagnostics.push(diagnostic(importerPath, ref.sourceSpecifier, "export-not-found"));
      continue;
    }
    const outcome = await resolveExported(
      targetPath,
      wanted,
      ref.kind === "type-only",
      context,
      0,
      new Set(),
    );
    if (outcome.status === "found") {
      resolved.push({
        importerPath,
        specifier: ref.sourceSpecifier,
        targetPath: outcome.targetPath,
        kind: ref.kind,
        localName: ref.localName,
        importedName: ref.importedName,
        definition: outcome.definition,
        reason: importReason(ref.kind, outcome.targetPath !== targetPath),
      });
    } else if (outcome.status === "ambiguous") {
      diagnostics.push(diagnostic(importerPath, ref.sourceSpecifier, "ambiguous-reexport"));
    } else if (outcome.status === "depth-exceeded") {
      diagnostics.push(diagnostic(importerPath, ref.sourceSpecifier, "depth-exceeded"));
    } else {
      diagnostics.push(diagnostic(importerPath, ref.sourceSpecifier, "export-not-found"));
    }
  }
  return { resolved, diagnostics };
}
