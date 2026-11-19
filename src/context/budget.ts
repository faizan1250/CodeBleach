import type { DiffHunk } from "../types/diff.ts";
import type { Rule } from "../types/rules.ts";
import type { ContextItem, UnitSkipReason } from "../types/context.ts";
import { estimateTokens } from "../utils/tokens.ts";

// Hard-cap budgeting for one ReviewUnit. The cap always wins: rules are
// counted but never truncated, hunks are kept whole or not at all, and the
// definition keeps its signature with body truncated at line boundaries.
// No emitted payload exceeds maxTokens per the estimator.

export const FRAMING_RESERVE_TOKENS = 200;

export interface HunkSelection {
  included: DiffHunk[];
  omittedHunkCount: number;
  truncated: boolean;
}

export interface DefinitionTruncation {
  text: string;
  truncated: boolean;
  tokens: number;
}

export interface FitUnitInput {
  path: string;
  symbol: string;
  hunks: DiffHunk[];
  definitionSignature: string;
  definitionBody: string;
  rules: Rule[];
  candidates: ContextItem[];
  maxTokens: number;
}

export interface EmittedFit {
  status: "emit";
  keptRules: Rule[];
  includedHunks: DiffHunk[];
  omittedHunkCount: number;
  diffTruncated: boolean;
  definitionText: string;
  definitionTruncated: boolean;
  includedItems: ContextItem[];
  omittedItemCount: number;
  totalTokens: number;
}

export interface SkippedFit {
  status: "skip";
  reason: Extract<UnitSkipReason, "mandatory-budget-exceeded" | "diff-exceeds-budget">;
  requiredTokens: number;
  maxTokens: number;
}

export type FitOutcome = EmittedFit | SkippedFit;

export function serializeHunk(hunk: DiffHunk): string {
  const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  if (hunk.lines.length === 0) return header;
  const body = hunk.lines
    .map((line) => `${line.kind}:${line.oldLine ?? ""}:${line.newLine ?? ""}:${line.text}`)
    .join("\n");
  return `${header}\n${body}`;
}

export function tokensForRule(rule: Rule): number {
  return estimateTokens(`${rule.id}\n${rule.kind}\n${rule.text}`);
}

export function tokensForDiffIdentity(path: string, hunkCount: number): number {
  return estimateTokens(`diff ${path} ${hunkCount} hunks`);
}

export function tokensForSymbolIdentity(path: string, symbol: string): number {
  return estimateTokens(`symbol ${symbol} in ${path}`);
}

export function selectHunks(hunks: readonly DiffHunk[], budgetTokens: number): HunkSelection {
  const included: DiffHunk[] = [];
  let used = 0;
  for (const hunk of hunks) {
    const cost = estimateTokens(serializeHunk(hunk));
    if (used + cost > budgetTokens) break;
    included.push(hunk);
    used += cost;
  }
  const omittedHunkCount = hunks.length - included.length;
  return { included, omittedHunkCount, truncated: included.length > 0 && omittedHunkCount > 0 };
}

export function truncateDefinition(
  signatureText: string,
  bodyText: string,
  budgetTokens: number,
): DefinitionTruncation {
  const signatureTokens = estimateTokens(signatureText);
  if (bodyText === "") {
    return { text: signatureText, truncated: false, tokens: signatureTokens };
  }
  const fullText = `${signatureText}\n${bodyText}`;
  const fullTokens = estimateTokens(fullText);
  if (fullTokens <= budgetTokens) {
    return { text: fullText, truncated: false, tokens: fullTokens };
  }
  const lines = bodyText.split("\n");
  let text = signatureText;
  let used = signatureTokens;
  for (const line of lines) {
    const cost = estimateTokens(`\n${line}`);
    if (used + cost > budgetTokens) break;
    text += `\n${line}`;
    used += cost;
  }
  return { text, truncated: true, tokens: used };
}

export function fitUnitToBudget(input: FitUnitInput): FitOutcome {
  const ruleTokens = input.rules.reduce((sum, rule) => sum + tokensForRule(rule), 0);
  const signatureTokens = estimateTokens(input.definitionSignature);
  const diffIdentity = tokensForDiffIdentity(input.path, input.hunks.length);
  const symbolIdentity = tokensForSymbolIdentity(input.path, input.symbol);
  const mandatory = FRAMING_RESERVE_TOKENS + ruleTokens + signatureTokens + diffIdentity + symbolIdentity;
  if (mandatory > input.maxTokens) {
    return {
      status: "skip",
      reason: "mandatory-budget-exceeded",
      requiredTokens: mandatory,
      maxTokens: input.maxTokens,
    };
  }
  const hunkBudget = input.maxTokens - mandatory;
  const hunks = selectHunks(input.hunks, hunkBudget);
  if (input.hunks.length > 0 && hunks.included.length === 0) {
    const firstCost = estimateTokens(serializeHunk(input.hunks[0] as DiffHunk));
    return {
      status: "skip",
      reason: "diff-exceeds-budget",
      requiredTokens: mandatory + firstCost,
      maxTokens: input.maxTokens,
    };
  }
  const hunkTokens = hunks.included.reduce((sum, hunk) => sum + estimateTokens(serializeHunk(hunk)), 0);
  const definition = truncateDefinition(
    input.definitionSignature,
    input.definitionBody,
    signatureTokens + (hunkBudget - hunkTokens),
  );
  const bodyExtra = definition.tokens - signatureTokens;
  let remaining = hunkBudget - hunkTokens - bodyExtra;
  const includedItems: ContextItem[] = [];
  for (const candidate of input.candidates) {
    if (candidate.tokens <= remaining) {
      includedItems.push(candidate);
      remaining -= candidate.tokens;
    }
  }
  const totalTokens = input.maxTokens - remaining;
  return {
    status: "emit",
    keptRules: input.rules,
    includedHunks: hunks.included,
    omittedHunkCount: hunks.omittedHunkCount,
    diffTruncated: hunks.truncated,
    definitionText: definition.text,
    definitionTruncated: definition.truncated,
    includedItems,
    omittedItemCount: input.candidates.length - includedItems.length,
    totalTokens,
  };
}
