import { DEFAULT_MAX_PARSE_TIME_MS } from "../config/defaults.ts";
import { detectLanguage } from "../diff/paths.ts";
import type { ChangedSymbol } from "../types/diff.ts";
import { candidatePaths, isRelativeSpecifier, pickTarget, resolveRelativePath } from "./imports.ts";
import { matchLocalCall, resolveExportedMember, targetIdentity } from "./calls.ts";
import type { LocalScope, MemberResolutionContext } from "./calls.ts";
import type {
  CallReference,
  Definition,
  ExportReference,
  ImportReference,
  SymbolRange,
  TypeDefinition,
} from "./language.ts";
import type { RunBudget } from "./limits.ts";
import { ParseCache } from "./parse-cache.ts";
import type { ParsedFileSnapshot } from "./parse-cache.ts";
import type { SnapshotReader, TreeEntry } from "./snapshot.ts";
import { isGitOutputLimit, isGitTimeout } from "./snapshot.ts";

// Static best-effort caller discovery for one changed symbol. Reads head-side
// blobs only; grep over the head tree finds name candidates while a bounded
// scan of supported files finds default-import and barrel callers that never
// mention the original name. Every candidate call is AST-verified through the
// resolved import/export binding map; strings, comments, declarations, and
// unrelated same-name identifiers never count.

export const MAX_CALLERS_PER_SYMBOL = 16;
export const MAX_CALLER_GREP_MATCHES = 200;
export const MAX_CALLER_SCAN_FILES = 200;
export const MAX_CALLER_ALIASES = 32;
export const CALLER_SNIPPET_CONTEXT_LINES = 10;

export type CallerKind = Definition["kind"] | "module";

export interface CallerSite {
  path: string;
  caller: string | null;
  callerKind: CallerKind;
  callerContainer?: string | undefined;
  callerStartLine: number;
  callerEndLine: number;
  callerText: string;
  callRange: SymbolRange;
  reason: string;
}

export type CallerSkipReason = "unresolved" | "ambiguous" | "parse-cancelled" | "cap-reached" | "depth-exceeded";

export interface CallerDiagnostic {
  filePath: string;
  symbol: string;
  candidate: string;
  reason: CallerSkipReason;
}

export interface ResolveCallersOptions {
  filePath: string;
  symbol: ChangedSymbol;
  reader: SnapshotReader;
  perFileMs?: number | undefined;
  runBudget?: RunBudget | undefined;
  maxCallers?: number | undefined;
  maxGrepMatches?: number | undefined;
  maxScanFiles?: number | undefined;
  parseCache?: ParseCache | undefined;
}

export interface ResolveCallersResult {
  callers: CallerSite[];
  diagnostics: CallerDiagnostic[];
}

export interface CallerModule {
  path: string;
  definitions: Definition[];
  types: TypeDefinition[];
  imports: ImportReference[];
  localExports: Map<string, string>;
  reExports: ExportReference[];
}

export interface CallerBinding {
  kind: "named" | "default" | "namespace";
  modulePath: string;
  viaBarrel: boolean;
  alias: boolean;
}

export interface BarrelBinding {
  barrelPath: string;
  publicName: string;
}

interface CallerContext {
  reader: SnapshotReader;
  headIndex: ReadonlyMap<string, TreeEntry>;
  perFileMs: number;
  runBudget: RunBudget | undefined;
  parseCache: ParseCache;
  modules: Map<string, CallerModule | "cancelled" | null>;
}

/** Changed symbol located in its head-side module; types have no callers. */
export function findTargetDeclaration(
  definitions: readonly Definition[],
  types: readonly TypeDefinition[],
  symbol: ChangedSymbol,
): Definition | TypeDefinition | null {
  if (symbol.kind === "module") return null;
  if (symbol.kind === "type") {
    const sameTypes = types.filter((type) => type.name === symbol.name);
    if (sameTypes.length > 0) {
      if (sameTypes.length === 1) return sameTypes[0] ?? null;
      return sameTypes.find((type) => type.range.startLine === symbol.startLine) ?? sameTypes[0] ?? null;
    }
    const sameDefs = definitions.filter(
      (definition) => definition.kind === "type" && definition.name === symbol.name,
    );
    if (sameDefs.length === 0) return null;
    if (sameDefs.length === 1) return sameDefs[0] ?? null;
    return sameDefs.find((definition) => definition.fullRange.startLine === symbol.startLine) ?? sameDefs[0] ?? null;
  }
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

/** Public names under which the declaration is importable from its own module. */
export function targetPublicNames(
  localExports: ReadonlyMap<string, string>,
  declaration: Definition | TypeDefinition,
): string[] {
  const names = new Set<string>();
  if (declaration.exported) {
    names.add(declaration.exportKind === "default" ? "default" : declaration.name);
  }
  for (const [exportedName, local] of localExports) {
    if (local === declaration.name) names.add(exportedName);
  }
  return [...names].sort();
}

export function callerReason(binding: CallerBinding | null): string {
  if (binding === null) return "same-file direct call";
  if (binding.kind === "namespace") return binding.viaBarrel ? "barrel namespace call" : "namespace import call";
  if (binding.kind === "default") return "default import call";
  if (binding.viaBarrel) return binding.alias ? "barrel re-export alias call" : "barrel re-export call";
  return binding.alias ? "named import alias call" : "named import call";
}

/** Smallest definition containing the call range; null at module scope. */
export function enclosingCaller(
  definitions: readonly Definition[],
  call: CallReference,
): Definition | null {
  let best: Definition | null = null;
  for (const definition of definitions) {
    if (call.range.startIndex < definition.fullRange.startIndex || call.range.endIndex > definition.fullRange.endIndex) {
      continue;
    }
    if (best === null || definition.fullRange.endIndex - definition.fullRange.startIndex < best.fullRange.endIndex - best.fullRange.startIndex) {
      best = definition;
    }
  }
  return best;
}

/** One entry per (file, enclosing caller); the first occurrence wins. */
export function dedupeCallerSites(sites: readonly CallerSite[]): CallerSite[] {
  const seen = new Set<string>();
  const out: CallerSite[] = [];
  for (const site of sites) {
    const key = `${site.path}\0${site.callerKind}\0${site.callerContainer ?? ""}\0${site.caller ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(site);
  }
  return out;
}

/** Deterministic order: path, caller start line, caller name, call position. */
export function sortCallerSites(sites: readonly CallerSite[]): CallerSite[] {
  return [...sites].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.callerStartLine !== b.callerStartLine) return a.callerStartLine - b.callerStartLine;
    const aCaller = a.caller ?? "";
    const bCaller = b.caller ?? "";
    if (aCaller !== bCaller) return aCaller < bCaller ? -1 : 1;
    if (a.callRange.startIndex !== b.callRange.startIndex) return a.callRange.startIndex - b.callRange.startIndex;
    return a.callRange.endIndex - b.callRange.endIndex;
  });
}

export function snippetAround(
  source: string,
  startLine: number,
  endLine: number,
  contextLines: number = CALLER_SNIPPET_CONTEXT_LINES,
): { text: string; startLine: number; endLine: number } {
  const lines = source.split("\n");
  const from = Math.max(1, startLine - Math.max(0, contextLines));
  const to = Math.min(lines.length, endLine + Math.max(0, contextLines));
  return { text: lines.slice(from - 1, to).join("\n"), startLine: from, endLine: to };
}

function assembleSnapshot(path: string, snapshot: ParsedFileSnapshot): CallerModule {
  const localExports = new Map<string, string>();
  const reExports: ExportReference[] = [];
  for (const ref of snapshot.exports) {
    if (ref.sourceSpecifier === null) {
      if (ref.exportedName !== null && ref.localName !== null) localExports.set(ref.exportedName, ref.localName);
    } else {
      reExports.push(ref);
    }
  }
  return {
    path,
    definitions: snapshot.definitions,
    types: snapshot.types,
    imports: snapshot.imports,
    localExports,
    reExports,
  };
}

async function loadCallerModule(path: string, context: CallerContext): Promise<CallerModule | "cancelled" | null> {
  const hit = context.modules.get(path);
  if (hit !== undefined) return hit;
  const language = detectLanguage(path);
  if (language === null) {
    context.modules.set(path, null);
    return null;
  }
  let source: string;
  try {
    source = await context.reader.readHeadText(path);
  } catch (error) {
    if (isGitTimeout(error) || isGitOutputLimit(error)) throw error;
    context.modules.set(path, null);
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
  if (cached.status === "cancelled") {
    context.modules.set(path, "cancelled");
    return "cancelled";
  }
  const loaded = assembleSnapshot(path, cached.snapshot);
  context.modules.set(path, loaded);
  return loaded;
}

function toMemberContext(context: CallerContext): MemberResolutionContext {
  return {
    load: (path) => loadCallerModule(path, context),
    probe: async (base) => {
      const pick = pickTarget(candidatePaths(base), context.headIndex);
      if (pick.status !== "found") return null;
      return detectLanguage(pick.path) === null ? null : pick.path;
    },
  };
}

function toSite(
  path: string,
  callerDef: Definition | null,
  source: string,
  call: CallReference,
  reason: string,
): CallerSite {
  if (callerDef === null) {
    const snippet = snippetAround(source, call.range.startLine, call.range.endLine);
    return {
      path,
      caller: null,
      callerKind: "module",
      callerStartLine: snippet.startLine,
      callerEndLine: snippet.endLine,
      callerText: snippet.text,
      callRange: call.range,
      reason,
    };
  }
  return {
    path,
    caller: callerDef.name,
    callerKind: callerDef.kind,
    ...(callerDef.container === undefined ? {} : { callerContainer: callerDef.container }),
    callerStartLine: callerDef.fullRange.startLine,
    callerEndLine: callerDef.fullRange.endLine,
    callerText: callerDef.fullText,
    callRange: call.range,
    reason,
  };
}

function dedupeDiagnostics(diagnostics: readonly CallerDiagnostic[]): CallerDiagnostic[] {
  const seen = new Set<string>();
  const out: CallerDiagnostic[] = [];
  for (const entry of diagnostics) {
    const key = `${entry.filePath}\0${entry.symbol}\0${entry.candidate}\0${entry.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * Find every barrel that re-exports the target under a public name. Named
 * re-exports contribute their own exported names; `export *` contributes the
 * target's own public names when the star resolves unambiguously to it.
 */
async function discoverBarrelBindings(
  targetPath: string,
  targetNames: readonly string[],
  targetId: string,
  symbolName: string,
  context: CallerContext,
  scanned: readonly string[],
): Promise<{ bindings: BarrelBinding[]; diagnostics: CallerDiagnostic[] }> {
  const bindings: BarrelBinding[] = [];
  const diagnostics: CallerDiagnostic[] = [];
  const starNames = targetNames.filter((name) => name !== "default");
  const memberContext = toMemberContext(context);
  for (const barrelPath of scanned) {
    if (barrelPath === targetPath) continue;
    const loaded = context.modules.get(barrelPath);
    if (loaded === undefined || loaded === null) continue;
    if (loaded === "cancelled") {
      diagnostics.push({ filePath: targetPath, symbol: symbolName, candidate: barrelPath, reason: "parse-cancelled" });
      continue;
    }
    if (loaded.reExports.length === 0) continue;
    const tryNames = new Set<string>();
    let hasStar = false;
    for (const ref of loaded.reExports) {
      if (ref.sourceSpecifier === null || !isRelativeSpecifier(ref.sourceSpecifier)) continue;
      if (ref.kind === "named" && ref.exportedName !== null) {
        tryNames.add(ref.exportedName);
      } else if (ref.kind === "star") {
        hasStar = true;
      }
    }
    if (hasStar) {
      for (const name of starNames) tryNames.add(name);
    }
    for (const name of [...tryNames].sort()) {
      const outcome = await resolveExportedMember(barrelPath, name, memberContext);
      if (outcome.status === "found") {
        if (outcome.targetPath === targetPath && targetIdentity(outcome.targetPath, outcome.definition) === targetId) {
          bindings.push({ barrelPath, publicName: name });
        }
      } else if (outcome.status === "ambiguous") {
        diagnostics.push({ filePath: targetPath, symbol: symbolName, candidate: `${barrelPath}:${name}`, reason: "ambiguous" });
      } else if (outcome.status === "depth-exceeded") {
        diagnostics.push({ filePath: targetPath, symbol: symbolName, candidate: `${barrelPath}:${name}`, reason: "depth-exceeded" });
      } else if (outcome.status === "cancelled") {
        diagnostics.push({ filePath: targetPath, symbol: symbolName, candidate: `${barrelPath}:${name}`, reason: "parse-cancelled" });
      }
    }
  }
  bindings.sort((a, b) => {
    if (a.barrelPath !== b.barrelPath) return a.barrelPath < b.barrelPath ? -1 : 1;
    if (a.publicName !== b.publicName) return a.publicName < b.publicName ? -1 : 1;
    return 0;
  });
  const kept = bindings.slice(0, Math.max(0, MAX_CALLER_ALIASES));
  for (const dropped of bindings.slice(Math.max(0, MAX_CALLER_ALIASES))) {
    diagnostics.push({ filePath: targetPath, symbol: symbolName, candidate: `${dropped.barrelPath}:${dropped.publicName}`, reason: "cap-reached" });
  }
  return { bindings: kept, diagnostics };
}

interface VerifyTarget {
  filePath: string;
  symbolName: string;
  declaration: Definition;
  targetId: string;
  barrelPaths: ReadonlySet<string>;
}

/** Resolve an importer's relative imports to bindings on the target symbol. */
async function buildBindings(
  imports: readonly ImportReference[],
  candidate: string,
  target: VerifyTarget,
  context: CallerContext,
): Promise<{ bindings: Map<string, CallerBinding>; diagnostics: CallerDiagnostic[] }> {
  const bindings = new Map<string, CallerBinding>();
  const diagnostics: CallerDiagnostic[] = [];
  const memberContext = toMemberContext(context);
  for (const ref of imports) {
    if (ref.kind === "type-only" || ref.kind === "side-effect") continue;
    if (ref.localName === null || !isRelativeSpecifier(ref.sourceSpecifier)) continue;
    const base = resolveRelativePath(candidate, ref.sourceSpecifier);
    if (base === null) continue;
    const pick = pickTarget(candidatePaths(base), context.headIndex);
    if (pick.status !== "found" || detectLanguage(pick.path) === null) continue;
    if (pick.path !== target.filePath && !target.barrelPaths.has(pick.path)) continue;
    if (ref.kind === "namespace") {
      if (!bindings.has(ref.localName)) {
        bindings.set(ref.localName, { kind: "namespace", modulePath: pick.path, viaBarrel: pick.path !== target.filePath, alias: false });
      }
      continue;
    }
    const wanted = ref.kind === "default" ? "default" : (ref.importedName ?? ref.localName);
    const outcome = await resolveExportedMember(pick.path, wanted, memberContext);
    if (outcome.status === "found") {
      if (outcome.targetPath === target.filePath && targetIdentity(outcome.targetPath, outcome.definition) === target.targetId) {
        if (!bindings.has(ref.localName)) {
          bindings.set(ref.localName, {
            kind: ref.kind,
            modulePath: pick.path,
            viaBarrel: pick.path !== target.filePath,
            alias: ref.localName !== outcome.definition.name,
          });
        }
      }
    } else if (outcome.status === "ambiguous") {
      diagnostics.push({ filePath: target.filePath, symbol: target.symbolName, candidate: `${candidate}:${ref.localName}`, reason: "ambiguous" });
    } else if (outcome.status === "depth-exceeded") {
      diagnostics.push({ filePath: target.filePath, symbol: target.symbolName, candidate: `${candidate}:${ref.localName}`, reason: "depth-exceeded" });
    } else if (outcome.status === "cancelled") {
      diagnostics.push({ filePath: target.filePath, symbol: target.symbolName, candidate: `${candidate}:${ref.localName}`, reason: "parse-cancelled" });
    }
  }
  return { bindings, diagnostics };
}

async function verifyCandidate(
  candidate: string,
  target: VerifyTarget,
  context: CallerContext,
): Promise<{ sites: CallerSite[]; diagnostics: CallerDiagnostic[] }> {
  const language = detectLanguage(candidate);
  if (language === null) return { sites: [], diagnostics: [] };
  let source: string;
  try {
    source = await context.reader.readHeadText(candidate);
  } catch (error) {
    if (isGitTimeout(error) || isGitOutputLimit(error)) throw error;
    return { sites: [], diagnostics: [] };
  }
  const cached = await context.parseCache.getOrParse({
    commit: context.reader.headSha,
    path: candidate,
    source,
    language,
    perFileMs: context.perFileMs,
    runBudget: context.runBudget,
  });
  if (cached.status === "cancelled") {
    return {
      sites: [],
      diagnostics: [{ filePath: target.filePath, symbol: target.symbolName, candidate, reason: "parse-cancelled" }],
    };
  }
  {
    const snapshot = cached.snapshot;
    const { bindings, diagnostics } = await buildBindings(
      snapshot.imports,
      candidate,
      target,
      context,
    );
    if (bindings.size === 0) return { sites: [], diagnostics };
    const definitions = snapshot.definitions;
    const memberContext = toMemberContext(context);
    const sites: CallerSite[] = [];
    const callDiagnostics: CallerDiagnostic[] = [...diagnostics];
    for (const call of snapshot.calls) {
      if (call.root === null || call.root === "this" || call.root === "super") continue;
      const binding = bindings.get(call.root);
      if (binding === undefined) continue;
      if (call.member === null) {
        // Bare constructor/news calls and direct calls both reference the target.
        if (binding.kind === "namespace") continue;
        sites.push(toSite(candidate, enclosingCaller(definitions, call), snapshot.source, call, callerReason(binding)));
        continue;
      }
      // Member access on a value binding is unverifiable without type
      // information; only namespace members resolve statically.
      if (binding.kind !== "namespace") continue;
      const outcome = await resolveExportedMember(binding.modulePath, call.member, memberContext);
      if (outcome.status === "found") {
        if (outcome.targetPath === target.filePath && targetIdentity(outcome.targetPath, outcome.definition) === target.targetId) {
          sites.push(toSite(candidate, enclosingCaller(definitions, call), snapshot.source, call, callerReason(binding)));
        }
      } else if (outcome.status === "ambiguous") {
        callDiagnostics.push({ filePath: target.filePath, symbol: target.symbolName, candidate: `${candidate}:${call.root}.${call.member}`, reason: "ambiguous" });
      } else if (outcome.status === "depth-exceeded") {
        callDiagnostics.push({ filePath: target.filePath, symbol: target.symbolName, candidate: `${candidate}:${call.root}.${call.member}`, reason: "depth-exceeded" });
      } else if (outcome.status === "cancelled") {
        callDiagnostics.push({ filePath: target.filePath, symbol: target.symbolName, candidate: `${candidate}:${call.root}.${call.member}`, reason: "parse-cancelled" });
      }
    }
    return { sites, diagnostics: callDiagnostics };
  }
}

/**
 * Discover static callers of one changed symbol. Returns enclosing-caller
 * sites with head-side text; best-effort misses become diagnostics.
 */
export async function resolveCallersForSymbol(options: ResolveCallersOptions): Promise<ResolveCallersResult> {
  const { filePath, symbol, reader } = options;
  const perFileMs = options.perFileMs ?? DEFAULT_MAX_PARSE_TIME_MS;
  const maxCallers = options.maxCallers ?? MAX_CALLERS_PER_SYMBOL;
  const maxGrepMatches = options.maxGrepMatches ?? MAX_CALLER_GREP_MATCHES;
  const maxScanFiles = options.maxScanFiles ?? MAX_CALLER_SCAN_FILES;
  const language = detectLanguage(filePath);
  if (language === null) return { callers: [], diagnostics: [] };
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
  if (cached.status === "cancelled") return { callers: [], diagnostics: [] };
  {
    const targetModule = assembleSnapshot(filePath, cached.snapshot);
    const sourceText = cached.snapshot.source;
    const rootCalls = cached.snapshot.calls;
    const declaration = findTargetDeclaration(targetModule.definitions, targetModule.types, symbol);
    if (declaration === null || !("identityKey" in declaration) || declaration.kind === "type" || symbol.kind === "module") {
      return { callers: [], diagnostics: [] };
    }
    const context: CallerContext = {
      reader,
      headIndex: await reader.listHeadFiles(),
      perFileMs,
      runBudget: options.runBudget,
      parseCache,
      modules: new Map([[filePath, targetModule]]),
    };
    const publicNames = targetPublicNames(targetModule.localExports, declaration);
    const target: VerifyTarget = {
      filePath,
      symbolName: symbol.name,
      declaration,
      targetId: targetIdentity(filePath, declaration),
      barrelPaths: new Set(),
    };
    const sites: CallerSite[] = [];
    const diagnostics: CallerDiagnostic[] = [];
    for (const call of rootCalls) {
      if (call.range.startIndex >= declaration.fullRange.startIndex && call.range.endIndex <= declaration.fullRange.endIndex) {
        continue;
      }
      const scopeDef = enclosingCaller(targetModule.definitions, call);
      const scope: LocalScope = scopeDef === null
        ? { name: "<module>", kind: "module" }
        : {
          name: scopeDef.name,
          kind: scopeDef.kind,
          ...(scopeDef.container === undefined ? {} : { container: scopeDef.container }),
        };
      if (matchLocalCall(call, [declaration], scope).status !== "found") continue;
      sites.push(toSite(filePath, scopeDef, sourceText, call, callerReason(null)));
    }

    const searchNames = [...new Set([symbol.name, ...publicNames])]
      .filter((name) => name !== "default" && name.length > 0)
      .sort();
    const candidateFiles = new Set<string>([filePath]);
    for (const pattern of searchNames) {
      const matches = await reader.grepHead(pattern, { maxCount: Math.max(1, maxGrepMatches) });
      if (matches.length >= Math.max(1, maxGrepMatches)) {
        diagnostics.push({ filePath, symbol: symbol.name, candidate: `grep:${pattern}`, reason: "cap-reached" });
      }
      for (const match of matches) {
        if (detectLanguage(match.path) !== null) candidateFiles.add(match.path);
      }
    }

    const supported = [...context.headIndex.keys()].filter((path) => detectLanguage(path) !== null).sort();
    const scanned = supported.slice(0, Math.max(0, maxScanFiles));
    if (supported.length > scanned.length) {
      diagnostics.push({ filePath, symbol: symbol.name, candidate: "module-scan", reason: "cap-reached" });
    }
    for (const path of scanned) {
      await loadCallerModule(path, context);
    }
    const barrels = await discoverBarrelBindings(filePath, publicNames, target.targetId, symbol.name, context, scanned);
    diagnostics.push(...barrels.diagnostics);
    const barrelPaths = new Set(barrels.bindings.map((binding) => binding.barrelPath));
    target.barrelPaths = barrelPaths;

    for (const path of scanned) {
      if (path === filePath || candidateFiles.has(path)) continue;
      const loaded = context.modules.get(path);
      if (loaded === undefined || loaded === null || loaded === "cancelled") continue;
      for (const ref of loaded.imports) {
        if (ref.kind === "type-only" || ref.kind === "side-effect") continue;
        if (ref.localName === null || !isRelativeSpecifier(ref.sourceSpecifier)) continue;
        const base = resolveRelativePath(path, ref.sourceSpecifier);
        if (base === null) continue;
        const pick = pickTarget(candidatePaths(base), context.headIndex);
        if (pick.status !== "found" || detectLanguage(pick.path) === null) continue;
        if (pick.path === filePath || barrelPaths.has(pick.path)) {
          candidateFiles.add(path);
          break;
        }
      }
    }

    for (const candidate of [...candidateFiles].sort()) {
      if (candidate === filePath) continue;
      const verified = await verifyCandidate(candidate, target, context);
      sites.push(...verified.sites);
      diagnostics.push(...verified.diagnostics);
    }

    const ranked = sortCallerSites(dedupeCallerSites(sites));
    const kept = ranked.slice(0, Math.max(0, maxCallers));
    for (const dropped of ranked.slice(Math.max(0, maxCallers))) {
      diagnostics.push({ filePath, symbol: symbol.name, candidate: `${dropped.path}:${dropped.caller ?? "<module>"}`, reason: "cap-reached" });
    }
    return { callers: kept, diagnostics: dedupeDiagnostics(diagnostics) };
  }
}
