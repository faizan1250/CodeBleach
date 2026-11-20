import type { Parser, ParseState } from "web-tree-sitter";
import type { Node, Tree } from "web-tree-sitter";
import { ReviewerError } from "../core/errors.ts";
import type { RunBudget } from "./limits.ts";
import { createParser, loadLanguage } from "./runtime.ts";
import type { SupportedLanguage } from "./runtime.ts";

export type ParseSkipReason = "per-file-timeout" | "cumulative-budget" | "run-deadline";

export interface ErrorRange {
  startLine: number;
  endLine: number;
}

export interface ParseResult {
  language: SupportedLanguage;
  filePath: string;
  /** Internal tree handle; never serialize. Caller owns it and must delete it. */
  tree: Tree | null;
  source: string;
  lineCount: number;
  errorCount: number;
  missingCount: number;
  errorRanges: ErrorRange[];
  durationMs: number;
  cancelled: boolean;
  skipReason?: ParseSkipReason | undefined;
}

export interface ParseInput {
  source: string;
  language: SupportedLanguage;
  filePath: string;
  perFileMs: number;
  runBudget?: RunBudget | undefined;
}

// One cached parser per language. Parse calls are synchronous, so sequential
// awaits elsewhere cannot interleave mid-parse; every use resets first.
const parsers = new Map<SupportedLanguage, Parser>();

async function parserFor(language: SupportedLanguage): Promise<Parser> {
  const existing = parsers.get(language);
  if (existing !== undefined) return existing;
  const created = createParser(await loadLanguage(language));
  parsers.set(language, created);
  return created;
}

// web-tree-sitter 0.25.10 types progressCallback as (state) => void but the
// runtime honors a `true` return as cancellation (parse returns null).
// Verified empirically; the boolean return below is load-bearing.
type ProgressCallback = (state: ParseState) => boolean;

function countLines(source: string): number {
  if (source === "") return 0;
  let newlines = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") newlines += 1;
  }
  return source.endsWith("\n") ? newlines : newlines + 1;
}

function collectDiagnostics(root: Node): {
  errorCount: number;
  missingCount: number;
  errorRanges: ErrorRange[];
} {
  let errorCount = 0;
  let missingCount = 0;
  const errorRanges: ErrorRange[] = [];
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    if (node.isError) {
      errorCount += 1;
      errorRanges.push({
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      });
    }
    if (node.isMissing) missingCount += 1;
    for (let index = node.childCount - 1; index >= 0; index -= 1) {
      const child = node.child(index);
      if (child !== null) stack.push(child);
    }
  }
  return { errorCount, missingCount, errorRanges };
}

// Tree-sitter documents positions as byte offsets, but on this pinned stack
// (Bun + web-tree-sitter 0.25.10 + @vscode grammars) node indices align with
// JS UTF-16 string units: slicing the source with them equals `node.text`,
// verified by the emoji fixture test. Slice units, never UTF-8 bytes.
/** Slice by tree-sitter index offsets with out-of-range clamping. */
export function sliceSourceByIndex(source: string, startIndex: number, endIndex: number): string {
  const start = Math.max(0, Math.min(startIndex, source.length));
  const end = Math.max(start, Math.min(endIndex, source.length));
  return source.slice(start, end);
}

function skipped(input: ParseInput, source: string, skipReason: ParseSkipReason): ParseResult {
  return {
    language: input.language,
    filePath: input.filePath,
    tree: null,
    source,
    lineCount: countLines(source),
    errorCount: 0,
    missingCount: 0,
    errorRanges: [],
    durationMs: 0,
    cancelled: true,
    skipReason,
  };
}

function stripBom(source: string): string {
  return source.startsWith("\uFEFF") ? source.slice(1) : source;
}

/** Parse an in-memory UTF-8 source string; no Git snapshot access. */
export async function parseSource(input: ParseInput): Promise<ParseResult> {
  const source = stripBom(input.source);
  const runBudget = input.runBudget;
  const allowance = runBudget?.effectiveParseMs(input.perFileMs) ?? input.perFileMs;
  if (allowance <= 0) {
    const reason: ParseSkipReason = (runBudget?.remainingRunMs() ?? 1) <= 0 ? "run-deadline" : "cumulative-budget";
    return skipped(input, source, reason);
  }

  let parser: Parser;
  try {
    parser = await parserFor(input.language);
  } catch (error) {
    if (error instanceof ReviewerError) throw error;
    throw new ReviewerError({
      code: "PARSE_FAILED",
      message: `tree-sitter parser for ${input.language} failed: ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    });
  }
  parser.reset();
  const startMs = performance.now();
  const onProgress: ProgressCallback = () => {
    if (performance.now() - startMs >= allowance) return true;
    return runBudget !== undefined && runBudget.remainingRunMs() <= 0;
  };
  const tree = parser.parse(source, null, {
    progressCallback: onProgress as (state: ParseState) => void,
  });
  const durationMs = performance.now() - startMs;
  runBudget?.recordParse(durationMs);

  if (tree === null) {
    parser.reset();
    const reason: ParseSkipReason =
      (runBudget?.remainingRunMs() ?? 1) <= 0
        ? "run-deadline"
        : runBudget !== undefined && runBudget.effectiveParseMs(input.perFileMs) <= 0
          ? "cumulative-budget"
          : "per-file-timeout";
    return {
      ...skipped(input, source, reason),
      durationMs,
    };
  }

  const { errorCount, missingCount, errorRanges } = collectDiagnostics(tree.rootNode);
  return {
    language: input.language,
    filePath: input.filePath,
    tree,
    source,
    lineCount: countLines(source),
    errorCount,
    missingCount,
    errorRanges,
    durationMs,
    cancelled: false,
    skipReason: undefined,
  };
}
