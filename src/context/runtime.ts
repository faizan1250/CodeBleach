import { Language, Parser, Query } from "web-tree-sitter";
import type { Node, QueryMatch, QueryOptions } from "web-tree-sitter";
import runtimeWasmPath from "web-tree-sitter/tree-sitter.wasm" with { type: "file" };
import typescriptWasmPath from "@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm" with { type: "file" };
import tsxWasmPath from "@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm" with { type: "file" };
import javascriptWasmPath from "@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm" with { type: "file" };
import { ReviewerError } from "../core/errors.ts";

export type SupportedLanguage = "typescript" | "tsx" | "javascript";

const GRAMMAR_PATHS: Record<SupportedLanguage, string> = {
  typescript: typescriptWasmPath,
  tsx: tsxWasmPath,
  javascript: javascriptWasmPath,
};

let initPromise: Promise<void> | null = null;
const languageCache = new Map<SupportedLanguage, Language>();

function parseFailed(label: string, error: unknown): ReviewerError {
  return new ReviewerError({
    code: "PARSE_FAILED",
    message: `tree-sitter ${label} failed: ${error instanceof Error ? error.message : String(error)}`,
    cause: error,
  });
}

/** One-time WASM runtime initialization shared by the process. */
export async function ensureRuntimeInitialized(): Promise<void> {
  initPromise ??= (async () => {
    try {
      const bytes = new Uint8Array(await Bun.file(runtimeWasmPath).bytes());
      await Parser.init({ wasmBinary: bytes.buffer as ArrayBuffer });
    } catch (error) {
      initPromise = null;
      throw parseFailed("runtime initialization", error);
    }
  })();
  return initPromise;
}

/** Load a grammar from raw WASM bytes; corrupt assets fail as PARSE_FAILED. */
export async function loadLanguageFromBytes(bytes: Uint8Array, label: string): Promise<Language> {
  await ensureRuntimeInitialized();
  try {
    return await Language.load(bytes);
  } catch (error) {
    throw parseFailed(`grammar load (${label})`, error);
  }
}

/** Lazily load each grammar once and cache the Language for the process lifetime. */
export async function loadLanguage(language: SupportedLanguage): Promise<Language> {
  const cached = languageCache.get(language);
  if (cached !== undefined) return cached;
  try {
    const bytes = new Uint8Array(await Bun.file(GRAMMAR_PATHS[language]).bytes());
    const loaded = await loadLanguageFromBytes(bytes, language);
    languageCache.set(language, loaded);
    return loaded;
  } catch (error) {
    if (error instanceof ReviewerError) throw error;
    throw parseFailed(`grammar load (${language})`, error);
  }
}

export function runtimeDiagnostics(): {
  initialized: boolean;
  loadedLanguages: SupportedLanguage[];
} {
  return { initialized: initPromise !== null, loadedLanguages: [...languageCache.keys()].sort() };
}

/** Fresh parser bound to a loaded language; ABI mismatches fail as PARSE_FAILED. */
export function createParser(language: Language): Parser {
  const parser = new Parser();
  try {
    parser.setLanguage(language);
  } catch (error) {
    parser.delete();
    throw parseFailed("setLanguage", error);
  }
  return parser;
}

// timeoutMicros halts early with the matches found so far (not an empty
// array as the binding docs claim); tiny values therefore yield partial
// results instead of throwing. Verified empirically against 0.25.10.
export function queryMatches(language: Language, pattern: string, node: Node, options?: QueryOptions): QueryMatch[] {
  const query = new Query(language, pattern);
  try {
    return query.matches(node, options);
  } finally {
    query.delete();
  }
}
