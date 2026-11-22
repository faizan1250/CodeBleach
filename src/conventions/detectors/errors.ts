// Error-handling idiom detector (P6-01, plan section 6.3).
//
// Mutually exclusive per-file classification over structural AST signals
// only: no regex matching, no type-name substring search, no assumption that
// every `Result` identifier shares semantics. Emits at most one convention
// (the plurality style; ties emit nothing). Support ratio, evidence minimum,
// and dominance margin are P6-02 gates.

import type { Node } from "web-tree-sitter";
import { CONVENTION_DETECTOR_ERROR_HANDLING, CONVENTION_DETECTOR_ERROR_HANDLING_VERSION } from "../constants.ts";
import { orderSampledFiles, toCandidate } from "./index.ts";
import type { DetectorCandidate, FileMatch, ParsedSampledFile } from "./index.ts";

const RESULT_PATTERN = "The repository predominantly uses typed Result-style error returns.";
const THROW_PATTERN = "The repository predominantly uses throw-style error handling.";

const RESULT_NAMES: ReadonlySet<string> = new Set(["Result", "Either"]);

// Function-like nodes whose own return annotation is a declared error
// contract. Overload/interface signatures and variable type positions (for
// example `const f: () => Result<...>` annotations) are not functions, so
// only these shapes can contribute a result-style signal.
const FUNCTION_NODES: ReadonlySet<string> = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
]);

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

// Structural match for an unqualified Result/Either reference: a bare
// `Result`/`Either` identifier, a generic instantiation of one, or a
// `Promise<...>` wrapping one directly. Qualified names
// (`Foo.Result<...>), unions, arrays, and deeper nestings never match.
function isResultTypeReference(node: Node): boolean {
  if (node.type === "type_identifier") return RESULT_NAMES.has(node.text);
  if (node.type !== "generic_type") return false;
  const name = node.childForFieldName("name");
  if (name === null || name.type !== "type_identifier") return false;
  if (RESULT_NAMES.has(name.text)) return true;
  if (name.text !== "Promise") return false;
  const args = node.childForFieldName("type_arguments");
  if (args === null) return false;
  for (let index = 0; index < args.namedChildCount; index += 1) {
    const arg = args.namedChild(index);
    if (arg !== null && isResultTypeReference(arg)) return true;
  }
  return false;
}

function annotationTarget(returnType: Node): Node | null {
  // Function annotations wrap the type in `type_annotation`; some shapes
  // (function_type return positions) hold it directly.
  if (returnType.type !== "type_annotation") return returnType;
  return returnType.namedChild(0);
}

function earliestSignal(current: LineSpan | null, next: LineSpan): LineSpan {
  if (current === null || next.startLine < current.startLine) return next;
  return current;
}

function isPromiseRejectCall(node: Node): boolean {
  if (node.type !== "call_expression") return false;
  const callee = node.childForFieldName("function");
  if (callee === null || callee.type !== "member_expression") return false;
  const object = callee.childForFieldName("object");
  const property = callee.childForFieldName("property");
  if (object === null || object.type !== "identifier" || object.text !== "Promise") return false;
  if (property === null) return false;
  if (property.type !== "property_identifier" && property.type !== "identifier") return false;
  return property.text === "reject";
}

export function detectErrorHandling(files: readonly ParsedSampledFile[]): DetectorCandidate[] {
  const resultMatches: FileMatch[] = [];
  const throwMatches: FileMatch[] = [];
  let eligibleFiles = 0;
  for (const file of orderSampledFiles(files)) {
    const signals: { result: LineSpan | null; threw: LineSpan | null } = { result: null, threw: null };
    walkNamed(file.tree.rootNode, (node) => {
      if (node.type === "throw_statement" || isPromiseRejectCall(node)) {
        signals.threw = earliestSignal(signals.threw, spanOf(node));
        return;
      }
      if (!FUNCTION_NODES.has(node.type)) return;
      const returnType = node.childForFieldName("return_type");
      if (returnType === null) return;
      const target = annotationTarget(returnType);
      if (target === null || !isResultTypeReference(target)) return;
      signals.result = earliestSignal(signals.result, spanOf(returnType));
    });
    const result: LineSpan | null = signals.result;
    const threw: LineSpan | null = signals.threw;
    if (result === null && threw === null) continue;
    eligibleFiles += 1;
    // Mixed-signal files stay eligible but support neither style.
    if (result !== null && threw === null) {
      resultMatches.push({ path: file.path, startLine: result.startLine, endLine: result.endLine });
    } else if (threw !== null && result === null) {
      throwMatches.push({ path: file.path, startLine: threw.startLine, endLine: threw.endLine });
    }
  }
  const winner =
    resultMatches.length > throwMatches.length
      ? { pattern: RESULT_PATTERN, matches: resultMatches }
      : throwMatches.length > resultMatches.length
        ? { pattern: THROW_PATTERN, matches: throwMatches }
        : null;
  if (winner === null) return [];
  const candidate = toCandidate({
    detector: CONVENTION_DETECTOR_ERROR_HANDLING,
    detectorVersion: CONVENTION_DETECTOR_ERROR_HANDLING_VERSION,
    pattern: winner.pattern,
    matches: winner.matches,
    eligibleFiles,
    sampledFiles: files.length,
  });
  return candidate === null ? [] : [candidate];
}
