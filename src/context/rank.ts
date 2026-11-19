import type { ContextItem } from "../types/context.ts";

// Deterministic relevance ranking for context candidates. Scores combine a
// base kind weight, a proximity multiplier, and a reference-count decay so
// ubiquitous symbols cannot flood a unit. Ties break by kind priority, path,
// start line, then stable id. No I/O, no randomness.

export const BASE_WEIGHTS = {
  definition: 100,
  type: 85,
  callee: 75,
  caller: 65,
  test: 55,
} as const;

export const PROXIMITY_MULTIPLIERS = {
  "same-file": 1,
  "direct-import": 0.85,
  "cross-file-caller": 0.75,
  "same-dir-test": 0.55,
  other: 0.5,
} as const;

export type RankProximity = keyof typeof PROXIMITY_MULTIPLIERS;

export interface RankInput {
  item: ContextItem;
  proximity: RankProximity;
  refCount?: number | undefined;
}

const KIND_PRIORITY: Record<ContextItem["kind"], number> = {
  definition: 0,
  type: 1,
  callee: 2,
  caller: 3,
  test: 4,
  rule: 5,
  config: 6,
  similar: 7,
};

const DECAY_STEP = 0.15;

export function baseWeightForKind(kind: ContextItem["kind"]): number {
  switch (kind) {
    case "definition":
      return BASE_WEIGHTS.definition;
    case "type":
      return BASE_WEIGHTS.type;
    case "callee":
      return BASE_WEIGHTS.callee;
    case "caller":
      return BASE_WEIGHTS.caller;
    case "test":
      return BASE_WEIGHTS.test;
    default:
      return 0;
  }
}

export function proximityMultiplier(proximity: RankProximity): number {
  return PROXIMITY_MULTIPLIERS[proximity];
}

export function decayFactor(refCount: number): number {
  if (!Number.isFinite(refCount)) return 1;
  const refs = Math.floor(refCount);
  if (refs <= 1) return 1;
  return 1 / (1 + DECAY_STEP * (refs - 1));
}

export function scoreItem(
  kind: ContextItem["kind"],
  proximity: RankProximity,
  refCount = 1,
): number {
  return baseWeightForKind(kind) * proximityMultiplier(proximity) * decayFactor(refCount);
}

export function rankContextItems(inputs: readonly RankInput[]): ContextItem[] {
  const scored = inputs.map((input) => ({
    item: input.item,
    score: scoreItem(input.item.kind, input.proximity, input.refCount ?? 1),
    priority: KIND_PRIORITY[input.item.kind],
  }));
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.item.file !== b.item.file) return a.item.file < b.item.file ? -1 : 1;
    if (a.item.startLine !== b.item.startLine) return a.item.startLine - b.item.startLine;
    if (a.item.id !== b.item.id) return a.item.id < b.item.id ? -1 : 1;
    return 0;
  });
  return scored.map((entry) => ({ ...entry.item, score: entry.score }));
}
