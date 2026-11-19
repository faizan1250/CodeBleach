import type { Node, Tree } from "web-tree-sitter";
import { javascriptAdapter } from "./adapters/javascript.ts";
import { tsxAdapter } from "./adapters/tsx.ts";
import { typescriptAdapter } from "./adapters/typescript.ts";
import type { Language } from "../types/diff.ts";

export interface LineRange {
  startLine: number;
  endLine: number;
}

export interface SymbolRange extends LineRange {
  startIndex: number;
  endIndex: number;
}

export type DefinitionKind = "function" | "method" | "class" | "type";

export interface Definition {
  name: string;
  kind: DefinitionKind;
  container?: string | undefined;
  declarationRange: SymbolRange;
  fullRange: SymbolRange;
  signatureText: string;
  fullText: string;
  exported: boolean;
  exportKind: "named" | "default" | "none";
  /** Deterministic file-local key; the caller prefixes the normalized path. */
  identityKey: string;
}

export type ImportKind = "named" | "default" | "namespace" | "type-only" | "side-effect";

export interface ImportReference {
  sourceSpecifier: string;
  kind: ImportKind;
  localName: string | null;
  importedName: string | null;
  range: LineRange;
}

export type ExportKind = "named" | "default" | "star" | "namespace";

export interface ExportReference {
  exportedName: string | null;
  localName: string | null;
  sourceSpecifier: string | null;
  kind: ExportKind;
  range: LineRange;
}

export interface CallReference {
  callee: string;
  root: string | null;
  member: string | null;
  isNew: boolean;
  /** Nearest enclosing definition name, or null at module scope. */
  containing: string | null;
  range: SymbolRange;
}

export type TypeKind = "interface" | "type-alias" | "enum";

export interface TypeDefinition {
  name: string;
  typeKind: TypeKind;
  range: SymbolRange;
  text: string;
  exported: boolean;
  exportKind: "named" | "default" | "none";
}

export interface ResolvedTarget {
  name: string;
  aliases?: readonly string[] | undefined;
}

export interface CallSite {
  /** Nearest enclosing definition name, or null at module scope. */
  caller: string | null;
  range: SymbolRange;
  callee: string;
  root: string | null;
  member: string | null;
  isNew: boolean;
}

export interface LanguageAdapter {
  readonly language: Language;
  readonly extensions: readonly string[];
  readonly grammarId: string;
  extractDefinitions(tree: Tree, source: string): Definition[];
  extractImports(tree: Tree, source: string): ImportReference[];
  extractExports(tree: Tree, source: string): ExportReference[];
  extractCalls(node: Node, source: string): CallReference[];
  extractTypes(tree: Tree, source: string): TypeDefinition[];
  extractCallSites(tree: Tree, source: string, target: ResolvedTarget): CallSite[];
  getTestFileScore(path: string): number;
  getSymbolName(node: Node, source: string): string | null;
}

const REGISTRY: Record<Language, LanguageAdapter> = {
  typescript: typescriptAdapter,
  tsx: tsxAdapter,
  javascript: javascriptAdapter,
};

export const supportedLanguages: readonly Language[] = ["typescript", "tsx", "javascript"];

export function getAdapter(language: Language): LanguageAdapter {
  return REGISTRY[language];
}
