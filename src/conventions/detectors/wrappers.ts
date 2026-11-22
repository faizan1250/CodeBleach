// Common-wrapper detector (P6-01, plan section 6.4).
//
// Narrow AST algorithm: static relative imports resolved unambiguously
// against the sampled inventory, then call expressions whose callee is the
// imported binding with an inline arrow/function expression as the first
// argument. Package imports, aliases, computed paths, unresolved imports,
// re-export chains, and ambiguous shapes never match. At most one match per
// importing file per helper; a helper needs five distinct importing files.

import type { Node } from "web-tree-sitter";
import { getAdapter } from "../../context/language.ts";
import {
  CONVENTION_DETECTOR_COMMON_WRAPPERS,
  CONVENTION_DETECTOR_COMMON_WRAPPERS_VERSION,
  MAX_CONVENTION_PATTERN_CHARS,
  MIN_EVIDENCE_FILES,
} from "../constants.ts";
import { languageForSampledPath } from "../sampling.ts";
import { orderSampledFiles, toCandidate } from "./index.ts";
import type { DetectorCandidate, FileMatch, ParsedSampledFile } from "./index.ts";

// Interpolated into the pattern template only after passing this allowlist;
// arbitrary source text, comments, and string literals never enter patterns.
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const PROBE_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".js", ".jsx"];

interface LineSpan {
  startLine: number;
  endLine: number;
}

function spanOf(node: Node): LineSpan {
  return { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
}

function walkNamed(root: Node, visit: (node: Node) => void): void {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    visit(current);
    for (let index = current.namedChildCount - 1; index >= 0; index -= 1) {
      const child = current.namedChild(index);
      if (child !== null) stack.push(child);
    }
  }
}

// Resolves only unambiguous relative imports to another file in the sampled
// inventory. Extensionless specifiers probe the four sampled extensions;
// exactly one inventory hit wins, zero or several resolve to nothing.
function resolveRelativeImport(importerPath: string, specifier: string, inventory: ReadonlySet<string>): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const slash = importerPath.lastIndexOf("/");
  const dir = slash === -1 ? "" : importerPath.slice(0, slash);
  const parts: string[] = [];
  for (const segment of `${dir}/${specifier}`.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const base = parts.join("/");
  if (base.length === 0) return null;
  if (languageForSampledPath(base) !== null && inventory.has(base)) return base;
  let hit: string | null = null;
  for (const ext of PROBE_EXTENSIONS) {
    if (inventory.has(`${base}${ext}`)) {
      if (hit !== null) return null;
      hit = `${base}${ext}`;
    }
  }
  return hit;
}

function earliestCallbackCall(root: Node, localName: string): LineSpan | null {
  let earliest: LineSpan | null = null;
  walkNamed(root, (node) => {
    if (node.type !== "call_expression") return;
    const callee = node.childForFieldName("function");
    if (callee === null || callee.type !== "identifier" || callee.text !== localName) return;
    const args = node.childForFieldName("arguments");
    const first = args?.namedChild(0) ?? null;
    if (first === null || (first.type !== "arrow_function" && first.type !== "function_expression")) return;
    const span = spanOf(node);
    if (earliest === null || span.startLine < earliest.startLine) earliest = span;
  });
  return earliest;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function detectCommonWrappers(files: readonly ParsedSampledFile[]): DetectorCandidate[] {
  const ordered = orderSampledFiles(files);
  const inventory = new Set(ordered.map((file) => file.path));
  // Groups keyed by resolved helper plus exported symbol.
  const groups = new Map<string, { helperPath: string; importedName: string; matches: FileMatch[] }>();
  let eligibleFiles = 0;
  for (const file of ordered) {
    const adapter = getAdapter(file.language);
    if (adapter.getTestFileScore(file.path) > 0) continue;
    eligibleFiles += 1;
    const seen = new Set<string>();
    for (const imported of adapter.extractImports(file.tree, file.source)) {
      if (imported.kind !== "named" || imported.localName === null || imported.importedName === null) continue;
      if (seen.has(imported.localName)) continue;
      seen.add(imported.localName);
      const helperPath = resolveRelativeImport(file.path, imported.sourceSpecifier, inventory);
      if (helperPath === null) continue;
      const call = earliestCallbackCall(file.tree.rootNode, imported.localName);
      if (call === null) continue;
      const key = JSON.stringify([helperPath, imported.importedName]);
      const group = groups.get(key);
      const match: FileMatch = { path: file.path, startLine: call.startLine, endLine: call.endLine };
      if (group === undefined) {
        groups.set(key, { helperPath, importedName: imported.importedName, matches: [match] });
      } else {
        group.matches.push(match);
      }
    }
  }
  const ranked = [...groups.values()].sort(
    (a, b) => compareStrings(a.helperPath, b.helperPath) || compareStrings(a.importedName, b.importedName),
  );
  const candidates: DetectorCandidate[] = [];
  for (const group of ranked) {
    // Section 6.4 pins the five-file minimum inside the wrapper algorithm;
    // the generic support gates in P6-02 re-apply it for every detector.
    if (group.matches.length < MIN_EVIDENCE_FILES) continue;
    if (!IDENTIFIER_PATTERN.test(group.importedName)) continue;
    const pattern = `Modules repeatedly wrap callbacks with the repository helper ${group.importedName}.`;
    if (pattern.length > MAX_CONVENTION_PATTERN_CHARS) continue;
    const candidate = toCandidate({
      detector: CONVENTION_DETECTOR_COMMON_WRAPPERS,
      detectorVersion: CONVENTION_DETECTOR_COMMON_WRAPPERS_VERSION,
      pattern,
      matches: group.matches,
      eligibleFiles,
      sampledFiles: files.length,
    });
    if (candidate !== null) candidates.push(candidate);
  }
  return candidates;
}
