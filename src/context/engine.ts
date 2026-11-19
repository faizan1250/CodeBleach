import { createHash } from "node:crypto";
import { DEFAULT_MAX_PARSE_TIME_MS } from "../config/defaults.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { ContextEngine } from "../core/contracts.ts";
import { ReviewerError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type {
  ChangedFile,
  ChangedSymbol,
  DiffHunk,
  DiffResult,
  SymbolKind,
} from "../types/diff.ts";
import type {
  ContextBuildDiagnostics,
  ContextBuildResult,
  ContextDiagnostic,
  ContextDiagnosticStage,
  ContextItem,
  ReviewUnit,
  ReviewUnitDiff,
  ReviewUnitFile,
  UnitSkip,
} from "../types/context.ts";
import type { Rule } from "../types/rules.ts";
import { fitUnitToBudget } from "./budget.ts";
import { resolveCalleesForSymbol } from "./calls.ts";
import { resolveCallersForSymbol } from "./callers.ts";
import { resolveImportsForFile } from "./imports.ts";
import type { Definition, TypeDefinition } from "./language.ts";
import { RunBudget } from "./limits.ts";
import { ParseCache } from "./parse-cache.ts";
import type { ParseSkipReason } from "./parser.ts";
import { selectRulesForFile } from "./rules.ts";
import { rankContextItems, scoreItem } from "./rank.ts";
import type { RankInput, RankProximity } from "./rank.ts";
import { SnapshotReader } from "./snapshot.ts";
import { isGitTimeout } from "./snapshot.ts";
import { MODULE_SYMBOL_NAME, mapChangedSymbolsForFile } from "./symbols.ts";
import { resolveTestsForSymbol } from "./tests.ts";
import { estimateTokens } from "../utils/tokens.ts";
import { detectLanguage } from "../diff/paths.ts";

// Real ContextEngine (P3-11): one ReviewUnit per AST-derived ChangedSymbol,
// budgeted by fitUnitToBudget, persisted as ContextBuildResult. Reads exact
// commit snapshots only; never the working tree; never mutates DiffResult.

export interface ContextEngineResolvers {
  resolveCalleesForSymbol?: typeof resolveCalleesForSymbol | undefined;
  resolveCallersForSymbol?: typeof resolveCallersForSymbol | undefined;
  resolveTestsForSymbol?: typeof resolveTestsForSymbol | undefined;
  resolveImportsForFile?: typeof resolveImportsForFile | undefined;
}

export interface ContextEngineDeps {
  logger: Logger;
  resolvers?: ContextEngineResolvers | undefined;
}

// Bounded engine diagnostics: one entry per failed retrieval site, never
// source text, messages, or secrets. Static reasons + error codes only.
const MAX_CONTEXT_DIAGNOSTICS = 100;
const NON_FATAL_DIAGNOSTIC_CODES = new Set(["cap-reached", "budget-exceeded", "parse-cancelled"]);

function truncateDiagnosticText(value: string): string {
  return value.length <= 200 ? value : value.slice(0, 200);
}

function errorCodeOf(error: unknown): string {
  return error instanceof ReviewerError ? error.code : "INTERNAL";
}

function gitFailureReasonOf(error: unknown): "timeout" | "transport-output-limit" | "abort" | null {
  if (error instanceof ReviewerError) {
    const cause = error.cause as { reason?: unknown } | null | undefined;
    if (typeof cause === "object" && cause !== null && "reason" in cause) {
      const reason = (cause as { reason: unknown }).reason;
      if (reason === "timeout") return "timeout";
      if (reason === "output-limit") return "transport-output-limit";
      if (reason === "abort") return "abort";
    }
  }
  return null;
}

function throwDiagnosticCode(error: unknown, runBudget: RunBudget | undefined, fallback: string): string {
  if (runBudget !== undefined && runBudget.remainingRunMs() <= 0) return "deadline";
  const gitReason = gitFailureReasonOf(error);
  if (gitReason === "timeout") return "timeout";
  if (gitReason === "transport-output-limit") return "transport-output-limit";
  return fallback;
}

function parseSkipDiagnosticCode(skipReason: ParseSkipReason | undefined, runBudget: RunBudget | undefined): string {
  if (skipReason === "run-deadline" || (runBudget !== undefined && runBudget.remainingRunMs() <= 0)) return "deadline";
  if (skipReason === "cumulative-budget") return "budget-exceeded";
  if (skipReason === "per-file-timeout") return "timeout";
  return "parse-cancelled";
}

function hash12(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

export function stableUnitId(
  headSha: string,
  path: string,
  kind: SymbolKind,
  container: string | undefined,
  name: string,
  startLine: number,
): string {
  return `ctx-${hash12(`${headSha}${"\0"}${path}${"\0"}${kind}:${container ?? ""}:${name}:${startLine}`)}`;
}

export function stableItemId(unitId: string, kind: string, file: string, startLine: number): string {
  return `${unitId}-${hash12(`${kind}${"\0"}${file}${"\0"}${startLine}`)}`;
}

export function toReviewUnitFile(file: ChangedFile): ReviewUnitFile {
  return {
    path: file.path,
    oldPath: file.oldPath,
    status: file.status,
    language: file.language,
    commentableLines: [...file.commentableLines],
  };
}

export function relevantHunksForSymbol(file: ChangedFile, symbol: ChangedSymbol): DiffHunk[] {
  const added = new Set(symbol.changedLines);
  const deleted = new Set(symbol.deletedLines ?? []);
  if (added.size === 0 && deleted.size === 0) return [];
  return file.hunks.filter((hunk) => {
    for (const line of hunk.lines) {
      if (line.kind === "add" && line.newLine !== null && added.has(line.newLine)) return true;
      if (line.kind === "del" && line.oldLine !== null && deleted.has(line.oldLine)) return true;
    }
    return false;
  });
}

function hasContentChanges(file: ChangedFile): boolean {
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add" || line.kind === "del") return true;
    }
  }
  return false;
}

function countHeadLines(source: string): number {
  if (source === "") return 0;
  let newlines = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") newlines += 1;
  }
  return source.endsWith("\n") ? newlines : newlines + 1;
}

function nearbyHeadText(source: string, file: ChangedFile, maxLines = 30, contextLines = 15): string {
  const lines = source.split("\n");
  if (lines.length === 0) return "";
  let anchor: number | null = null;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if ((line.kind === "add" || line.kind === "ctx") && line.newLine !== null) {
        anchor = anchor === null ? line.newLine : Math.min(anchor, line.newLine);
      }
    }
  }
  const center = anchor ?? 1;
  const from = Math.max(1, center - contextLines);
  const to = Math.min(lines.length, from + maxLines - 1);
  const adjustedFrom = Math.max(1, Math.min(from, Math.max(1, to - maxLines + 1)));
  return lines.slice(adjustedFrom - 1, to).join("\n");
}

function splitSignatureBody(fullText: string, signatureText: string): { signature: string; body: string } {
  if (fullText === signatureText) return { signature: signatureText, body: "" };
  if (fullText.startsWith(signatureText)) {
    return { signature: signatureText, body: fullText.slice(signatureText.length).replace(/^\r?\n/, "") };
  }
  return { signature: signatureText, body: fullText };
}

function typeSignatureBody(text: string): { signature: string; body: string } {
  const lines = text.split("\n");
  const signature = lines[0] ?? text;
  const body = lines.slice(1).join("\n");
  return { signature, body };
}

interface DefinitionText {
  signature: string;
  body: string;
}

function findDefinitionText(
  definitions: readonly Definition[],
  types: readonly TypeDefinition[],
  symbol: ChangedSymbol,
): DefinitionText | null {
  if (symbol.kind === "type") {
    const sameTypes = types.filter((type) => type.name === symbol.name);
    const picked =
      sameTypes.length === 1
        ? sameTypes[0]
        : (sameTypes.find((type) => type.range.startLine === symbol.startLine) ?? sameTypes[0]);
    if (picked !== undefined) return typeSignatureBody(picked.text);
    const sameDefs = definitions.filter(
      (definition) => definition.kind === "type" && definition.name === symbol.name,
    );
    const pickedDef =
      sameDefs.length === 1
        ? sameDefs[0]
        : (sameDefs.find((definition) => definition.fullRange.startLine === symbol.startLine) ?? sameDefs[0]);
    if (pickedDef !== undefined) return splitSignatureBody(pickedDef.fullText, pickedDef.signatureText);
    return null;
  }
  if (symbol.kind === "module") return null;
  const same = definitions.filter(
    (definition) =>
      definition.name === symbol.name &&
      definition.kind === symbol.kind &&
      (definition.container ?? undefined) === (symbol.container ?? undefined),
  );
  const picked =
    same.length === 1
      ? same[0]
      : (same.find((definition) => definition.fullRange.startLine === symbol.startLine) ?? same[0]);
  if (picked === undefined) return null;
  return splitSignatureBody(picked.fullText, picked.signatureText);
}

export class ContextEngineImpl implements ContextEngine {
  private readonly logger: Logger;
  private readonly calleesResolver: typeof resolveCalleesForSymbol;
  private readonly callersResolver: typeof resolveCallersForSymbol;
  private readonly testsResolver: typeof resolveTestsForSymbol;
  private readonly importsResolver: typeof resolveImportsForFile;

  constructor(deps: ContextEngineDeps) {
    const logger = (deps as ContextEngineDeps | null | undefined)?.logger;
    if (
      logger === null ||
      logger === undefined ||
      typeof logger.debug !== "function" ||
      typeof logger.info !== "function" ||
      typeof logger.warn !== "function" ||
      typeof logger.error !== "function"
    ) {
      throw new ReviewerError({
        code: "INTERNAL",
        message: "ContextEngineImpl requires a logger with debug/info/warn/error methods",
      });
    }
    this.logger = logger;
    const resolvers = (deps as ContextEngineDeps | null | undefined)?.resolvers ?? {};
    this.calleesResolver = resolvers.resolveCalleesForSymbol ?? resolveCalleesForSymbol;
    this.callersResolver = resolvers.resolveCallersForSymbol ?? resolveCallersForSymbol;
    this.testsResolver = resolvers.resolveTestsForSymbol ?? resolveTestsForSymbol;
    this.importsResolver = resolvers.resolveImportsForFile ?? resolveImportsForFile;
  }

  async build(
    diff: DiffResult,
    config: ResolvedConfig,
    repoDir: string,
  ): Promise<ContextBuildResult> {
    const started = performance.now();
    const perFileMs = config.context.max_parse_time_ms ?? DEFAULT_MAX_PARSE_TIME_MS;
    const runBudget = new RunBudget({
      maxRunMs: config.context.max_run_time_ms,
      maxTotalParseMs: config.context.max_total_parse_time_ms,
    });
    const reader = new SnapshotReader({
      repoRoot: repoDir,
      headSha: diff.headSha,
      mergeBase: diff.mergeBase,
      runBudget,
    });
    // One parsed snapshot per unique (commit, path, language) for this run:
    // head and base stay separate through distinct commit SHAs. Entries hold
    // plain extraction data only (never Tree handles), so the map is dropped
    // at run end; a throw still frees it via GC with nothing native to leak.
    const parseCache = new ParseCache();
    const maxTokens = config.context.max_tokens_per_unit;

    const units: ReviewUnit[] = [];
    const unitsSkipped: UnitSkip[] = [];
    const engineDiagnostics: ContextDiagnostic[] = [];
    const seenDiagnosticKeys = new Set<string>();
    const pushDiagnostic = (
      stage: ContextDiagnosticStage,
      path: string,
      symbol: string | undefined,
      code: string,
      reason: string,
    ): void => {
      const safePath = truncateDiagnosticText(path);
      const safeSymbol = symbol === undefined ? undefined : truncateDiagnosticText(symbol);
      const key = `${stage}${"\0"}${safePath}${"\0"}${safeSymbol ?? ""}${"\0"}${code}`;
      if (seenDiagnosticKeys.has(key)) return;
      seenDiagnosticKeys.add(key);
      if (engineDiagnostics.length >= MAX_CONTEXT_DIAGNOSTICS) return;
      if (safeSymbol === undefined) {
        engineDiagnostics.push({ stage, path: safePath, code, reason });
      } else {
        engineDiagnostics.push({ stage, path: safePath, symbol: safeSymbol, code, reason });
      }
    };
    const mergeUnitDiagnostics = (items: readonly ContextDiagnostic[]): void => {
      for (const item of items) pushDiagnostic(item.stage, item.path, item.symbol, item.code, item.reason);
    };
    let filesParsed = 0;
    let filesParseTimedOut = 0;
    let unitsWithTruncatedDiff = 0;
    let unitsWithTruncatedDefinition = 0;
    let candidateFilesSkippedByCap = 0;
    let parseBudgetExceeded = false;
    let deadlineExceeded = false;
    // Actual timed-out Git subprocess queries only: +1 per engine-observed
    // timeout throw. Git runs single-attempt with no retry, and each throw is
    // caught exactly once below, so the count is the number of timed-out Git
    // calls. Parse cancellations (filesParseTimedOut) and non-timeout Git
    // failures never increment it.
    let queryTimeouts = 0;

    const filesConsidered = diff.files.length;
    const importCache = new Map<string, Awaited<ReturnType<typeof resolveImportsForFile>>>();
    const pushPendingFrom = (startIndex: number): void => {
      for (let rest = startIndex; rest < diff.files.length; rest += 1) {
        const restFile = diff.files[rest];
        if (restFile === undefined) continue;
        unitsSkipped.push({ path: restFile.path, symbol: "<pending>", reason: "run-deadline" });
      }
    };

    for (let index = 0; index < diff.files.length; index += 1) {
      const file = diff.files[index];
      if (file === undefined) continue;
      if (runBudget.remainingRunMs() <= 0) {
        deadlineExceeded = true;
        pushPendingFrom(index);
        break;
      }
      if (file.skipReason !== undefined) continue;
      if (!hasContentChanges(file)) continue;
      if (file.status === "deleted") continue;

      let symbols: ChangedSymbol[];
      try {
        symbols = await mapChangedSymbolsForFile({ file, reader, perFileMs, runBudget, parseCache });
      } catch (error) {
        if (isGitTimeout(error)) queryTimeouts += 1;
        const code = errorCodeOf(error);
        pushDiagnostic(
          "snapshot",
          file.path,
          undefined,
          throwDiagnosticCode(error, runBudget, "symbol-mapping-failed"),
          `symbol mapping failed (${code})`,
        );
        this.logger.warn("context file skipped", {
          path: file.path,
          code: error instanceof ReviewerError ? error.code : "UNKNOWN",
        });
        if (runBudget.remainingRunMs() <= 0) {
          deadlineExceeded = true;
          pushPendingFrom(index);
          break;
        }
        continue;
      }
      if (symbols.length === 0) continue;

      let headText: string | null = null;
      let headDefinitions: Definition[] = [];
      let headTypes: TypeDefinition[] = [];
      let definitionParseCancelled = false;
      if (file.language !== null) {
        try {
          headText = await reader.readHeadText(file.path);
        } catch (error) {
          if (isGitTimeout(error)) queryTimeouts += 1;
          const code = errorCodeOf(error);
          pushDiagnostic(
            "snapshot",
            file.path,
            undefined,
            throwDiagnosticCode(error, runBudget, "snapshot-read-failed"),
            `head snapshot read failed (${code})`,
          );
          headText = null;
        }
        if (headText !== null) {
          const language = detectLanguage(file.path);
          if (language !== null) {
            const cached = await parseCache.getOrParse({
              commit: reader.headSha,
              path: file.path,
              source: headText,
              language,
              perFileMs,
              runBudget,
            });
            if (cached.status === "cancelled") {
              definitionParseCancelled = true;
              filesParseTimedOut += 1;
              pushDiagnostic(
                "parse",
                file.path,
                undefined,
                parseSkipDiagnosticCode(cached.skipReason, runBudget),
                `definition parse cancelled (${cached.skipReason})`,
              );
              if (cached.skipReason === "cumulative-budget" || cached.skipReason === "run-deadline") {
                parseBudgetExceeded = cached.skipReason === "cumulative-budget" || runBudget.remainingRunMs() <= 0;
                if (runBudget.remainingRunMs() <= 0) deadlineExceeded = true;
              }
            } else {
              // Cache hits reuse the symbols-stage parse without consuming budget.
              if (!cached.hit) filesParsed += 1;
              headDefinitions = cached.snapshot.definitions;
              headTypes = cached.snapshot.types;
            }
          }
        }
      } else {
        try {
          headText = await reader.readHeadText(file.path);
        } catch (error) {
          if (isGitTimeout(error)) queryTimeouts += 1;
          const code = errorCodeOf(error);
          pushDiagnostic(
            "snapshot",
            file.path,
            undefined,
            throwDiagnosticCode(error, runBudget, "snapshot-read-failed"),
            `head snapshot read failed (${code})`,
          );
          headText = null;
        }
      }

      let imports = importCache.get(file.path);
      if (imports === undefined && file.language !== null) {
        try {
          imports = await this.importsResolver({ importerPath: file.path, reader, perFileMs, runBudget, parseCache });
        } catch (error) {
          if (isGitTimeout(error)) queryTimeouts += 1;
          const code = errorCodeOf(error);
          pushDiagnostic(
            "import",
            file.path,
            undefined,
            throwDiagnosticCode(error, runBudget, "import-failed"),
            `import resolution failed (${code})`,
          );
          imports = { resolved: [], diagnostics: [] };
        }
        importCache.set(file.path, imports);
      }

      for (let symbolIndex = 0; symbolIndex < symbols.length; symbolIndex += 1) {
        const symbol = symbols[symbolIndex];
        if (symbol === undefined) continue;
        if (runBudget.remainingRunMs() <= 0) {
          deadlineExceeded = true;
          for (let rest = symbolIndex; rest < symbols.length; rest += 1) {
            const restSymbol = symbols[rest];
            if (restSymbol === undefined) continue;
            unitsSkipped.push({ path: file.path, symbol: restSymbol.name, reason: "run-deadline" });
          }
          break;
        }
        try {
          const built = await this.buildUnit({
            diff,
            file,
            symbol,
            headText,
            headDefinitions,
            headTypes,
            definitionParseCancelled,
            imports: imports?.resolved ?? [],
            rules: selectRulesForFile(config.rules, file.path),
            maxTokens,
            reader,
            perFileMs,
            runBudget,
            parseCache,
            noteGitTimeout: () => {
              queryTimeouts += 1;
            },
          });
          if (built.status === "emit") {
            units.push(built.unit);
            if (built.unit.diff.truncated) unitsWithTruncatedDiff += 1;
            if (built.definitionTruncated) unitsWithTruncatedDefinition += 1;
            candidateFilesSkippedByCap += built.capSkipped;
            mergeUnitDiagnostics(built.diagnostics);
          } else {
            unitsSkipped.push({
              path: file.path,
              symbol: symbol.name,
              reason: built.reason,
              requiredTokens: built.requiredTokens,
              maxTokens,
            });
            if (built.reason === "parse-cancelled" || built.reason === "parse-budget-exceeded") {
              filesParseTimedOut += 1;
            }
          }
        } catch (error) {
          if (isGitTimeout(error)) queryTimeouts += 1;
          const code = errorCodeOf(error);
          pushDiagnostic(
            "snapshot",
            file.path,
            symbol.name,
            throwDiagnosticCode(error, runBudget, "unit-failed"),
            `unit build failed (${code})`,
          );
          this.logger.warn("context symbol skipped", {
            path: file.path,
            symbol: symbol.name,
            code: error instanceof ReviewerError ? error.code : "UNKNOWN",
          });
        }
      }
      if (deadlineExceeded) {
        pushPendingFrom(index + 1);
        break;
      }
    }

    const elapsedMs = performance.now() - started;
    if (runBudget.remainingRunMs() <= 0) deadlineExceeded = true;
    const hasIssue =
      deadlineExceeded ||
      parseBudgetExceeded ||
      engineDiagnostics.length > 0 ||
      unitsSkipped.length > 0 ||
      candidateFilesSkippedByCap > 0 ||
      filesParseTimedOut > 0 ||
      queryTimeouts > 0;
    let status: ContextBuildResult["status"];
    if (!hasIssue) {
      status = "complete";
    } else if (units.length > 0) {
      status = "partial";
    } else if (deadlineExceeded || parseBudgetExceeded) {
      status = "partial";
    } else if (engineDiagnostics.some((entry) => !NON_FATAL_DIAGNOSTIC_CODES.has(entry.code))) {
      status = "failed";
    } else {
      status = "partial";
    }
    const diagnostics: ContextBuildDiagnostics = {
      elapsedMs,
      deadlineExceeded,
      parseBudgetExceeded,
      filesConsidered,
      filesParsed,
      filesParseTimedOut,
      unitsCreated: units.length,
      unitsSkipped,
      unitsWithTruncatedDiff,
      unitsWithTruncatedDefinition,
      candidateFilesSkippedByCap,
      queryTimeouts,
      parseCacheHits: parseCache.stats().hits,
      parseCacheMisses: parseCache.stats().misses,
      parseCacheEntries: parseCache.stats().entries,
      diagnostics: engineDiagnostics,
    };
    parseCache.clear();
    this.logger.info("context complete", {
      headSha: diff.headSha,
      filesConsidered,
      unitsCreated: units.length,
      unitsSkipped: unitsSkipped.length,
      status,
      elapsedMs,
    });
    return { units, status, diagnostics };
  }

  private async buildUnit(input: {
    diff: DiffResult;
    file: ChangedFile;
    symbol: ChangedSymbol;
    headText: string | null;
    headDefinitions: readonly Definition[];
    headTypes: readonly TypeDefinition[];
    definitionParseCancelled: boolean;
    imports: Awaited<ReturnType<typeof resolveImportsForFile>>["resolved"];
    rules: Rule[];
    maxTokens: number;
    reader: SnapshotReader;
    perFileMs: number;
    runBudget: RunBudget;
    parseCache: ParseCache;
    noteGitTimeout: () => void;
  }): Promise<
    | { status: "emit"; unit: ReviewUnit; definitionTruncated: boolean; capSkipped: number; diagnostics: ContextDiagnostic[] }
    | { status: "skip"; reason: UnitSkip["reason"]; requiredTokens: number }
  > {
    const { diff, file, symbol } = input;
    const relevantHunks = relevantHunksForSymbol(file, symbol);
    if (relevantHunks.length === 0 && symbol.kind !== "module") {
      this.logger.warn("context hunk fallback", { path: file.path, symbol: symbol.name });
    }
    const hunks = relevantHunks.length > 0 ? relevantHunks : file.hunks;

    let signature: string;
    let body: string;
    if (symbol.kind === "module" || file.language === null || input.definitionParseCancelled) {
      signature = symbol.kind === "module" ? `<module> ${file.path}` : `${symbol.name} in ${file.path}`;
      const fallback = input.headText === null ? "" : nearbyHeadText(input.headText, file);
      body = fallback;
    } else {
      const found = findDefinitionText(input.headDefinitions, input.headTypes, symbol);
      if (found === null) {
        signature = `${symbol.name} in ${file.path}`;
        body = input.headText === null ? "" : nearbyHeadText(input.headText, file);
      } else {
        signature = found.signature;
        body = found.body;
      }
    }

    const candidates: RankInput[] = [];
    const pushCandidate = (item: ContextItem, proximity: RankProximity, refCount = 1): void => {
      candidates.push({ item, proximity, refCount });
    };

    for (const resolved of input.imports) {
      if (resolved.definition === null) continue;
      const target = resolved.definition;
      const isType = !("identityKey" in target);
      const kind = isType ? ("type" as const) : ("definition" as const);
      const startLine = isType ? target.range.startLine : target.fullRange.startLine;
      const endLine = isType ? target.range.endLine : target.fullRange.endLine;
      const text = isType ? target.text : target.fullText;
      const tokens = estimateTokens(text);
      const unitIdPreview = stableUnitId(diff.headSha, file.path, symbol.kind, symbol.container, symbol.name, symbol.startLine);
      pushCandidate(
        {
          id: stableItemId(unitIdPreview, kind, resolved.targetPath, startLine),
          kind,
          file: resolved.targetPath,
          startLine,
          endLine,
          text,
          score: 0,
          tokens,
          reason: resolved.reason,
        },
        "direct-import",
      );
    }

    let capSkipped = 0;
    const unitDiagnostics: ContextDiagnostic[] = [];
    try {
      const callees = await this.calleesResolver({
        filePath: file.path,
        symbol,
        reader: input.reader,
        perFileMs: input.perFileMs,
        runBudget: input.runBudget,
        parseCache: input.parseCache,
      });
      for (const callee of callees.callees) {
        const tokens = estimateTokens(callee.text);
        const unitIdPreview = stableUnitId(diff.headSha, file.path, symbol.kind, symbol.container, symbol.name, symbol.startLine);
        const proximity: RankProximity =
          callee.path === file.path ? "same-file" : callee.reason.includes("import") ? "direct-import" : "other";
        pushCandidate(
          {
            id: stableItemId(unitIdPreview, "callee", callee.path, callee.startLine),
            kind: "callee",
            file: callee.path,
            startLine: callee.startLine,
            endLine: callee.endLine,
            text: callee.text,
            score: 0,
            tokens,
            reason: callee.reason,
          },
          proximity,
        );
      }
      capSkipped += callees.diagnostics.filter((diagnostic) => diagnostic.reason === "cap-reached").length;
      for (const diagnostic of callees.diagnostics) {
        if (diagnostic.reason === "parse-cancelled") {
          unitDiagnostics.push({ stage: "callee", path: file.path, symbol: symbol.name, code: "parse-cancelled", reason: "callee parse cancelled" });
        } else if (diagnostic.reason === "cap-reached") {
          unitDiagnostics.push({ stage: "callee", path: file.path, symbol: symbol.name, code: "cap-reached", reason: "callee cap reached" });
        }
      }
    } catch (error) {
      if (isGitTimeout(error)) input.noteGitTimeout();
      const code = errorCodeOf(error);
      unitDiagnostics.push({
        stage: "callee",
        path: file.path,
        symbol: symbol.name,
        code: throwDiagnosticCode(error, input.runBudget, "callee-failed"),
        reason: `callee resolution failed (${code})`,
      });
    }

    try {
      const callers = await this.callersResolver({
        filePath: file.path,
        symbol,
        reader: input.reader,
        perFileMs: input.perFileMs,
        runBudget: input.runBudget,
        parseCache: input.parseCache,
      });
      for (const caller of callers.callers) {
        const tokens = estimateTokens(caller.callerText);
        const unitIdPreview = stableUnitId(diff.headSha, file.path, symbol.kind, symbol.container, symbol.name, symbol.startLine);
        pushCandidate(
          {
            id: stableItemId(unitIdPreview, "caller", caller.path, caller.callerStartLine),
            kind: "caller",
            file: caller.path,
            startLine: caller.callerStartLine,
            endLine: caller.callerEndLine,
            text: caller.callerText,
            score: 0,
            tokens,
            reason: caller.reason,
          },
          caller.path === file.path ? "same-file" : "cross-file-caller",
        );
      }
      capSkipped += callers.diagnostics.filter((diagnostic) => diagnostic.reason === "cap-reached").length;
      for (const diagnostic of callers.diagnostics) {
        if (diagnostic.reason === "parse-cancelled") {
          unitDiagnostics.push({ stage: "caller", path: file.path, symbol: symbol.name, code: "parse-cancelled", reason: "caller parse cancelled" });
        } else if (diagnostic.reason === "cap-reached") {
          unitDiagnostics.push({ stage: "caller", path: file.path, symbol: symbol.name, code: "cap-reached", reason: "caller cap reached" });
        }
      }
    } catch (error) {
      if (isGitTimeout(error)) input.noteGitTimeout();
      const code = errorCodeOf(error);
      unitDiagnostics.push({
        stage: "caller",
        path: file.path,
        symbol: symbol.name,
        code: throwDiagnosticCode(error, input.runBudget, "caller-failed"),
        reason: `caller resolution failed (${code})`,
      });
    }

    try {
      const tests = await this.testsResolver({
        filePath: file.path,
        symbol,
        reader: input.reader,
        perFileMs: input.perFileMs,
        runBudget: input.runBudget,
        parseCache: input.parseCache,
      });
      for (const testSite of tests.tests) {
        const tokens = estimateTokens(testSite.text);
        const unitIdPreview = stableUnitId(diff.headSha, file.path, symbol.kind, symbol.container, symbol.name, symbol.startLine);
        pushCandidate(
          {
            id: stableItemId(unitIdPreview, "test", testSite.path, testSite.startLine),
            kind: "test",
            file: testSite.path,
            startLine: testSite.startLine,
            endLine: testSite.endLine,
            text: testSite.text,
            score: 0,
            tokens,
            reason: testSite.reason,
          },
          testSite.proximity,
        );
      }
      capSkipped += tests.diagnostics.filter((diagnostic) => diagnostic.reason === "cap-reached").length;
      for (const diagnostic of tests.diagnostics) {
        if (diagnostic.reason === "parse-cancelled") {
          unitDiagnostics.push({ stage: "test", path: file.path, symbol: symbol.name, code: "parse-cancelled", reason: "test parse cancelled" });
        } else if (diagnostic.reason === "cap-reached") {
          unitDiagnostics.push({ stage: "test", path: file.path, symbol: symbol.name, code: "cap-reached", reason: "test cap reached" });
        }
      }
    } catch (error) {
      if (isGitTimeout(error)) input.noteGitTimeout();
      const code = errorCodeOf(error);
      unitDiagnostics.push({
        stage: "test",
        path: file.path,
        symbol: symbol.name,
        code: throwDiagnosticCode(error, input.runBudget, "test-failed"),
        reason: `test resolution failed (${code})`,
      });
    }

    const ranked = rankContextItems(candidates);
    const outcome = fitUnitToBudget({
      path: file.path,
      symbol: symbol.name,
      hunks,
      definitionSignature: signature,
      definitionBody: body,
      rules: input.rules,
      candidates: ranked,
      maxTokens: input.maxTokens,
    });
    if (outcome.status === "skip") {
      return { status: "skip", reason: outcome.reason, requiredTokens: outcome.requiredTokens };
    }

    const unitId = stableUnitId(diff.headSha, file.path, symbol.kind, symbol.container, symbol.name, symbol.startLine);
    const definitionTokens = estimateTokens(outcome.definitionText);
    const definitionItem: ContextItem = {
      id: stableItemId(unitId, "definition", file.path, symbol.startLine),
      kind: "definition",
      file: file.path,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      text: outcome.definitionText,
      score: scoreItem("definition", "same-file"),
      tokens: definitionTokens,
      reason: "changed symbol definition",
    };
    const unit: ReviewUnit = {
      id: unitId,
      file: toReviewUnitFile(file),
      diff: {
        hunks: outcome.includedHunks,
        originalHunkCount: hunks.length,
        includedHunkCount: outcome.includedHunks.length,
        omittedHunkCount: outcome.omittedHunkCount,
        truncated: outcome.diffTruncated,
      } satisfies ReviewUnitDiff,
      symbol,
      context: [definitionItem, ...outcome.includedItems],
      rules: outcome.keptRules,
    };
    return { status: "emit", unit, definitionTruncated: outcome.definitionTruncated, capSkipped, diagnostics: unitDiagnostics };
  }
}
