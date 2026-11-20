import type { Node } from "web-tree-sitter";
import { DEFAULT_MAX_PARSE_TIME_MS } from "../config/defaults.ts";
import { detectLanguage } from "../diff/paths.ts";
import type { ChangedSymbol, SymbolKind } from "../types/diff.ts";
import {
  candidatePaths,
  importReason,
  isRelativeSpecifier,
  MAX_REEXPORT_DEPTH,
  pickTarget,
  resolveImportsForFile,
  resolveRelativePath,
} from "./imports.ts";
import type { ResolvedImport } from "./imports.ts";
import type { CallReference, Definition, ExportReference, SymbolRange, TypeDefinition } from "./language.ts";
import type { RunBudget } from "./limits.ts";
import { ParseCache, callsInRange } from "./parse-cache.ts";
import type { SnapshotReader, TreeEntry } from "./snapshot.ts";
import { isGitOutputLimit, isGitTimeout } from "./snapshot.ts";

// Static best-effort callee discovery for one changed symbol. Reads head-side
// blobs only; never executes code or guesses across unrelated modules. Local
// declarations win over imports; member calls resolve only through `this`,
// a same-file class, or an unambiguous namespace import.

export const MAX_CALLEES_PER_SYMBOL = 16;

export type CalleeKind = "function" | "method" | "class" | "type";

export interface CalleeTarget {
  name: string;
  kind: CalleeKind;
  container?: string | undefined;
  path: string;
  startLine: number;
  endLine: number;
  signatureText: string;
  text: string;
  recursive: boolean;
  reason: string;
  callRange: SymbolRange;
}

export type CalleeSkipReason = "unresolved" | "ambiguous" | "dynamic" | "parse-cancelled" | "cap-reached";

export interface CalleeDiagnostic {
  filePath: string;
  symbol: string;
  callee: string;
  reason: CalleeSkipReason;
}

export interface ResolveCalleesOptions {
  filePath: string;
  symbol: ChangedSymbol;
  reader: SnapshotReader;
  perFileMs?: number | undefined;
  runBudget?: RunBudget | undefined;
  maxCallees?: number | undefined;
  parseCache?: ParseCache | undefined;
}

export interface ResolveCalleesResult {
  callees: CalleeTarget[];
  diagnostics: CalleeDiagnostic[];
}

export interface LocalScope {
  name: string;
  kind: SymbolKind;
  container?: string | undefined;
}

export type LocalCallMatch =
  | { status: "found"; definitions: Definition[] }
  | { status: "defer" }
  | { status: "unresolved" }
  | { status: "ambiguous" }
  | { status: "dynamic" };

function scopeClassOf(scope: LocalScope): string | undefined {
  if (scope.kind === "method") return scope.container;
  if (scope.kind === "class") return scope.name;
  return undefined;
}

/**
 * Match a call against same-file definitions. Unknown roots defer to the
 * import phase (a namespace import may own them); only unmappable receivers
 * (`this` outside a class, computed callees) settle here.
 */
export function matchLocalCall(
  call: CallReference,
  definitions: readonly Definition[],
  scope: LocalScope,
): LocalCallMatch {
  if (call.root === null) return { status: "dynamic" };
  const root = call.root;
  if (root === "this" || root === "super") {
    if (call.member === null) return { status: "dynamic" };
    const owner = scopeClassOf(scope);
    if (owner === undefined) return { status: "ambiguous" };
    const methods = definitions.filter(
      (definition) => definition.kind === "method" && definition.name === call.member && definition.container === owner,
    );
    return methods.length > 0 ? { status: "found", definitions: methods } : { status: "unresolved" };
  }
  if (call.member === null) {
    // Bare identifiers never invoke class methods (require this/super or
    // ClassName.method); keep method resolution in the branches above.
    const direct = definitions.filter((definition) => definition.kind !== "method" && definition.name === root);
    return direct.length > 0 ? { status: "found", definitions: direct } : { status: "defer" };
  }
  const statics = definitions.filter(
    (definition) => definition.kind === "method" && definition.name === call.member && definition.container === root,
  );
  return statics.length > 0 ? { status: "found", definitions: statics } : { status: "defer" };
}

/** Locate the AST node that produced a definition via its exact index span. */
export function findDefinitionNode(root: Node, definition: Definition): Node | null {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    if (node.startIndex === definition.fullRange.startIndex && node.endIndex === definition.fullRange.endIndex) {
      return node;
    }
    for (let index = node.namedChildCount - 1; index >= 0; index -= 1) {
      const child = node.namedChild(index);
      if (child !== null) stack.push(child);
    }
  }
  return null;
}

export function targetIdentity(path: string, definition: Definition | TypeDefinition): string {
  if ("identityKey" in definition) return `${path}\0${definition.identityKey}`;
  return `${path}\0type:${definition.name}:${definition.range.startLine}`;
}

/** Dedupe by target identity (overloads share one entry), keeping the earliest call site. */
export function dedupeCalleeTargets(targets: readonly CalleeTarget[]): CalleeTarget[] {
  const seen = new Set<string>();
  const out: CalleeTarget[] = [];
  for (const target of targets) {
    const key = `${target.path}\0${target.kind}\0${target.container ?? ""}\0${target.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
}

/** Deterministic order: same-file targets first, then path, line, name. */
export function sortCalleeTargets(targets: readonly CalleeTarget[], importerPath: string): CalleeTarget[] {
  return [...targets].sort((a, b) => {
    const aLocal = a.path === importerPath ? 0 : 1;
    const bLocal = b.path === importerPath ? 0 : 1;
    if (aLocal !== bLocal) return aLocal - bLocal;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return 0;
  });
}

export interface LoadedModule {
  path: string;
  definitions: Definition[];
  types: TypeDefinition[];
  localExports: Map<string, string>;
  reExports: ExportReference[];
}

export type ModuleLoader = (path: string) => Promise<LoadedModule | "cancelled" | null>;

export interface MemberResolutionContext {
  load: ModuleLoader;
  probe: (resolvedBase: string) => Promise<string | null>;
}

export type MemberResolution =
  | { status: "found"; definition: Definition | TypeDefinition; targetPath: string; reexported: boolean }
  | { status: "missing" }
  | { status: "ambiguous" }
  | { status: "cancelled" }
  | { status: "depth-exceeded" };

function directInModule(module: LoadedModule, wanted: string): { definition: Definition | TypeDefinition } | null {
  if (wanted === "default") {
    for (const definition of module.definitions) {
      if (definition.exported && definition.exportKind === "default") return { definition };
    }
    for (const type of module.types) {
      if (type.exported && type.exportKind === "default") return { definition: type };
    }
    const local = module.localExports.get("default");
    if (local !== undefined && local !== "default") return aliasedInModule(module, local);
    return null;
  }
  const aliased = module.localExports.get(wanted);
  const matches = (name: string, exported: boolean): boolean => name === wanted && (exported || aliased === name);
  for (const definition of module.definitions) {
    if (matches(definition.name, definition.exported)) return { definition };
  }
  for (const type of module.types) {
    if (matches(type.name, type.exported)) return { definition: type };
  }
  if (aliased !== undefined && aliased !== wanted) return aliasedInModule(module, aliased);
  return null;
}

function aliasedInModule(module: LoadedModule, name: string): { definition: Definition | TypeDefinition } | null {
  for (const definition of module.definitions) {
    if (definition.name === name) return { definition };
  }
  for (const type of module.types) {
    if (type.name === name) return { definition: type };
  }
  return null;
}

/**
 * Resolve a namespace member through direct exports and relative re-export
 * chains. Star branches resolve only when unambiguous; `default` never
 * forwards through `export *`, matching the import-phase semantics.
 */
export async function resolveExportedMember(
  targetPath: string,
  member: string,
  context: MemberResolutionContext,
  depth = 0,
  visited: Set<string> = new Set(),
): Promise<MemberResolution> {
  if (depth > MAX_REEXPORT_DEPTH) return { status: "depth-exceeded" };
  const visitKey = `${targetPath}\0${member}`;
  if (visited.has(visitKey)) return { status: "missing" };
  visited.add(visitKey);
  const loaded = await context.load(targetPath);
  if (loaded === "cancelled") return { status: "cancelled" };
  if (loaded === null) return { status: "missing" };
  const direct = directInModule(loaded, member);
  if (direct !== null) {
    return { status: "found", definition: direct.definition, targetPath, reexported: depth > 0 };
  }
  const hits: Array<{ definition: Definition | TypeDefinition; targetPath: string }> = [];
  let ambiguous = false;
  let cancelled = false;
  let depthExceeded = false;
  for (const ref of loaded.reExports) {
    if (ref.sourceSpecifier === null || !isRelativeSpecifier(ref.sourceSpecifier)) continue;
    let nested: string;
    if (ref.kind === "star") {
      if (member === "default") continue;
      nested = member;
    } else if (ref.kind === "named") {
      if (ref.exportedName !== member) continue;
      nested = ref.localName ?? member;
    } else {
      continue;
    }
    const base = resolveRelativePath(targetPath, ref.sourceSpecifier);
    if (base === null) continue;
    const next = await context.probe(base);
    if (next === null) continue;
    const outcome = await resolveExportedMember(next, nested, context, depth + 1, visited);
    if (outcome.status === "found") {
      const duplicate = hits.some(
        (hit) =>
          hit.targetPath === outcome.targetPath &&
          targetIdentity(hit.targetPath, hit.definition) === targetIdentity(outcome.targetPath, outcome.definition),
      );
      if (!duplicate) hits.push({ definition: outcome.definition, targetPath: outcome.targetPath });
    } else if (outcome.status === "ambiguous") {
      ambiguous = true;
    } else if (outcome.status === "cancelled") {
      cancelled = true;
    } else if (outcome.status === "depth-exceeded") {
      depthExceeded = true;
    }
  }
  if (hits.length > 1 || (hits.length === 1 && ambiguous)) return { status: "ambiguous" };
  const single = hits[0];
  if (single !== undefined && !ambiguous) {
    return { status: "found", definition: single.definition, targetPath: single.targetPath, reexported: true };
  }
  if (ambiguous) return { status: "ambiguous" };
  if (cancelled) return { status: "cancelled" };
  if (depthExceeded) return { status: "depth-exceeded" };
  return { status: "missing" };
}

function toTarget(
  definition: Definition | TypeDefinition,
  targetPath: string,
  reason: string,
  call: CallReference,
  scope: LocalScope,
  importerPath: string,
): CalleeTarget {
  if ("identityKey" in definition) {
    const recursive =
      targetPath === importerPath &&
      definition.name === scope.name &&
      definition.kind === scope.kind &&
      (definition.container ?? undefined) === (scope.container ?? undefined);
    return {
      name: definition.name,
      kind: definition.kind,
      ...(definition.container === undefined ? {} : { container: definition.container }),
      path: targetPath,
      startLine: definition.fullRange.startLine,
      endLine: definition.fullRange.endLine,
      signatureText: definition.signatureText,
      text: definition.fullText,
      recursive,
      reason,
      callRange: call.range,
    };
  }
  const recursive =
    targetPath === importerPath &&
    definition.name === scope.name &&
    scope.kind === "type" &&
    scope.container === undefined;
  return {
    name: definition.name,
    kind: "type",
    path: targetPath,
    startLine: definition.range.startLine,
    endLine: definition.range.endLine,
    signatureText: definition.text,
    text: definition.text,
    recursive,
    reason,
    callRange: call.range,
  };
}

function findSymbolDefinition(symbol: ChangedSymbol, definitions: readonly Definition[]): Definition | null {
  const same = definitions.filter(
    (definition) =>
      definition.name === symbol.name &&
      definition.kind === symbol.kind &&
      (definition.container ?? undefined) === (symbol.container ?? undefined),
  );
  if (same.length === 0) return null;
  if (same.length === 1) return same[0] ?? null;
  return same.find((definition) => definition.fullRange.startLine === symbol.startLine) ?? same[0] ?? null;
}

/**
 * Discover the functions and methods called by one changed symbol. Returns
 * resolved targets with head-side definition text; best-effort misses become
 * diagnostics rather than failures.
 */
export async function resolveCalleesForSymbol(options: ResolveCalleesOptions): Promise<ResolveCalleesResult> {
  const { filePath, symbol, reader } = options;
  const perFileMs = options.perFileMs ?? DEFAULT_MAX_PARSE_TIME_MS;
  const maxCallees = options.maxCallees ?? MAX_CALLEES_PER_SYMBOL;
  const language = detectLanguage(filePath);
  if (language === null) return { callees: [], diagnostics: [] };
  const source = await reader.readHeadText(filePath);
  const parseCache = options.parseCache ?? new ParseCache();
  const cached = await parseCache.getOrParse({
    commit: reader.headSha,
    path: filePath,
    source,
    language,
    perFileMs,
    runBudget: options.runBudget,
  });
  if (cached.status === "cancelled") return { callees: [], diagnostics: [] };
  const snapshot = cached.snapshot;
  {
    const localDefinitions = snapshot.definitions;
    const scope: LocalScope =
      symbol.kind === "module"
        ? { name: "<module>", kind: "module" }
        : {
            name: symbol.name,
            kind: symbol.kind,
            ...(symbol.container === undefined ? {} : { container: symbol.container }),
          };
    let calls: CallReference[];
    if (symbol.kind === "module") {
      calls = snapshot.calls.filter((call) => call.containing === null);
    } else {
      const definition = findSymbolDefinition(symbol, localDefinitions);
      if (definition === null) return { callees: [], diagnostics: [] };
      // Range containment over root calls equals the old node-scoped walk:
      // tree-sitter child spans nest inside their parent, and the previous
      // node-miss fallback already used this exact filter.
      calls = callsInRange(snapshot.calls, definition.fullRange.startIndex, definition.fullRange.endIndex);
    }

    const targets: CalleeTarget[] = [];
    const diagnostics: CalleeDiagnostic[] = [];
    const deferred: CallReference[] = [];
    for (const call of calls) {
      const match = matchLocalCall(call, localDefinitions, scope);
      if (match.status === "found") {
        for (const definition of match.definitions) {
          const reason =
            definition.kind === "method"
              ? call.root === "this" || call.root === "super"
                ? "local method call"
                : "local static call"
              : "local direct call";
          targets.push(toTarget(definition, filePath, reason, call, scope, filePath));
        }
      } else if (match.status === "dynamic") {
        diagnostics.push({ filePath, symbol: symbol.name, callee: call.callee, reason: "dynamic" });
      } else if (match.status === "ambiguous") {
        diagnostics.push({ filePath, symbol: symbol.name, callee: call.callee, reason: "ambiguous" });
      } else if (match.status === "unresolved") {
        diagnostics.push({ filePath, symbol: symbol.name, callee: call.callee, reason: "unresolved" });
      } else {
        deferred.push(call);
      }
    }
    if (deferred.length > 0) {
      await resolveDeferred(deferred, {
        filePath,
        symbol,
        reader,
        perFileMs,
        runBudget: options.runBudget,
        parseCache,
        scope,
        targets,
        diagnostics,
      });
    }

    const ranked = sortCalleeTargets(dedupeCalleeTargets(targets), filePath);
    const kept = ranked.slice(0, Math.max(0, maxCallees));
    for (const dropped of ranked.slice(Math.max(0, maxCallees))) {
      diagnostics.push({ filePath, symbol: symbol.name, callee: dropped.name, reason: "cap-reached" });
    }
    return { callees: kept, diagnostics };
  }
}

interface DeferredContext {
  filePath: string;
  symbol: ChangedSymbol;
  reader: SnapshotReader;
  perFileMs: number;
  runBudget: RunBudget | undefined;
  parseCache: ParseCache;
  scope: LocalScope;
  targets: CalleeTarget[];
  diagnostics: CalleeDiagnostic[];
}

async function resolveDeferred(calls: readonly CallReference[], context: DeferredContext): Promise<void> {
  const { filePath, symbol, reader } = context;
  const { resolved, diagnostics: importDiagnostics } = await resolveImportsForFile({
    importerPath: filePath,
    reader,
    perFileMs: context.perFileMs,
    runBudget: context.runBudget,
    parseCache: context.parseCache,
  });
  // Import-level misses surface as callee-level unresolved/ambiguous below;
  // the import diagnostics themselves stay with the P3-05 contract.
  void importDiagnostics;
  const byLocal = new Map<string, ResolvedImport[]>();
  for (const entry of resolved) {
    if (entry.localName === null) continue;
    const group = byLocal.get(entry.localName);
    if (group === undefined) byLocal.set(entry.localName, [entry]);
    else group.push(entry);
  }
  let headIndex: ReadonlyMap<string, TreeEntry> | null = null;
  const moduleCache = new Map<string, LoadedModule | "cancelled" | null>();
  const probe = async (base: string): Promise<string | null> => {
    if (headIndex === null) headIndex = await reader.listHeadFiles();
    const pick = pickTarget(candidatePaths(base), headIndex);
    if (pick.status !== "found") return null;
    return detectLanguage(pick.path) === null ? null : pick.path;
  };
  const load: ModuleLoader = async (path) => {
    const hit = moduleCache.get(path);
    if (hit !== undefined) return hit;
    const loaded = await loadModule(path, context);
    moduleCache.set(path, loaded);
    return loaded;
  };
  for (const call of calls) {
    const root = call.root;
    if (root === null) {
      context.diagnostics.push({ filePath, symbol: symbol.name, callee: call.callee, reason: "dynamic" });
      continue;
    }
    const candidates = byLocal.get(root) ?? [];
    if (candidates.length !== 1) {
      context.diagnostics.push({
        filePath,
        symbol: symbol.name,
        callee: call.callee,
        reason: call.member === null ? "unresolved" : "ambiguous",
      });
      continue;
    }
    const entry = candidates[0];
    if (entry === undefined) {
      context.diagnostics.push({ filePath, symbol: symbol.name, callee: call.callee, reason: "unresolved" });
      continue;
    }
    const namespaceLike = entry.kind === "namespace" || (entry.kind === "type-only" && entry.importedName === null);
    if (namespaceLike) {
      if (call.member === null) {
        context.diagnostics.push({ filePath, symbol: symbol.name, callee: call.callee, reason: "unresolved" });
        continue;
      }
      const outcome = await resolveExportedMember(entry.targetPath, call.member, { load, probe });
      if (outcome.status === "found") {
        context.targets.push(
          toTarget(
            outcome.definition,
            outcome.targetPath,
            importReason("namespace", outcome.reexported),
            call,
            context.scope,
            filePath,
          ),
        );
      } else if (outcome.status === "ambiguous") {
        context.diagnostics.push({ filePath, symbol: symbol.name, callee: call.callee, reason: "ambiguous" });
      } else if (outcome.status === "cancelled") {
        context.diagnostics.push({ filePath, symbol: symbol.name, callee: call.callee, reason: "parse-cancelled" });
      } else {
        context.diagnostics.push({ filePath, symbol: symbol.name, callee: call.callee, reason: "unresolved" });
      }
      continue;
    }
    if (call.member !== null) {
      context.diagnostics.push({ filePath, symbol: symbol.name, callee: call.callee, reason: "ambiguous" });
      continue;
    }
    if (entry.definition === null) {
      context.diagnostics.push({ filePath, symbol: symbol.name, callee: call.callee, reason: "unresolved" });
      continue;
    }
    context.targets.push(toTarget(entry.definition, entry.targetPath, entry.reason, call, context.scope, filePath));
  }
}

async function loadModule(path: string, context: DeferredContext): Promise<LoadedModule | "cancelled" | null> {
  const language = detectLanguage(path);
  if (language === null) return null;
  let source: string;
  try {
    source = await context.reader.readHeadText(path);
  } catch (error) {
    if (isGitTimeout(error) || isGitOutputLimit(error)) throw error;
    return null;
  }
  const cached = await context.parseCache.getOrParse({
    commit: context.reader.headSha,
    path,
    source,
    language,
    perFileMs: context.perFileMs,
    runBudget: context.runBudget,
  });
  if (cached.status === "cancelled") return "cancelled";
  const localExports = new Map<string, string>();
  const reExports: ExportReference[] = [];
  for (const ref of cached.snapshot.exports) {
    if (ref.sourceSpecifier === null) {
      if (ref.exportedName !== null && ref.localName !== null) localExports.set(ref.exportedName, ref.localName);
    } else {
      reExports.push(ref);
    }
  }
  return {
    path,
    definitions: cached.snapshot.definitions,
    types: cached.snapshot.types,
    localExports,
    reExports,
  };
}
