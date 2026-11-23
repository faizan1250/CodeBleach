// Common-wrapper detector (P6-01, plan section 6.4).
//
// Per-helper denominators with lexical-scope-aware call resolution. A file is
// eligible for a (helper, symbol) group only when it holds an unambiguous
// supported static relative named import resolving to that group; each
// importing file counts once per group whether or not it calls. A file
// matches when one of its unambiguous local bindings for the group is called
// with an inline arrow/function expression as the first argument. Identifier
// text alone never matches: parameters, locals, destructured names, catch
// params, and nested declarations shadow the import, while ambiguous
// bindings and dynamic `with` scopes are unprovable and skipped.

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

interface IndexRange {
  startIndex: number;
  endIndex: number;
}

// A lexical binding that can shadow an imported helper, plus the index range
// of the scope the binding is visible in. A call resolves to the import only
// when no same-name binding range contains it. `var` bindings hoist to the
// nearest enclosing function or program scope; block bindings stay in their
// innermost scope; hoisted declarations cover their whole scope.
interface ScopeBinding extends IndexRange {
  name: string;
}

interface ShadowMap {
  bindings: ScopeBinding[];
  withRanges: IndexRange[];
  unprovable: boolean;
}

function spanOf(node: Node): LineSpan {
  return { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
}

function namedChildren(node: Node): Node[] {
  const out: Node[] = [];
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index);
    if (child !== null) out.push(child);
  }
  return out;
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

// Bound identifiers in a binding pattern. Property keys never bind; only
// values, elements, and rest/assignment targets do. Unrecognized shapes mark
// the file unprovable so callers skip rather than miscount.
function patternNames(node: Node | null, state: { unprovable: boolean }): string[] {
  if (node === null) return [];
  switch (node.type) {
    case "identifier":
    case "shorthand_property_identifier_pattern":
      return [node.text];
    case "this":
    case "property_identifier":
      return [];
    case "object_pattern":
    case "array_pattern": {
      const names: string[] = [];
      for (const child of namedChildren(node)) names.push(...patternNames(child, state));
      return names;
    }
    case "pair_pattern": {
      const value = node.childForFieldName("value");
      if (value !== null) return patternNames(value, state);
      state.unprovable = true;
      return [];
    }
    case "object_assignment_pattern":
    case "assignment_pattern":
      return patternNames(node.childForFieldName("left"), state);
    case "rest_pattern": {
      const child = node.namedChild(0);
      return patternNames(child, state);
    }
    default:
      state.unprovable = true;
      return [];
  }
}

// Collects every value binding in one file with the scope range each is
// visible in. Type-only declarations (interfaces, type aliases, type imports)
// bind no values and contribute nothing; dynamic `with` bodies are recorded
// separately because calls inside them resolve against runtime scope.
function collectShadows(root: Node): ShadowMap {
  const bindings: ScopeBinding[] = [];
  const withRanges: IndexRange[] = [];
  const state = { unprovable: false };
  const scopes: Node[] = [root];
  const functionScopes: Node[] = [root];

  function currentScope(): Node {
    return scopes[scopes.length - 1] ?? root;
  }

  function currentFunctionScope(): Node {
    return functionScopes[functionScopes.length - 1] ?? root;
  }

  function addBinding(name: string, scope: Node): void {
    bindings.push({ name, startIndex: scope.startIndex, endIndex: scope.endIndex });
  }

  function addPatternNames(pattern: Node | null, scope: Node): void {
    for (const name of patternNames(pattern, state)) addBinding(name, scope);
  }

  function addParameters(parameters: Node | null, scope: Node): void {
    if (parameters === null) return;
    for (const parameter of namedChildren(parameters)) {
      if (parameter.type === "required_parameter" || parameter.type === "optional_parameter") {
        const pattern = parameter.childForFieldName("pattern");
        if (pattern === null) {
          // Only `this` parameters lack a pattern; anything else is unknown.
          let seenThis = false;
          for (const child of namedChildren(parameter)) {
            if (child.type === "this") seenThis = true;
          }
          if (!seenThis) state.unprovable = true;
          continue;
        }
        addPatternNames(pattern, scope);
      } else if (parameter.type === "rest_pattern") {
        addPatternNames(parameter, scope);
      } else {
        state.unprovable = true;
      }
    }
  }

  function visit(node: Node): void {
    switch (node.type) {
      case "function_declaration":
      case "generator_function_declaration":
      case "class_declaration":
      case "abstract_class_declaration":
      case "enum_declaration":
      case "internal_module": {
        // Declaration names bind in the enclosing scope and hoist across it.
        const name = node.childForFieldName("name");
        if (name !== null && (name.type === "identifier" || name.type === "type_identifier")) {
          addBinding(name.text, currentScope());
        }
        const isFunction = node.type === "function_declaration" || node.type === "generator_function_declaration";
        scopes.push(node);
        if (isFunction) {
          functionScopes.push(node);
          addParameters(node.childForFieldName("parameters"), node);
        }
        for (const child of namedChildren(node)) visit(child);
        if (isFunction) functionScopes.pop();
        scopes.pop();
        return;
      }
      case "function_expression":
      case "generator_function": {
        // Expression names bind only inside the expression itself.
        scopes.push(node);
        functionScopes.push(node);
        const name = node.childForFieldName("name");
        if (name !== null && (name.type === "identifier" || name.type === "type_identifier")) {
          addBinding(name.text, node);
        }
        addParameters(node.childForFieldName("parameters"), node);
        for (const child of namedChildren(node)) visit(child);
        functionScopes.pop();
        scopes.pop();
        return;
      }
      case "class": {
        scopes.push(node);
        const name = node.childForFieldName("name");
        if (name !== null && (name.type === "identifier" || name.type === "type_identifier")) {
          addBinding(name.text, node);
        }
        for (const child of namedChildren(node)) visit(child);
        scopes.pop();
        return;
      }
      case "arrow_function": {
        scopes.push(node);
        functionScopes.push(node);
        const parameters = node.childForFieldName("parameters");
        if (parameters !== null) addParameters(parameters, node);
        else addPatternNames(node.childForFieldName("parameter"), node);
        for (const child of namedChildren(node)) visit(child);
        functionScopes.pop();
        scopes.pop();
        return;
      }
      case "method_definition": {
        // Method names are properties, not scope bindings; params bind inside.
        scopes.push(node);
        functionScopes.push(node);
        addParameters(node.childForFieldName("parameters"), node);
        for (const child of namedChildren(node)) visit(child);
        functionScopes.pop();
        scopes.pop();
        return;
      }
      case "lexical_declaration": {
        const scope = currentScope();
        for (const child of namedChildren(node)) {
          if (child.type === "variable_declarator") addPatternNames(child.childForFieldName("name"), scope);
        }
        for (const child of namedChildren(node)) visit(child);
        return;
      }
      case "variable_declaration": {
        // `var` hoists past blocks to the enclosing function or program.
        const scope = currentFunctionScope();
        for (const child of namedChildren(node)) {
          if (child.type === "variable_declarator") addPatternNames(child.childForFieldName("name"), scope);
        }
        for (const child of namedChildren(node)) visit(child);
        return;
      }
      case "catch_clause": {
        scopes.push(node);
        addPatternNames(node.childForFieldName("parameter"), node);
        for (const child of namedChildren(node)) visit(child);
        scopes.pop();
        return;
      }
      case "for_statement":
      case "switch_body":
      case "class_body":
      case "statement_block": {
        scopes.push(node);
        for (const child of namedChildren(node)) visit(child);
        scopes.pop();
        return;
      }
      case "for_in_statement": {
        scopes.push(node);
        // A missing `kind` field is a bare assignment target, not a binding.
        const kind = node.childForFieldName("kind");
        if (kind !== null) {
          addPatternNames(node.childForFieldName("left"), kind.text === "var" ? currentFunctionScope() : node);
        }
        for (const child of namedChildren(node)) visit(child);
        scopes.pop();
        return;
      }
      case "with_statement": {
        withRanges.push({ startIndex: node.startIndex, endIndex: node.endIndex });
        for (const child of namedChildren(node)) visit(child);
        return;
      }
      default: {
        for (const child of namedChildren(node)) visit(child);
      }
    }
  }

  visit(root);
  return { bindings, withRanges, unprovable: state.unprovable };
}

// Earliest call that provably resolves to the import: a bare-identifier
// callee naming a resolvable binding, an inline arrow/function first
// argument, no shadowing binding covering the call, and no dynamic scope.
function earliestResolvingCall(root: Node, localNames: ReadonlySet<string>, shadows: ShadowMap): LineSpan | null {
  if (shadows.unprovable || localNames.size === 0) return null;
  let earliest: LineSpan | null = null;
  walkNamed(root, (node) => {
    if (node.type !== "call_expression") return;
    const callee = node.childForFieldName("function");
    if (callee === null || callee.type !== "identifier" || !localNames.has(callee.text)) return;
    const args = node.childForFieldName("arguments");
    const first = args?.namedChild(0) ?? null;
    if (first === null || (first.type !== "arrow_function" && first.type !== "function_expression")) return;
    const start = node.startIndex;
    const end = node.endIndex;
    for (const binding of shadows.bindings) {
      if (binding.name === callee.text && binding.startIndex <= start && end <= binding.endIndex) return;
    }
    for (const range of shadows.withRanges) {
      if (range.startIndex <= start && end <= range.endIndex) return;
    }
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

interface GroupState {
  helperPath: string;
  importedName: string;
  eligibleFiles: number;
  matches: FileMatch[];
}

export function detectCommonWrappers(files: readonly ParsedSampledFile[]): DetectorCandidate[] {
  const ordered = orderSampledFiles(files);
  const inventory = new Set(ordered.map((file) => file.path));
  // Groups keyed by resolved helper plus exported symbol, each with its own
  // importing-file denominator: files that never import the helper, test
  // files, and unresolvable imports belong to no group.
  const groups = new Map<string, GroupState>();
  for (const file of ordered) {
    const adapter = getAdapter(file.language);
    if (adapter.getTestFileScore(file.path) > 0) continue;
    const perFile = new Map<string, { helperPath: string; importedName: string; localNames: Set<string> }>();
    for (const imported of adapter.extractImports(file.tree, file.source)) {
      if (imported.kind !== "named" || imported.localName === null || imported.importedName === null) continue;
      const helperPath = resolveRelativeImport(file.path, imported.sourceSpecifier, inventory);
      if (helperPath === null) continue;
      const key = JSON.stringify([helperPath, imported.importedName]);
      const existing = perFile.get(key);
      if (existing === undefined) {
        perFile.set(key, {
          helperPath,
          importedName: imported.importedName,
          localNames: new Set([imported.localName]),
        });
      } else {
        existing.localNames.add(imported.localName);
      }
    }
    if (perFile.size === 0) continue;
    // One local name bound to several helpers resolves to no single group.
    const keyCount = new Map<string, number>();
    for (const entry of perFile.values()) {
      for (const localName of entry.localNames) keyCount.set(localName, (keyCount.get(localName) ?? 0) + 1);
    }
    const shadows = collectShadows(file.tree.rootNode);
    for (const [key, entry] of perFile) {
      const group = groups.get(key);
      const state: GroupState = group ?? {
        helperPath: entry.helperPath,
        importedName: entry.importedName,
        eligibleFiles: 0,
        matches: [],
      };
      if (group === undefined) groups.set(key, state);
      // Importers count toward the denominator even when they never call.
      state.eligibleFiles += 1;
      const resolvable = new Set<string>();
      for (const localName of entry.localNames) {
        if (keyCount.get(localName) === 1) resolvable.add(localName);
      }
      const call = earliestResolvingCall(file.tree.rootNode, resolvable, shadows);
      if (call !== null) state.matches.push({ path: file.path, startLine: call.startLine, endLine: call.endLine });
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
    const pattern = `Modules importing the repository helper ${group.importedName} repeatedly wrap callbacks with it.`;
    if (pattern.length > MAX_CONVENTION_PATTERN_CHARS) continue;
    const candidate = toCandidate({
      detector: CONVENTION_DETECTOR_COMMON_WRAPPERS,
      detectorVersion: CONVENTION_DETECTOR_COMMON_WRAPPERS_VERSION,
      pattern,
      matches: group.matches,
      eligibleFiles: group.eligibleFiles,
      sampledFiles: files.length,
    });
    if (candidate !== null) candidates.push(candidate);
  }
  return candidates;
}
