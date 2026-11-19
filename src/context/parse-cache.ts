import { getAdapter } from "./language.ts";
import type {
  CallReference,
  CallSite,
  Definition,
  ExportReference,
  ImportReference,
  TypeDefinition,
} from "./language.ts";
import type { RunBudget } from "./limits.ts";
import { parseSource } from "./parser.ts";
import type { ErrorRange, ParseSkipReason } from "./parser.ts";
import type { SupportedLanguage } from "./runtime.ts";

// Per-run parsed snapshot cache. One parse per unique (commit, path,
// language); base and head stay separate through distinct commit SHAs.
// Only plain extraction data is stored — never Tree/WASM handles, so entries
// need no disposal beyond dropping the map at run end (ParseCache.clear).
export const MAX_PARSE_CACHE_ENTRIES = 256;
export const MAX_PARSE_CACHE_BYTES = 8_388_608;

export interface ParsedFileSnapshot {
  commit: string;
  path: string;
  language: SupportedLanguage;
  source: string;
  lineCount: number;
  errorCount: number;
  missingCount: number;
  errorRanges: ErrorRange[];
  durationMs: number;
  definitions: Definition[];
  types: TypeDefinition[];
  imports: ImportReference[];
  exports: ExportReference[];
  calls: CallReference[];
}

export type CachedParse =
  | { status: "parsed"; hit: boolean; snapshot: ParsedFileSnapshot }
  | {
      status: "cancelled";
      hit: boolean;
      source: string;
      lineCount: number;
      durationMs: number;
      skipReason: ParseSkipReason;
    };

export interface ParseCacheOptions {
  maxEntries?: number | undefined;
  maxBytes?: number | undefined;
}

export interface ParseCacheInput {
  commit: string;
  path: string;
  source: string;
  language: SupportedLanguage;
  perFileMs: number;
  runBudget?: RunBudget | undefined;
}

export interface ParseCacheStats {
  hits: number;
  misses: number;
  entries: number;
  bytes: number;
}

function positiveInt(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`ParseCache requires ${label} to be a positive integer`);
  }
  return resolved;
}

export class ParseCache {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly entries = new Map<string, ParsedFileSnapshot>();
  private totalBytes = 0;
  private hits = 0;
  private misses = 0;

  constructor(options: ParseCacheOptions = {}) {
    if (options === null || options === undefined || typeof options !== "object") {
      throw new Error("ParseCache requires an options object");
    }
    this.maxEntries = positiveInt(options.maxEntries, MAX_PARSE_CACHE_ENTRIES, "maxEntries");
    this.maxBytes = positiveInt(options.maxBytes, MAX_PARSE_CACHE_BYTES, "maxBytes");
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  stats(): ParseCacheStats {
    return { hits: this.hits, misses: this.misses, entries: this.entries.size, bytes: this.totalBytes };
  }

  /** Drop all entries; cached data holds no WASM handles, so nothing else disposes. */
  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  static keyOf(commit: string, path: string, language: SupportedLanguage): string {
    return `${commit.toLowerCase()}\0${path}\0${language}`;
  }

  /**
   * One extraction bundle per (commit, path, language). Hits never touch the
   * run budget; misses parse once under it via parseSource (per-file,
   * cumulative, and deadline limits all apply). Cancelled parses are never
   * stored. Over-cap files still parse fresh for the caller, just uncached.
   */
  async getOrParse(input: ParseCacheInput): Promise<CachedParse> {
    const key = ParseCache.keyOf(input.commit, input.path, input.language);
    const hit = this.entries.get(key);
    if (hit !== undefined && hit.source === input.source) {
      this.hits += 1;
      return { status: "parsed", hit: true, snapshot: hit };
    }
    this.misses += 1;
    const parsed = await parseSource({
      source: input.source,
      language: input.language,
      filePath: input.path,
      perFileMs: input.perFileMs,
      runBudget: input.runBudget,
    });
    if (parsed.tree === null) {
      return {
        status: "cancelled",
        hit: false,
        source: parsed.source,
        lineCount: parsed.lineCount,
        durationMs: parsed.durationMs,
        skipReason: parsed.skipReason ?? "per-file-timeout",
      };
    }
    try {
      const adapter = getAdapter(input.language);
      const snapshot: ParsedFileSnapshot = {
        commit: input.commit.toLowerCase(),
        path: input.path,
        language: input.language,
        source: parsed.source,
        lineCount: parsed.lineCount,
        errorCount: parsed.errorCount,
        missingCount: parsed.missingCount,
        errorRanges: [...parsed.errorRanges],
        durationMs: parsed.durationMs,
        definitions: adapter.extractDefinitions(parsed.tree, parsed.source),
        types: adapter.extractTypes(parsed.tree, parsed.source),
        imports: adapter.extractImports(parsed.tree, parsed.source),
        exports: adapter.extractExports(parsed.tree, parsed.source),
        calls: adapter.extractCalls(parsed.tree.rootNode, parsed.source),
      };
      this.store(key, hit, snapshot);
      return { status: "parsed", hit: false, snapshot };
    } finally {
      parsed.tree.delete();
    }
  }

  private store(key: string, previous: ParsedFileSnapshot | undefined, next: ParsedFileSnapshot): void {
    const size = next.source.length;
    if (previous !== undefined && previous.source === next.source) return;
    if (previous === undefined && this.entries.size >= this.maxEntries) return;
    const reclaimed = previous === undefined || previous.source === next.source ? 0 : previous.source.length;
    if (this.totalBytes - reclaimed + size > this.maxBytes) return;
    if (previous !== undefined && previous.source !== next.source) {
      this.totalBytes -= previous.source.length;
      this.entries.delete(key);
    }
    this.entries.set(key, next);
    this.totalBytes += size;
  }
}

/**
 * Root-call subset fully inside a definition span. Equivalent to node-scoped
 * extractCalls for callees: tree-sitter child spans nest inside their parent,
 * and the caller-owned range fallback already uses this containment.
 */
export function callsInRange(
  calls: readonly CallReference[],
  startIndex: number,
  endIndex: number,
): CallReference[] {
  return calls.filter((call) => call.range.startIndex >= startIndex && call.range.endIndex <= endIndex);
}

/**
 * Root-call subset naming one of `names`, as CallSites. Mirrors
 * collectCallSites exactly: CallReference.containing already holds the
 * root-relative enclosing name, which is what collectCallSites computes.
 */
export function callSitesFor(calls: readonly CallReference[], names: readonly string[]): CallSite[] {
  const wanted = new Set(names);
  const out: CallSite[] = [];
  for (const call of calls) {
    if ((call.root !== null && wanted.has(call.root)) || (call.member !== null && wanted.has(call.member))) {
      out.push({
        caller: call.containing,
        range: call.range,
        callee: call.callee,
        root: call.root,
        member: call.member,
        isNew: call.isNew,
      });
    }
  }
  return out;
}
