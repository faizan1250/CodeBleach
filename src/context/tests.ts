import { DEFAULT_MAX_PARSE_TIME_MS } from "../config/defaults.ts";
import { detectLanguage } from "../diff/paths.ts";
import type { ChangedSymbol } from "../types/diff.ts";
import { resolveExportedMember, targetIdentity } from "./calls.ts";
import type { MemberResolutionContext } from "./calls.ts";
import { findTargetDeclaration, snippetAround, targetPublicNames } from "./callers.ts";
import { candidatePaths, isRelativeSpecifier, pickTarget, resolveRelativePath } from "./imports.ts";
import { getAdapter } from "./language.ts";
import type { CallSite, Definition, ExportReference, ImportReference, TypeDefinition } from "./language.ts";
import type { RunBudget } from "./limits.ts";
import { ParseCache, callSitesFor } from "./parse-cache.ts";
import { scoreItem } from "./rank.ts";
import type { RankProximity } from "./rank.ts";
import type { SnapshotReader, TreeEntry } from "./snapshot.ts";
import { isGitOutputLimit, isGitTimeout } from "./snapshot.ts";

// Static best-effort related-test discovery for one changed symbol. Reads
// head-side blobs only; a candidate counts as a test file only through the
// shared adapter heuristic, never a second mechanism. Evidence order:
// direct relative file import > symbol import through a barrel >
// AST-verified call in test code > base-name match > comment/string-only
// mention (weak, always lowest so it never outranks AST-confirmed). A
// same-name local definition without import evidence excludes the file.

export const MAX_TESTS_PER_SYMBOL = 16;
export const MAX_TEST_GREP_MATCHES = 200;
export const MAX_TEST_SCAN_FILES = 200;
export const TEST_SNIPPET_CONTEXT_LINES = 10;

export type TestEvidence = "imports-file" | "imports-symbol" | "refs-symbol" | "name-match" | "weak-mention";

export type TestSkipReason = "unresolved" | "ambiguous" | "parse-cancelled" | "cap-reached" | "depth-exceeded";

export interface TestSite {
  path: string;
  testName: string | null;
  startLine: number;
  endLine: number;
  text: string;
  reason: string;
  evidence: TestEvidence;
  proximity: RankProximity;
}

export interface TestDiagnostic {
  filePath: string;
  symbol: string;
  candidate: string;
  reason: TestSkipReason;
}

export interface ResolveTestsOptions {
  filePath: string;
  symbol: ChangedSymbol;
  reader: SnapshotReader;
  perFileMs?: number | undefined;
  runBudget?: RunBudget | undefined;
  maxTests?: number | undefined;
  maxGrepMatches?: number | undefined;
  maxScanFiles?: number | undefined;
  parseCache?: ParseCache | undefined;
}

export interface ResolveTestsResult {
  tests: TestSite[];
  diagnostics: TestDiagnostic[];
}

interface TestModule {
  path: string;
  source: string;
  definitions: Definition[];
  types: TypeDefinition[];
  imports: ImportReference[];
  callSites: CallSite[];
  localExports: Map<string, string>;
  reExports: ExportReference[];
}

interface TestContext {
  reader: SnapshotReader;
  headIndex: ReadonlyMap<string, TreeEntry>;
  perFileMs: number;
  runBudget: RunBudget | undefined;
  parseCache: ParseCache;
  modules: Map<string, TestModule | "cancelled" | null>;
  targetPath: string;
  targetId: string;
  symbolName: string;
  names: readonly string[];
}

/** One entry per (file, enclosing test); the first occurrence wins. */
export function dedupeTestSites(sites: readonly TestSite[]): TestSite[] {
  const seen = new Set<string>();
  const out: TestSite[] = [];
  for (const site of sites) {
    const key = `${site.path}\0${site.testName ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(site);
  }
  return out;
}

/** Deterministic order: existing test score first, then path and start line. */
export function sortTestSites(sites: readonly TestSite[]): TestSite[] {
  return [...sites].sort((a, b) => {
    const scoreA = scoreItem("test", a.proximity);
    const scoreB = scoreItem("test", b.proximity);
    if (scoreA !== scoreB) return scoreB - scoreA;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    const nameA = a.testName ?? "";
    const nameB = b.testName ?? "";
    if (nameA !== nameB) return nameA < nameB ? -1 : 1;
    return 0;
  });
}

function testFileScoreOf(path: string): number {
  const language = detectLanguage(path);
  if (language === null) return 0;
  return getAdapter(language).getTestFileScore(path);
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const noExt = dot <= 0 ? base : base.slice(0, dot);
  return noExt.replace(/\.(test|spec)$/, "");
}

/** Shared base name after stripping test suffixes; containment covers plurals. */
function stemRelated(targetPath: string, candidatePath: string): boolean {
  const target = stemOf(targetPath);
  const candidate = stemOf(candidatePath);
  if (target.length === 0 || candidate.length === 0) return false;
  return target === candidate || target.includes(candidate) || candidate.includes(target);
}

/** Smallest definition containing the evidence line; null at module scope. */
function enclosingTest(definitions: readonly Definition[], line: number): Definition | null {
  let best: Definition | null = null;
  for (const definition of definitions) {
    if (line < definition.fullRange.startLine || line > definition.fullRange.endLine) continue;
    const span = definition.fullRange.endLine - definition.fullRange.startLine;
    const bestSpan = best === null ? Number.MAX_SAFE_INTEGER : best.fullRange.endLine - best.fullRange.startLine;
    if (span < bestSpan) best = definition;
  }
  return best;
}

async function loadTestModule(path: string, context: TestContext): Promise<TestModule | "cancelled" | null> {
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
  {
    const snapshot = cached.snapshot;
    const localExports = new Map<string, string>();
    const reExports: ExportReference[] = [];
    for (const ref of snapshot.exports) {
      if (ref.sourceSpecifier === null) {
        if (ref.exportedName !== null && ref.localName !== null) localExports.set(ref.exportedName, ref.localName);
      } else {
        reExports.push(ref);
      }
    }
    const loaded: TestModule = {
      path,
      source: snapshot.source,
      definitions: snapshot.definitions,
      types: snapshot.types,
      imports: snapshot.imports,
      callSites: callSitesFor(snapshot.calls, [...context.names]),
      localExports,
      reExports,
    };
    context.modules.set(path, loaded);
    return loaded;
  }
}

function toMemberContext(context: TestContext): MemberResolutionContext {
  return {
    load: (path) => loadTestModule(path, context),
    probe: async (base) => {
      const pick = pickTarget(candidatePaths(base), context.headIndex);
      if (pick.status !== "found") return null;
      return detectLanguage(pick.path) === null ? null : pick.path;
    },
  };
}

function toSite(
  path: string,
  module: TestModule,
  evidenceLine: number,
  reason: string,
  evidence: TestEvidence,
  proximity: RankProximity,
): TestSite {
  const enclosing = enclosingTest(module.definitions, evidenceLine);
  if (enclosing === null) {
    const snippet = snippetAround(module.source, evidenceLine, evidenceLine, TEST_SNIPPET_CONTEXT_LINES);
    return {
      path,
      testName: null,
      startLine: snippet.startLine,
      endLine: snippet.endLine,
      text: snippet.text,
      reason,
      evidence,
      proximity,
    };
  }
  return {
    path,
    testName: enclosing.name,
    startLine: enclosing.fullRange.startLine,
    endLine: enclosing.fullRange.endLine,
    text: enclosing.fullText,
    reason,
    evidence,
    proximity,
  };
}

interface FileImport {
  rangeLine: number;
  localName: string | null;
  kind: ImportReference["kind"];
  importedName: string | null;
  pickPath: string;
}

function relativeFileImports(module: TestModule, candidate: string, context: TestContext): FileImport[] {
  const out: FileImport[] = [];
  for (const ref of module.imports) {
    if (ref.kind === "side-effect") {
      if (!isRelativeSpecifier(ref.sourceSpecifier)) continue;
      const base = resolveRelativePath(candidate, ref.sourceSpecifier);
      if (base === null) continue;
      const pick = pickTarget(candidatePaths(base), context.headIndex);
      if (pick.status !== "found") continue;
      out.push({
        rangeLine: ref.range.startLine,
        localName: null,
        kind: ref.kind,
        importedName: null,
        pickPath: pick.path,
      });
      continue;
    }
    if (ref.localName === null || !isRelativeSpecifier(ref.sourceSpecifier)) continue;
    const base = resolveRelativePath(candidate, ref.sourceSpecifier);
    if (base === null) continue;
    const pick = pickTarget(candidatePaths(base), context.headIndex);
    if (pick.status !== "found") continue;
    out.push({
      rangeLine: ref.range.startLine,
      localName: ref.localName,
      kind: ref.kind,
      importedName: ref.importedName,
      pickPath: pick.path,
    });
  }
  return out.sort((a, b) => a.rangeLine - b.rangeLine);
}

function pushDiagnostic(diagnostics: TestDiagnostic[], entry: TestDiagnostic): void {
  diagnostics.push(entry);
}

function dedupeTestDiagnostics(diagnostics: readonly TestDiagnostic[]): TestDiagnostic[] {
  const seen = new Set<string>();
  const out: TestDiagnostic[] = [];
  for (const entry of diagnostics) {
    const key = `${entry.filePath}\0${entry.symbol}\0${entry.candidate}\0${entry.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * Classify one test file. Returns null when the file carries no evidence for
 * the target: no import, no AST-verified call, no base-name relation, and no
 * grep mention. A local same-name definition without import evidence also
 * excludes the file rather than guessing.
 */
async function classifyTestFile(
  candidate: string,
  module: TestModule,
  context: TestContext,
  grepLines: readonly number[],
  diagnostics: TestDiagnostic[],
): Promise<TestSite | null> {
  const fileImports = relativeFileImports(module, candidate, context);
  const direct = fileImports.filter((entry) => entry.pickPath === context.targetPath);
  if (direct.length > 0) {
    const first = direct[0];
    if (first === undefined) return null;
    return toSite(
      candidate,
      module,
      first.rangeLine,
      "test imports changed module (relative import)",
      "imports-file",
      "direct-import",
    );
  }

  const memberContext = toMemberContext(context);
  for (const entry of fileImports) {
    if (entry.kind === "namespace") {
      if (entry.localName === null) continue;
      for (const site of module.callSites) {
        if (site.root !== entry.localName || site.member === null) continue;
        const outcome = await resolveExportedMember(entry.pickPath, site.member, memberContext);
        if (outcome.status === "found") {
          if (
            outcome.targetPath === context.targetPath &&
            targetIdentity(outcome.targetPath, outcome.definition) === context.targetId
          ) {
            return toSite(
              candidate,
              module,
              site.range.startLine,
              "test imports changed symbol via barrel re-export",
              "imports-symbol",
              "direct-import",
            );
          }
        } else if (outcome.status === "ambiguous") {
          pushDiagnostic(diagnostics, {
            filePath: context.targetPath,
            symbol: context.symbolName,
            candidate: `${candidate}:${site.member}`,
            reason: "ambiguous",
          });
        } else if (outcome.status === "depth-exceeded") {
          pushDiagnostic(diagnostics, {
            filePath: context.targetPath,
            symbol: context.symbolName,
            candidate: `${candidate}:${site.member}`,
            reason: "depth-exceeded",
          });
        } else if (outcome.status === "cancelled") {
          pushDiagnostic(diagnostics, {
            filePath: context.targetPath,
            symbol: context.symbolName,
            candidate: `${candidate}:${site.member}`,
            reason: "parse-cancelled",
          });
        }
      }
      continue;
    }
    const wanted = entry.kind === "default" ? "default" : (entry.importedName ?? entry.localName);
    if (wanted === null) continue;
    const outcome = await resolveExportedMember(entry.pickPath, wanted, memberContext);
    if (outcome.status === "found") {
      if (
        outcome.targetPath === context.targetPath &&
        targetIdentity(outcome.targetPath, outcome.definition) === context.targetId
      ) {
        return toSite(
          candidate,
          module,
          entry.rangeLine,
          "test imports changed symbol via barrel re-export",
          "imports-symbol",
          "direct-import",
        );
      }
    } else if (outcome.status === "ambiguous") {
      pushDiagnostic(diagnostics, {
        filePath: context.targetPath,
        symbol: context.symbolName,
        candidate: `${candidate}:${wanted}`,
        reason: "ambiguous",
      });
    } else if (outcome.status === "depth-exceeded") {
      pushDiagnostic(diagnostics, {
        filePath: context.targetPath,
        symbol: context.symbolName,
        candidate: `${candidate}:${wanted}`,
        reason: "depth-exceeded",
      });
    } else if (outcome.status === "cancelled") {
      pushDiagnostic(diagnostics, {
        filePath: context.targetPath,
        symbol: context.symbolName,
        candidate: `${candidate}:${wanted}`,
        reason: "parse-cancelled",
      });
    }
  }

  if (
    module.definitions.some((definition) => definition.name === context.symbolName) ||
    module.types.some((type) => type.name === context.symbolName)
  ) {
    return null;
  }

  if (module.callSites.length > 0) {
    const ordered = [...module.callSites].sort((a, b) => a.range.startLine - b.range.startLine);
    for (const site of ordered) {
      const root = site.root;
      if (root === null) continue;
      if (site.member === null) {
        const binding = fileImports.find((entry) => entry.localName === root);
        if (binding !== undefined && binding.pickPath !== context.targetPath) {
          const wanted = binding.kind === "default" ? "default" : (binding.importedName ?? binding.localName);
          if (wanted === null) continue;
          const outcome = await resolveExportedMember(binding.pickPath, wanted, memberContext);
          if (outcome.status === "found") return null;
          if (outcome.status === "ambiguous" || outcome.status === "depth-exceeded" || outcome.status === "cancelled") {
            pushDiagnostic(diagnostics, {
              filePath: context.targetPath,
              symbol: context.symbolName,
              candidate: `${candidate}:${root}`,
              reason:
                outcome.status === "ambiguous"
                  ? "ambiguous"
                  : outcome.status === "depth-exceeded"
                    ? "depth-exceeded"
                    : "parse-cancelled",
            });
            return null;
          }
        }
      } else {
        const binding = fileImports.find((entry) => entry.localName === root);
        if (binding !== undefined && binding.kind === "namespace" && binding.pickPath !== context.targetPath) {
          const outcome = await resolveExportedMember(binding.pickPath, site.member, memberContext);
          if (outcome.status === "found") return null;
          if (outcome.status === "ambiguous" || outcome.status === "depth-exceeded" || outcome.status === "cancelled") {
            pushDiagnostic(diagnostics, {
              filePath: context.targetPath,
              symbol: context.symbolName,
              candidate: `${candidate}:${root}.${site.member}`,
              reason:
                outcome.status === "ambiguous"
                  ? "ambiguous"
                  : outcome.status === "depth-exceeded"
                    ? "depth-exceeded"
                    : "parse-cancelled",
            });
            return null;
          }
        }
      }
    }
    const first = ordered[0];
    if (first === undefined) return null;
    return toSite(
      candidate,
      module,
      first.range.startLine,
      "test calls changed symbol (AST-verified)",
      "refs-symbol",
      "cross-file-caller",
    );
  }

  if (stemRelated(context.targetPath, candidate)) {
    return toSite(
      candidate,
      module,
      1,
      "test file name matches changed file (heuristic)",
      "name-match",
      dirOf(candidate) === dirOf(context.targetPath) ? "same-dir-test" : "other",
    );
  }

  if (grepLines.length > 0) {
    const line = [...grepLines].sort((a, b) => a - b)[0] ?? 1;
    return toSite(
      candidate,
      module,
      line,
      "symbol mention outside executable code (weak evidence)",
      "weak-mention",
      "other",
    );
  }

  return null;
}

/**
 * Discover related tests for one changed symbol. Returns bounded,
 * deterministically ordered sites with head-side text; best-effort misses
 * become diagnostics rather than failures.
 */
export async function resolveTestsForSymbol(options: ResolveTestsOptions): Promise<ResolveTestsResult> {
  const { filePath, symbol, reader } = options;
  const perFileMs = options.perFileMs ?? DEFAULT_MAX_PARSE_TIME_MS;
  const maxTests = options.maxTests ?? MAX_TESTS_PER_SYMBOL;
  const maxGrepMatches = options.maxGrepMatches ?? MAX_TEST_GREP_MATCHES;
  const maxScanFiles = options.maxScanFiles ?? MAX_TEST_SCAN_FILES;
  const language = detectLanguage(filePath);
  if (language === null) return { tests: [], diagnostics: [] };
  if (symbol.kind === "module") return { tests: [], diagnostics: [] };
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
  if (cached.status === "cancelled") {
    return {
      tests: [],
      diagnostics: [{ filePath, symbol: symbol.name, candidate: filePath, reason: "parse-cancelled" }],
    };
  }
  {
    const snapshot = cached.snapshot;
    const localExports = new Map<string, string>();
    for (const ref of snapshot.exports) {
      if (ref.sourceSpecifier === null && ref.exportedName !== null && ref.localName !== null) {
        localExports.set(ref.exportedName, ref.localName);
      }
    }
    const declaration = findTargetDeclaration(snapshot.definitions, snapshot.types, symbol);
    if (declaration === null) return { tests: [], diagnostics: [] };
    const context: TestContext = {
      reader,
      headIndex: await reader.listHeadFiles(),
      perFileMs,
      runBudget: options.runBudget,
      parseCache,
      modules: new Map(),
      targetPath: filePath,
      targetId: targetIdentity(filePath, declaration),
      symbolName: symbol.name,
      names: [...new Set([symbol.name, ...targetPublicNames(localExports, declaration)])]
        .filter((name) => name !== "default" && name.length > 0)
        .sort(),
    };
    const sites: TestSite[] = [];
    const diagnostics: TestDiagnostic[] = [];
    const grepLines = new Map<string, number[]>();
    for (const pattern of context.names) {
      const matches = await reader.grepHead(pattern, { maxCount: Math.max(1, maxGrepMatches) });
      if (matches.length >= Math.max(1, maxGrepMatches)) {
        diagnostics.push({ filePath, symbol: symbol.name, candidate: `grep:${pattern}`, reason: "cap-reached" });
      }
      for (const match of matches) {
        if (detectLanguage(match.path) === null) continue;
        const lines = grepLines.get(match.path);
        if (lines === undefined) grepLines.set(match.path, [match.line]);
        else lines.push(match.line);
      }
    }

    const supported = [...context.headIndex.keys()].filter((path) => detectLanguage(path) !== null).sort();
    const scanned = supported.slice(0, Math.max(0, maxScanFiles));
    if (supported.length > scanned.length) {
      diagnostics.push({ filePath, symbol: symbol.name, candidate: "module-scan", reason: "cap-reached" });
    }
    const pool = new Set<string>();
    for (const path of scanned) {
      if (path !== filePath && testFileScoreOf(path) > 0) pool.add(path);
    }
    for (const path of grepLines.keys()) {
      if (path !== filePath && detectLanguage(path) !== null && testFileScoreOf(path) > 0) pool.add(path);
    }

    let parsedCount = 0;
    for (const candidate of [...pool].sort()) {
      if ((options.runBudget?.remainingRunMs() ?? 1) <= 0) break;
      if (parsedCount >= Math.max(0, maxScanFiles)) {
        diagnostics.push({ filePath, symbol: symbol.name, candidate: "test-scan", reason: "cap-reached" });
        break;
      }
      const loaded = await loadTestModule(candidate, context);
      if (loaded === null) continue;
      if (loaded === "cancelled") {
        diagnostics.push({ filePath, symbol: symbol.name, candidate, reason: "parse-cancelled" });
        continue;
      }
      parsedCount += 1;
      const site = await classifyTestFile(candidate, loaded, context, grepLines.get(candidate) ?? [], diagnostics);
      if (site !== null) sites.push(site);
    }

    const ranked = sortTestSites(dedupeTestSites(sites));
    const kept = ranked.slice(0, Math.max(0, maxTests));
    for (const dropped of ranked.slice(Math.max(0, maxTests))) {
      diagnostics.push({
        filePath,
        symbol: symbol.name,
        candidate: `${dropped.path}:${dropped.testName ?? "<module>"}`,
        reason: "cap-reached",
      });
    }
    return { tests: kept, diagnostics: dedupeTestDiagnostics(diagnostics) };
  }
}
