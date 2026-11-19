import type { Node } from "web-tree-sitter";
import { sliceSourceByIndex } from "../parser.ts";
import type {
  CallReference,
  CallSite,
  Definition,
  ExportReference,
  ImportReference,
  LineRange,
  ResolvedTarget,
  SymbolRange,
  TypeDefinition,
  TypeKind,
} from "../language.ts";

// Grammar node shapes are genuinely compatible across TS/TSX/JS for the
// constructs below (verified by dumping each grammar), so all three adapters
// share this traversal. Language differences stay in the thin adapter modules
// (language tag, extensions, grammar id). Positions come from node.text and
// unit indices, never UTF-8 bytes (see parser.ts).

type Scope = string | null;

interface ExportCtx {
  exported: boolean;
  exportKind: "named" | "default" | "none";
}

const TOP_LEVEL: ExportCtx = { exported: false, exportKind: "none" };

interface RawDefinition extends Definition {
  typeKind?: TypeKind | undefined;
}

function lineRangeOf(node: Node): LineRange {
  return { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
}

function symbolRangeOf(node: Node): SymbolRange {
  return { ...lineRangeOf(node), startIndex: node.startIndex, endIndex: node.endIndex };
}

function headerEndOf(node: Node): { endIndex: number; endLine: number } {
  const body = node.childForFieldName("body");
  if (body === null) return { endIndex: node.endIndex, endLine: node.endPosition.row + 1 };
  return { endIndex: body.startIndex, endLine: body.startPosition.row + 1 };
}

/** Declared name of a definition-like node, or null when unstable/anonymous. */
export function nameOf(node: Node): string | null {
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
    case "class_declaration":
    case "abstract_class_declaration":
    case "class":
    case "interface_declaration":
    case "type_alias_declaration":
    case "enum_declaration": {
      const name = node.childForFieldName("name");
      return name !== null && (name.type === "identifier" || name.type === "type_identifier")
        ? name.text
        : null;
    }
    case "method_definition": {
      // Any spelling (identifier, string, number, computed) is stable text.
      return node.childForFieldName("name")?.text ?? null;
    }
    case "variable_declarator":
    case "function_expression":
    case "arrow_function": {
      const name = node.childForFieldName("name");
      return name !== null && name.type === "identifier" ? name.text : null;
    }
    default:
      return null;
  }
}

function containerOf(scopes: readonly Scope[]): string | undefined {
  const names = scopes.filter((scope): scope is string => scope !== null);
  return names.length === 0 ? undefined : names.join(".");
}

function namedChildren(node: Node): Node[] {
  const out: Node[] = [];
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index);
    if (child !== null) out.push(child);
  }
  return out;
}

function namedChildOfType(node: Node, type: string): Node | null {
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index);
    if (child !== null && child.type === type) return child;
  }
  return null;
}

function hasAnonymousChild(node: Node, type: string): boolean {
  for (let index = 0; index < node.childCount; index += 1) {
    if (node.child(index)?.type === type) return true;
  }
  return false;
}

function walk(node: Node, visit: (visited: Node) => void): void {
  const stack: Node[] = [node];
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

interface Emitter {
  emit(
    node: Node,
    header: { endIndex: number; endLine: number },
    init: Omit<RawDefinition, "declarationRange" | "fullRange" | "signatureText" | "fullText" | "identityKey">,
  ): string;
}

function makeEmitter(source: string, out: RawDefinition[]): Emitter {
  const seen = new Map<string, number>();
  return {
    emit(node, header, init) {
      const container = init.container;
      const base = `${init.kind}:${container ?? ""}:${init.name}`;
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      const fullRange = symbolRangeOf(node);
      out.push({
        ...init,
        container,
        declarationRange: {
          startLine: fullRange.startLine,
          endLine: header.endLine,
          startIndex: fullRange.startIndex,
          endIndex: header.endIndex,
        },
        fullRange,
        signatureText: sliceSourceByIndex(source, fullRange.startIndex, header.endIndex),
        fullText: node.text,
        identityKey: count === 0 ? base : `${base}#${count + 1}`,
      });
      return init.name;
    },
  };
}

const FUNCTION_VALUES = new Set(["arrow_function", "function_expression"]);
const CLASS_VALUES = new Set(["class", "class_declaration"]);

function visitEach(
  parent: Node,
  scopes: readonly Scope[],
  source: string,
  emitter: Emitter,
): void {
  for (const child of namedChildren(parent)) {
    visit(child, scopes, TOP_LEVEL, source, emitter);
  }
}

function visitDeclarator(
  declarator: Node,
  scopes: readonly Scope[],
  exp: ExportCtx,
  source: string,
  emitter: Emitter,
): void {
  const nameNode = declarator.childForFieldName("name");
  if (nameNode === null || nameNode.type !== "identifier") return;
  const varName = nameNode.text;
  const value = declarator.childForFieldName("value");
  if (value === null) return;
  if (FUNCTION_VALUES.has(value.type) || CLASS_VALUES.has(value.type)) {
    const kind = FUNCTION_VALUES.has(value.type) ? "function" : "class";
    emitter.emit(
      declarator,
      headerEndOf(value),
      {
        name: varName,
        kind,
        container: containerOf(scopes),
        exported: exp.exported,
        exportKind: exp.exportKind,
      },
    );
    visitEach(value, [...scopes, varName], source, emitter);
  } else if (value.type === "object") {
    visitEach(value, [...scopes, varName], source, emitter);
  }
}

function visitExportStatement(
  node: Node,
  scopes: readonly Scope[],
  source: string,
  emitter: Emitter,
): void {
  const isDefault = hasAnonymousChild(node, "default");
  const exp: ExportCtx = { exported: true, exportKind: isDefault ? "default" : "named" };
  const declaration = node.childForFieldName("declaration");
  if (declaration !== null) {
    visit(declaration, scopes, exp, source, emitter);
    return;
  }
  const value = node.childForFieldName("value");
  if (value !== null) {
    if (FUNCTION_VALUES.has(value.type) || CLASS_VALUES.has(value.type)) {
      const name = nameOf(value) ?? "default";
      const kind = FUNCTION_VALUES.has(value.type) ? "function" : "class";
      emitter.emit(value, headerEndOf(value), {
        name,
        kind,
        container: containerOf(scopes),
        exported: true,
        exportKind: "default",
      });
      visitEach(value, [...scopes, name], source, emitter);
    }
  }
}

function visit(
  node: Node,
  scopes: readonly Scope[],
  exp: ExportCtx,
  source: string,
  emitter: Emitter,
): void {
  switch (node.type) {
    case "export_statement":
      visitExportStatement(node, scopes, source, emitter);
      return;
    case "function_declaration":
    case "generator_function_declaration": {
      const name = nameOf(node) ?? (exp.exportKind === "default" ? "default" : null);
      if (name === null) {
        visitEach(node, [...scopes, null], source, emitter);
        return;
      }
      emitter.emit(node, headerEndOf(node), {
        name,
        kind: "function",
        container: containerOf(scopes),
        exported: exp.exported,
        exportKind: exp.exportKind,
      });
      visitEach(node, [...scopes, name], source, emitter);
      return;
    }
    case "class_declaration":
    case "abstract_class_declaration":
    case "class": {
      const name = nameOf(node) ?? (exp.exportKind === "default" ? "default" : null);
      if (name === null) {
        visitEach(node, [...scopes, null], source, emitter);
        return;
      }
      emitter.emit(node, headerEndOf(node), {
        name,
        kind: "class",
        container: containerOf(scopes),
        exported: exp.exported,
        exportKind: exp.exportKind,
      });
      visitEach(node, [...scopes, name], source, emitter);
      return;
    }
    case "lexical_declaration":
    case "variable_declaration":
      for (const child of namedChildren(node)) {
        if (child.type === "variable_declarator") {
          visitDeclarator(child, scopes, exp, source, emitter);
        }
      }
      return;
    case "method_definition": {
      const name = nameOf(node);
      const top = scopes.length === 0 ? null : scopes[scopes.length - 1];
      if (name === null || top === undefined || top === null) {
        visitEach(node, [...scopes, null], source, emitter);
        return;
      }
      emitter.emit(node, headerEndOf(node), {
        name,
        kind: "method",
        container: containerOf(scopes),
        exported: exp.exported,
        exportKind: exp.exportKind,
      });
      visitEach(node, [...scopes, name], source, emitter);
      return;
    }
    case "interface_declaration":
    case "type_alias_declaration":
    case "enum_declaration": {
      const name = nameOf(node);
      if (name === null) return;
      const typeKind = node.type === "interface_declaration"
        ? "interface"
        : node.type === "type_alias_declaration"
          ? "type-alias"
          : "enum";
      emitter.emit(node, headerEndOf(node), {
        name,
        kind: "type",
        container: containerOf(scopes),
        exported: exp.exported,
        exportKind: exp.exportKind,
        typeKind,
      });
      return;
    }
    case "function_signature":
      return;
    case "internal_module": {
      const name = node.childForFieldName("name");
      const scope: Scope = name !== null && name.type === "identifier" ? name.text : null;
      visitEach(node, [...scopes, scope], source, emitter);
      return;
    }
    case "module":
    case "object":
      visitEach(node, [...scopes, null], source, emitter);
      return;
    default:
      visitEach(node, scopes, source, emitter);
  }
}

function stripDefinition(internal: RawDefinition): Definition {
  const { typeKind: _ignored, ...definition } = internal;
  return definition;
}

export function collectDefinitions(root: Node, source: string): Definition[] {
  const out: RawDefinition[] = [];
  visit(root, [], TOP_LEVEL, source, makeEmitter(source, out));
  return out.map(stripDefinition);
}

export function collectTypes(root: Node, source: string): TypeDefinition[] {
  const out: RawDefinition[] = [];
  visit(root, [], TOP_LEVEL, source, makeEmitter(source, out));
  return out
    .filter((definition) => definition.kind === "type" && definition.typeKind !== undefined)
    .map((definition) => ({
      name: definition.name,
      typeKind: definition.typeKind as TypeKind,
      range: definition.fullRange,
      text: definition.fullText,
      exported: definition.exported,
      exportKind: definition.exportKind,
    }));
}

function specifierText(sourceNode: Node | null): string {
  if (sourceNode === null) return "";
  const fragments: string[] = [];
  walk(sourceNode, (node) => {
    if (node.type === "string_fragment") fragments.push(node.text);
  });
  return fragments.join("");
}

export function collectImports(root: Node, source: string): ImportReference[] {
  void source;
  const out: ImportReference[] = [];
  walk(root, (node) => {
    if (node.type !== "import_statement") return;
    const statementTypeOnly = hasAnonymousChild(node, "type");
    const specifier = specifierText(node.childForFieldName("source"));
    const range = lineRangeOf(node);
    const clause = namedChildOfType(node, "import_clause");
    if (clause === null) {
      out.push({ sourceSpecifier: specifier, kind: "side-effect", localName: null, importedName: null, range });
      return;
    }
    for (const child of namedChildren(clause)) {
      if (child.type === "identifier") {
        out.push({
          sourceSpecifier: specifier,
          kind: statementTypeOnly ? "type-only" : "default",
          localName: child.text,
          importedName: "default",
          range,
        });
      } else if (child.type === "named_imports") {
        for (const spec of namedChildren(child)) {
          const nameNode = spec.childForFieldName("name");
          if (nameNode === null) continue;
          const aliasNode = spec.childForFieldName("alias");
          out.push({
            sourceSpecifier: specifier,
            kind: statementTypeOnly || hasAnonymousChild(spec, "type") ? "type-only" : "named",
            localName: aliasNode?.text ?? nameNode.text,
            importedName: nameNode.text,
            range,
          });
        }
      } else if (child.type === "namespace_import") {
        out.push({
          sourceSpecifier: specifier,
          kind: statementTypeOnly ? "type-only" : "namespace",
          localName: namedChildOfType(child, "identifier")?.text ?? null,
          importedName: null,
          range,
        });
      }
    }
  });
  return out;
}

function declaredNames(declaration: Node): string[] {
  switch (declaration.type) {
    case "lexical_declaration":
    case "variable_declaration": {
      const names: string[] = [];
      for (const child of namedChildren(declaration)) {
        if (child.type !== "variable_declarator") continue;
        const name = nameOf(child);
        if (name !== null) names.push(name);
      }
      return names;
    }
    default: {
      const name = nameOf(declaration);
      return name === null ? [] : [name];
    }
  }
}

export function collectExports(root: Node, source: string): ExportReference[] {
  void source;
  const out: ExportReference[] = [];
  walk(root, (node) => {
    if (node.type !== "export_statement") return;
    const isDefault = hasAnonymousChild(node, "default");
    const range = lineRangeOf(node);
    const declaration = node.childForFieldName("declaration");
    if (declaration !== null) {
      const kind = isDefault ? "default" : "named";
      for (const name of declaredNames(declaration)) {
        out.push({
          exportedName: isDefault ? "default" : name,
          localName: name,
          sourceSpecifier: null,
          kind,
          range,
        });
      }
      return;
    }
    const value = node.childForFieldName("value");
    const sourceNode = node.childForFieldName("source");
    const specifier = sourceNode === null ? null : specifierText(sourceNode);
    if (value !== null && sourceNode === null) {
      const localName = value.type === "identifier" ? value.text : nameOf(value);
      out.push({ exportedName: "default", localName, sourceSpecifier: null, kind: "default", range });
      return;
    }
    const clause = namedChildOfType(node, "export_clause");
    if (clause !== null) {
      for (const spec of namedChildren(clause)) {
        const nameNode = spec.childForFieldName("name");
        if (nameNode === null) continue;
        const aliasNode = spec.childForFieldName("alias");
        out.push({
          exportedName: aliasNode?.text ?? nameNode.text,
          localName: nameNode.text,
          sourceSpecifier: specifier,
          kind: "named",
          range,
        });
      }
      return;
    }
    const namespaceExport = namedChildOfType(node, "namespace_export");
    if (namespaceExport !== null) {
      out.push({
        exportedName: namedChildOfType(namespaceExport, "identifier")?.text ?? null,
        localName: null,
        sourceSpecifier: specifier,
        kind: "namespace",
        range,
      });
      return;
    }
    if (specifier !== null) {
      out.push({ exportedName: null, localName: null, sourceSpecifier: specifier, kind: "star", range });
      return;
    }
    const bare = namedChildOfType(node, "identifier");
    if (bare !== null && !isDefault) {
      out.push({ exportedName: "default", localName: bare.text, sourceSpecifier: null, kind: "default", range });
    }
  });
  return out;
}

interface CalleeInfo {
  callee: Node;
  isNew: boolean;
}

function asCall(node: Node): CalleeInfo | null {
  if (node.type === "call_expression") {
    const callee = node.childForFieldName("function");
    return callee === null ? null : { callee, isNew: false };
  }
  if (node.type === "new_expression") {
    const callee = node.childForFieldName("constructor");
    return callee === null ? null : { callee, isNew: true };
  }
  return null;
}

function calleeParts(callee: Node): { text: string; root: string | null; member: string | null } {
  const text = callee.text;
  if (callee.type === "identifier" || callee.type === "this" || callee.type === "super") {
    return { text, root: text, member: null };
  }
  if (callee.type === "member_expression") {
    let object = callee.childForFieldName("object");
    while (object !== null && object.type === "member_expression") {
      object = object.childForFieldName("object");
    }
    const root = object !== null &&
        (object.type === "identifier" || object.type === "this" || object.type === "super")
      ? object.text
      : null;
    return { text, root, member: callee.childForFieldName("property")?.text ?? null };
  }
  return { text, root: null, member: null };
}

function scopeName(node: Node): string | null {
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
    case "method_definition":
    case "class_declaration":
    case "abstract_class_declaration":
    case "class":
      return nameOf(node);
    case "variable_declarator": {
      const nameNode = node.childForFieldName("name");
      const value = node.childForFieldName("value");
      const scoped = value !== null &&
        (FUNCTION_VALUES.has(value.type) || CLASS_VALUES.has(value.type) || value.type === "object");
      return nameNode !== null && nameNode.type === "identifier" && scoped ? nameNode.text : null;
    }
    default:
      return null;
  }
}

function enclosingName(callNode: Node, stop: Node): string | null {
  let current = callNode.parent;
  while (current !== null) {
    const name = scopeName(current);
    if (name !== null) return name;
    if (current === stop) return null;
    current = current.parent;
  }
  return null;
}

export function collectCalls(node: Node, source: string): CallReference[] {
  void source;
  const out: CallReference[] = [];
  walk(node, (visited) => {
    const info = asCall(visited);
    if (info === null) return;
    const parts = calleeParts(info.callee);
    out.push({
      callee: visited.text,
      root: parts.root,
      member: parts.member,
      isNew: info.isNew,
      containing: enclosingName(visited, node),
      range: symbolRangeOf(visited),
    });
  });
  return out;
}

export function collectCallSites(root: Node, source: string, target: ResolvedTarget): CallSite[] {
  void source;
  const names = new Set<string>([target.name, ...(target.aliases ?? [])]);
  const out: CallSite[] = [];
  walk(root, (visited) => {
    const info = asCall(visited);
    if (info === null) return;
    const parts = calleeParts(info.callee);
    const matched = (parts.root !== null && names.has(parts.root)) ||
      (parts.member !== null && names.has(parts.member));
    if (!matched) return;
    out.push({
      caller: enclosingName(visited, root),
      range: symbolRangeOf(visited),
      callee: visited.text,
      root: parts.root,
      member: parts.member,
      isNew: info.isNew,
    });
  });
  return out;
}

const TEST_SUFFIX = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIR = /(^|\/)((__tests__)|(tests?))\//;
const TEST_TOKEN = /(^|[._-])(test|spec)([._-])/i;

export function testFileScore(path: string): number {
  const normalized = path.replaceAll("\\", "/");
  const slash = normalized.lastIndexOf("/");
  const base = slash === -1 ? normalized : normalized.slice(slash + 1);
  if (TEST_SUFFIX.test(base)) return 1;
  if (TEST_DIR.test(normalized)) return 0.6;
  const dot = base.lastIndexOf(".");
  const stem = dot <= 0 ? base : base.slice(0, dot);
  if (TEST_TOKEN.test(stem)) return 0.3;
  return 0;
}
