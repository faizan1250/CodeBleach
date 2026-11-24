import { createHash } from "node:crypto";
import { normalizeRepoPath } from "../review/normalize.ts";
import type { DiffResult } from "../types/diff.ts";
import type { PrMeta } from "../types/github.ts";
import type { AcceptedValidatedFinding } from "../types/validation.ts";

// Phase 7 comment renderer + target gate (ADR 0045). Pure functions only: no
// Octokit, no network, no logging. The publisher (P7-03) consumes these to
// render bodies, derive posting coordinates, and detect marker collisions.

/**
 * Hard cap on inline comments per PR review run (ADR 0045 D6). Enforced by
 * the publisher as a creation-attempt budget: each comment-create POST
 * consumes one slot (including an ambiguous POST), while an already-present
 * duplicate consumes none.
 */
export const MAX_INLINE_COMMENTS = 10;

/** Marker format version; parsers ignore any other version. */
export const MARKER_VERSION = "v1";

const TITLE_MAX_LENGTH = 200;
const SHORT_FIELD_MAX_LENGTH = 64;
const DESCRIPTION_MAX_LENGTH = 1500;
const SUGGESTION_MAX_LENGTH = 1200;
/** Cap on the model-derived preface; the marker is appended after truncation. */
const PREFACE_MAX_LENGTH = 4000;

/** Canonical identity hashed into a marker; never raw model text. */
export interface MarkerIdentity {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly fingerprint: string;
}

/** Stable SHA-256 key over the canonical tuple (owner, repo, PR number, finding fingerprint). */
export function computeMarkerKey(identity: MarkerIdentity): string {
  const owner = identity.owner.trim().toLowerCase();
  const repo = identity.repo.trim().toLowerCase();
  return createHash("sha256")
    .update(`${owner}\u0000${repo}\u0000${identity.number}\u0000${identity.fingerprint}`)
    .digest("hex");
}

/** Hidden trailing marker carrying the stable key on its own final line. */
export function renderMarker(markerKey: string): string {
  return `<!-- codebleach:finding:${MARKER_VERSION}:${markerKey} -->`;
}

const MARKER_PATTERN = /<!--\s*codebleach:finding:v1:([0-9a-f]{64})\s*-->/g;

/** All v1 marker keys in a comment body; unknown versions and malformed markers never match. */
export function parseMarkerKeys(body: string): string[] {
  const keys: string[] = [];
  for (const match of body.matchAll(MARKER_PATTERN)) {
    const key = match[1];
    if (key !== undefined) keys.push(key);
  }
  return keys;
}

/**
 * Render the comment body for one accepted finding. Only title, severity,
 * category, concise description, and optional suggestion are included — never
 * evidence quotes, source excerpts, or validation internals. All
 * model-supplied text is sanitized (HTML escaped, mentions neutralized, link
 * syntax broken, control characters stripped, length-bounded) so it cannot
 * forge a marker or create clickable links. The marker always closes the body
 * on its own final line.
 */
export function renderCommentBody(finding: AcceptedValidatedFinding, markerKey: string): string {
  const raw = finding.finding;
  const header = `**[${sanitizeModelText(raw.severity.toUpperCase(), SHORT_FIELD_MAX_LENGTH)}] ${sanitizeModelText(raw.title, TITLE_MAX_LENGTH)}**`;
  const preface = [
    header,
    "",
    `Category: ${sanitizeModelText(raw.category, SHORT_FIELD_MAX_LENGTH)}`,
    "",
    sanitizeModelText(raw.description, DESCRIPTION_MAX_LENGTH),
  ];
  if (raw.suggestion !== undefined && raw.suggestion.trim().length > 0) {
    preface.push("", `**Suggested fix:** ${sanitizeModelText(raw.suggestion, SUGGESTION_MAX_LENGTH)}`);
  }
  let body = preface.join("\n");
  if (body.length > PREFACE_MAX_LENGTH) body = `${body.slice(0, PREFACE_MAX_LENGTH)}…`;
  return `${body}\n\n${renderMarker(markerKey)}`;
}

function sanitizeModelText(input: string, maxLength: number): string {
  const truncated = input.length > maxLength ? `${input.slice(0, maxLength)}…` : input;
  const normalized = stripControlCharacters(truncated.replace(/\r\n?/g, "\n"));
  return normalized
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/@/g, "@\u200b")
    .replace(/:\/\//g, ":/\u200b/");
}

// Control characters other than tab and newline never render usefully in
// a comment; drop them by code point so no control-char regex is needed.
function stripControlCharacters(input: string): string {
  let out = "";
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    const isControl = code === 127 || (code < 32 && code !== 9 && code !== 10);
    if (!isControl) out += char;
  }
  return out;
}

/** Stable per-finding gate reasons; the publisher maps these to PublishFailure entries. */
export type CommentTargetReason =
  | "target_head_sha_mismatch"
  | "target_file_not_in_diff"
  | "target_file_skipped"
  | "target_side_not_right"
  | "target_line_invalid"
  | "target_line_not_commentable";

/** Validated posting coordinates: derivedTarget only, never model file/line. */
export interface CommentTarget {
  readonly path: string;
  readonly line: number;
  readonly side: "RIGHT";
  readonly commitId: string;
}

export type CommentTargetResult =
  | { readonly ok: true; readonly target: CommentTarget }
  | { readonly ok: false; readonly reason: CommentTargetReason };

/**
 * Cross-check one candidate against the same-run DiffResult (plan §5.3).
 * Exact path match after canonical normalization; rejects deleted, skipped,
 * non-RIGHT, invalid-line, and non-commentable targets plus SHA drift.
 */
export function validateCommentTarget(
  finding: AcceptedValidatedFinding,
  diff: DiffResult,
  meta: PrMeta,
): CommentTargetResult {
  const wantedFile = normalizeRepoPath(finding.derivedTarget.file);
  const matched =
    wantedFile === null ? undefined : diff.files.find((file) => normalizeRepoPath(file.path) === wantedFile);
  if (matched === undefined) return { ok: false, reason: "target_file_not_in_diff" };
  if (matched.status === "deleted" || matched.skipReason !== undefined) {
    return { ok: false, reason: "target_file_skipped" };
  }
  if (finding.derivedTarget.side !== "RIGHT") return { ok: false, reason: "target_side_not_right" };
  const line = finding.derivedTarget.line;
  if (!Number.isSafeInteger(line) || line < 1) return { ok: false, reason: "target_line_invalid" };
  if (!matched.commentableLines.includes(line)) return { ok: false, reason: "target_line_not_commentable" };
  if (diff.headSha !== meta.headSha) return { ok: false, reason: "target_head_sha_mismatch" };
  return { ok: true, target: { path: matched.path, line, side: "RIGHT", commitId: meta.headSha } };
}

export interface PublishableCandidate {
  readonly finding: AcceptedValidatedFinding;
  readonly target: CommentTarget;
  readonly markerKey: string;
}

export interface IneligibleCandidate {
  readonly finding: AcceptedValidatedFinding;
  readonly reason: CommentTargetReason;
}

export interface PartitionedCandidates {
  readonly eligible: PublishableCandidate[];
  readonly ineligible: IneligibleCandidate[];
}

/**
 * Split candidates into postable and withheld, preserving the pipeline's
 * validated deterministic order. No cap is applied here: duplicate
 * suppression (which consumes no budget) is known only to the publisher after
 * inventory, so the creation-attempt budget stays a P7-03 concern.
 */
export function partitionPublishable(
  findings: readonly AcceptedValidatedFinding[],
  diff: DiffResult,
  meta: PrMeta,
): PartitionedCandidates {
  const eligible: PublishableCandidate[] = [];
  const ineligible: IneligibleCandidate[] = [];
  for (const finding of findings) {
    const gate = validateCommentTarget(finding, diff, meta);
    if (!gate.ok) {
      ineligible.push({ finding, reason: gate.reason });
      continue;
    }
    eligible.push({
      finding,
      target: gate.target,
      markerKey: computeMarkerKey({
        owner: meta.owner,
        repo: meta.repo,
        number: meta.number,
        fingerprint: finding.finding.fingerprint,
      }),
    });
  }
  return { eligible, ineligible };
}

/**
 * Group postable candidates by full marker key. A key mapping to more than
 * one distinct candidate is a same-run collision: the publisher withholds the
 * whole group with `marker_key_collision` and lets none suppress another.
 */
export function groupByMarkerKey(candidates: readonly PublishableCandidate[]): Map<string, PublishableCandidate[]> {
  const groups = new Map<string, PublishableCandidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.markerKey);
    if (group === undefined) {
      groups.set(candidate.markerKey, [candidate]);
    } else {
      group.push(candidate);
    }
  }
  return groups;
}
