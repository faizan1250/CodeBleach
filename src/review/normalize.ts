import { createHash, randomUUID } from "node:crypto";
import type { ReviewUnit } from "../types/context.ts";
import type { Finding, RawFinding } from "../types/finding.ts";
import { CODE_REVIEW_PROMPT_VERSION } from "./prompt.ts";

// Repository-relative POSIX path. Null means the model-supplied path is not
// a reviewable repo file and the finding must be rejected.
export function normalizeRepoPath(path: string): string | null {
  if (path.includes("\u0000")) return null;
  const trimmed = path.trim();
  if (trimmed.length === 0) return null;
  let posix = trimmed.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (posix.startsWith("./")) posix = posix.slice(2);
  if (posix.startsWith("/")) return null;
  if (/^[A-Za-z]:/.test(posix)) return null;
  const out: string[] = [];
  for (const segment of posix.split("/")) {
    if (segment === ".") continue;
    if (segment === "" || segment === "..") return null;
    out.push(segment);
  }
  if (out.length === 0) return null;
  return out.join("/");
}

// Stored title keeps model casing; only surrounding/duplicate whitespace is
// collapsed so equivalent reports share one display form.
export function normalizeTitleStorage(title: string): string {
  return title.trim().replace(/\s+/g, " ");
}

export function fingerprintForFinding(input: {
  file: string;
  symbol: string;
  category: string;
  title: string;
}): string {
  const fallback = input.file.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^(?:\.\/)+/, "");
  const normalizedFile = normalizeRepoPath(input.file) ?? fallback;
  const normalizedTitle = normalizeTitleStorage(input.title).toLowerCase();
  return createHash("sha1")
    .update(`${normalizedFile}\u0000${input.symbol}\u0000${input.category}\u0000${normalizedTitle}`)
    .digest("hex");
}

export interface NormalizeContext {
  unit: ReviewUnit;
  headSha: string;
  pass?: string | undefined;
  generateId?: (() => string) | undefined;
}

// Strict Phase 4 normalization. Returns null when the raw finding must not
// become a Finding: bad path, unknown ruleId, or blank quote/title.
export function normalizeFinding(raw: RawFinding, ctx: NormalizeContext): Finding | null {
  const file = normalizeRepoPath(raw.file);
  if (file === null) return null;
  const title = normalizeTitleStorage(raw.title);
  if (title.length === 0) return null;
  if (raw.ruleId !== undefined && !ctx.unit.rules.some((rule) => rule.id === raw.ruleId)) {
    return null;
  }
  const evidence: Finding["evidence"] = [];
  for (const item of raw.evidence) {
    const evidenceFile = normalizeRepoPath(item.file);
    if (evidenceFile === null) return null;
    if (item.quote.trim().length === 0) return null;
    evidence.push({
      file: evidenceFile,
      startLine: item.startLine,
      endLine: item.endLine,
      quote: item.quote,
    });
  }
  if (evidence.length === 0) return null;
  const generateId = ctx.generateId ?? randomUUID;
  return {
    title,
    severity: raw.severity,
    category: raw.category,
    file,
    line: raw.line,
    ...(raw.endLine === undefined ? {} : { endLine: raw.endLine }),
    description: raw.description,
    ...(raw.suggestion === undefined ? {} : { suggestion: raw.suggestion }),
    confidence: raw.confidence,
    evidence,
    introducedByPr: raw.introducedByPr,
    ...(raw.ruleId === undefined ? {} : { ruleId: raw.ruleId }),
    id: generateId(),
    fingerprint: fingerprintForFinding({
      file,
      symbol: ctx.unit.symbol.name,
      category: raw.category,
      title,
    }),
    headSha: ctx.headSha,
    symbol: ctx.unit.symbol.name,
    origin: { pass: ctx.pass ?? CODE_REVIEW_PROMPT_VERSION, unitId: ctx.unit.id },
  };
}
