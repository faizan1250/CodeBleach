import type { LanguageAdapter } from "../language.ts";
import {
  collectCalls,
  collectCallSites,
  collectDefinitions,
  collectExports,
  collectImports,
  collectTypes,
  nameOf,
  testFileScore,
} from "./shared.ts";

export const typescriptAdapter: LanguageAdapter = {
  language: "typescript",
  extensions: [".ts", ".mts", ".cts"],
  grammarId: "tree-sitter-typescript",
  extractDefinitions: (tree, source) => collectDefinitions(tree.rootNode, source),
  extractImports: (tree, source) => collectImports(tree.rootNode, source),
  extractExports: (tree, source) => collectExports(tree.rootNode, source),
  extractCalls: (node, source) => collectCalls(node, source),
  extractTypes: (tree, source) => collectTypes(tree.rootNode, source),
  extractCallSites: (tree, source, target) => collectCallSites(tree.rootNode, source, target),
  getTestFileScore: (path) => testFileScore(path),
  getSymbolName: (node) => nameOf(node),
};
