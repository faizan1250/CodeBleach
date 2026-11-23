import { describe, expect, test } from "bun:test";
import type { Finding, ValidatedFinding } from "../../src/types/index.ts";
import type {
  PendingAdvisoryCandidate,
  PrimaryValidationResult,
  ValidationHandoffLocation,
} from "../../src/types/conventions.ts";
import {
  capAdvisoryCandidates,
  dedupeAdvisoryCandidates,
  gateAdvisoryBoundary,
  resolveAdvisoryMerge,
  suppressOverlappingAdvisory,
  validateAdvisoryHandoffEntry,
  validatePrimaryHandoffStructure,
} from "../../src/validate/conflict.ts";

const HEAD = "c".repeat(40);

function finding(id: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id,
    fingerprint: `fp-${id}`,
    headSha: HEAD,
    origin: { pass: "convention-advisory", unitId: "unit-1" },
    title: `Convention observation ${id}`,
    severity: "low",
    category: "convention",
    file: "src/a.ts",
    line: 2,
    description: "The change diverges from the inferred repository convention.",
    confidence: 0.9,
    evidence: [{ file: "src/a.ts", startLine: 2, endLine: 2, quote: "return 2;" }],
    introducedByPr: true,
    symbol: "f",
    ...overrides,
  };
}

function accepted(id: string, path = "src/a.ts"): ValidatedFinding {
  const owned = finding(id, { file: path });
  return {
    finding: owned,
    status: "accepted",
    checks: [],
    derivedAttribution: { introducedByPr: true, basis: { kind: "added-lines", evidenceIndex: 0, file: path, lines: [2] } },
    derivedTarget: { file: path, line: 2, side: "RIGHT", kind: "added" },
  };
}

function rejected(id: string): ValidatedFinding {
  return { finding: finding(id), status: "rejected", checks: [] };
}

function span(path: string, startLine: number, endLine: number): ValidationHandoffLocation {
  return { path, startLine, endLine };
}

function pending(
  id: string,
  headLocations: ValidationHandoffLocation[],
  confidence = 0.9,
): PendingAdvisoryCandidate {
  const owned = finding(id, { confidence });
  return {
    phase: "pending-advisory-resolution",
    findingId: id,
    pendingFields: {
      finding: owned,
      checks: [],
      derivedAttribution: {
        introducedByPr: true,
        basis: { kind: "added-lines", evidenceIndex: 0, file: "src/a.ts", lines: [2] },
      },
      derivedTarget: { file: "src/a.ts", line: 2, side: "RIGHT", kind: "added" },
    },
    handoff: { findingId: id, headLocations },
  };
}

function primaryWith(findings: ValidatedFinding[], handoff: PrimaryValidationResult["handoff"]): PrimaryValidationResult {
  return { findings, handoff };
}

describe("primary handoff structure", () => {
  test("accepts exact entries for accepted winners and ignores rejected findings", () => {
    const result = primaryWith([accepted("p1"), rejected("r1")], [{ findingId: "p1", headLocations: [] }]);
    expect(validatePrimaryHandoffStructure(result).ok).toBe(true);
  });

  test("rejects a missing entry for an accepted finding", () => {
    const result = primaryWith([accepted("p1")], []);
    expect(validatePrimaryHandoffStructure(result).ok).toBe(false);
  });

  test("rejects duplicate entries for one finding", () => {
    const result = primaryWith([accepted("p1")], [
      { findingId: "p1", headLocations: [] },
      { findingId: "p1", headLocations: [] },
    ]);
    expect(validatePrimaryHandoffStructure(result).ok).toBe(false);
  });

  test("rejects an unknown extra entry", () => {
    const result = primaryWith([accepted("p1")], [
      { findingId: "p1", headLocations: [] },
      { findingId: "ghost", headLocations: [] },
    ]);
    expect(validatePrimaryHandoffStructure(result).ok).toBe(false);
  });

  test("rejects malformed non-empty locations", () => {
    for (const bad of [
      [span("", 1, 1)],
      [span("src/a.ts", 0, 1)],
      [span("src/a.ts", 3, 2)],
      [span("/abs.ts", 1, 1)],
      [span("src/a\nb.ts", 1, 1)],
    ]) {
      const result = primaryWith([accepted("p1")], [{ findingId: "p1", headLocations: bad }]);
      expect(validatePrimaryHandoffStructure(result).ok).toBe(false);
    }
  });
});

describe("advisory handoff entries", () => {
  test("accepts an empty head-location list", () => {
    expect(validateAdvisoryHandoffEntry(pending("a1", []))).toBe(true);
  });

  test("rejects mismatched association ids", () => {
    const candidate = pending("a1", []);
    const mismatched: PendingAdvisoryCandidate = {
      ...candidate,
      handoff: { findingId: "other", headLocations: [] },
    };
    expect(validateAdvisoryHandoffEntry(mismatched)).toBe(false);
  });

  test("rejects malformed non-empty locations", () => {
    expect(validateAdvisoryHandoffEntry(pending("a1", [span("src/a.ts", 5, 3)]))).toBe(false);
  });
});

describe("C1-C3 overlap rule", () => {
  test("C1 suppresses the advisory on same-path verified overlap", () => {
    const primary = [{ findingId: "p1", headLocations: [span("src/a.ts", 1, 3)] }];
    const outcome = suppressOverlappingAdvisory(primary, [pending("a1", [span("src/a.ts", 3, 5)])]);
    expect(outcome.retained.map((candidate) => candidate.findingId)).toEqual([]);
    expect(outcome.suppressed).toBe(1);
  });

  test("C2 retains advisories on adjacent non-overlapping intervals", () => {
    const primary = [{ findingId: "p1", headLocations: [span("src/a.ts", 1, 2)] }];
    const outcome = suppressOverlappingAdvisory(primary, [pending("a1", [span("src/a.ts", 3, 4)])]);
    expect(outcome.retained.map((candidate) => candidate.findingId)).toEqual(["a1"]);
    expect(outcome.suppressed).toBe(0);
  });

  test("C2 retains advisories on other paths", () => {
    const primary = [{ findingId: "p1", headLocations: [span("src/a.ts", 1, 9)] }];
    const outcome = suppressOverlappingAdvisory(primary, [pending("a1", [span("src/b.ts", 1, 9)])]);
    expect(outcome.retained.map((candidate) => candidate.findingId)).toEqual(["a1"]);
  });

  test("C3 ignores cited ranges and decides on verified actuals only", () => {
    const primary = [{ findingId: "p1", headLocations: [span("src/a.ts", 10, 12)] }];
    const citedOverlap = pending("a1", [span("src/a.ts", 1, 2)]);
    const citedOnly: PendingAdvisoryCandidate = {
      ...citedOverlap,
      pendingFields: {
        ...citedOverlap.pendingFields,
        finding: finding("a1", { evidence: [{ file: "src/a.ts", startLine: 10, endLine: 12, quote: "x" }] }),
      },
    };
    expect(suppressOverlappingAdvisory(primary, [citedOnly]).retained).toHaveLength(1);
    const citedMiss = pending("a2", [span("src/a.ts", 11, 11)]);
    const missed: PendingAdvisoryCandidate = {
      ...citedMiss,
      pendingFields: {
        ...citedMiss.pendingFields,
        finding: finding("a2", { evidence: [{ file: "src/a.ts", startLine: 1, endLine: 2, quote: "y" }] }),
      },
    };
    expect(suppressOverlappingAdvisory(primary, [missed]).retained).toHaveLength(0);
  });
});

describe("C4-C7 fail-open merge", () => {
  test("C4 keeps advisories alongside base-only primaries with empty handoff", () => {
    const primary = primaryWith([accepted("p1")], [{ findingId: "p1", headLocations: [] }]);
    const merged = resolveAdvisoryMerge(primary, [pending("a1", [span("src/a.ts", 1, 2)])]);
    expect(merged.retained.map((candidate) => candidate.findingId)).toEqual(["a1"]);
    expect(merged.metadata.suppressed).toBe(0);
  });

  test("C5 drops every advisory on malformed primary handoff and keeps primaries", () => {
    const primary = primaryWith([accepted("p1")], []);
    const merged = resolveAdvisoryMerge(primary, [
      pending("a1", [span("src/a.ts", 1, 2)]),
      pending("a2", []),
    ]);
    expect(merged.retained).toEqual([]);
    expect(merged.metadata.unmappableExcluded).toBe(2);
    expect(merged.metadata.codes).toContain("primary_handoff_invalid");
  });

  test("C6 retains a valid advisory with empty head locations", () => {
    const primary = primaryWith([accepted("p1")], [{ findingId: "p1", headLocations: [span("src/a.ts", 1, 9)] }]);
    const merged = resolveAdvisoryMerge(primary, [pending("a1", [])]);
    expect(merged.retained.map((candidate) => candidate.findingId)).toEqual(["a1"]);
  });

  test("C7 drops only the malformed advisory candidate", () => {
    const primary = primaryWith([accepted("p1")], [{ findingId: "p1", headLocations: [span("src/a.ts", 1, 2)] }]);
    const bad: PendingAdvisoryCandidate = {
      ...pending("bad", []),
      handoff: { findingId: "mismatch", headLocations: [] },
    };
    const merged = resolveAdvisoryMerge(primary, [pending("a1", [span("src/a.ts", 8, 9)]), bad]);
    expect(merged.retained.map((candidate) => candidate.findingId)).toEqual(["a1"]);
    expect(merged.metadata.unmappableExcluded).toBe(1);
  });
});

describe("advisory-only dedupe and cap", () => {
  test("keeps the higher-confidence candidate on advisory overlap", () => {
    const outcome = dedupeAdvisoryCandidates([
      pending("low", [span("src/a.ts", 1, 3)], 0.4),
      pending("high", [span("src/a.ts", 2, 4)], 0.9),
    ]);
    expect(outcome.retained.map((candidate) => candidate.findingId)).toEqual(["high"]);
    expect(outcome.duplicates).toBe(1);
  });

  test("breaks confidence ties by path, start, fingerprint, then id", () => {
    const outcome = dedupeAdvisoryCandidates([
      pending("b-id", [span("src/a.ts", 1, 3)], 0.5),
      pending("a-id", [span("src/a.ts", 1, 3)], 0.5),
    ]);
    expect(outcome.retained.map((candidate) => candidate.findingId)).toEqual(["a-id"]);
  });

  test("never evicts or reorders primary findings", () => {
    const primary = primaryWith(
      [accepted("p1"), accepted("p2", "src/b.ts")],
      [
        { findingId: "p1", headLocations: [span("src/a.ts", 1, 2)] },
        { findingId: "p2", headLocations: [span("src/b.ts", 1, 2)] },
      ],
    );
    const merged = resolveAdvisoryMerge(primary, [pending("a1", [span("src/a.ts", 8, 9)])]);
    expect(merged.retained).toHaveLength(1);
    expect(primary.findings.map((item) => item.finding.id)).toEqual(["p1", "p2"]);
  });

  test("caps advisories at five in deterministic winner order", () => {
    const candidates = Array.from({ length: 6 }, (_, index) =>
      pending(`a${index}`, [span(`src/f${index}.ts`, 1, 1)], 0.9 - index * 0.01),
    );
    const outcome = capAdvisoryCandidates(candidates);
    expect(outcome.kept.map((candidate) => candidate.findingId)).toEqual(["a0", "a1", "a2", "a3", "a4"]);
    expect(outcome.overflow).toBe(1);
  });

  test("merge applies cap after dedupe with an overflow code", () => {
    const primary = primaryWith([accepted("p1")], [{ findingId: "p1", headLocations: [] }]);
    const candidates = Array.from({ length: 6 }, (_, index) =>
      pending(`a${index}`, [span(`src/f${index}.ts`, 1, 1)], 0.9 - index * 0.01),
    );
    const merged = resolveAdvisoryMerge(primary, candidates);
    expect(merged.retained).toHaveLength(5);
    expect(merged.metadata.codes).toContain("advisory_cap_overflow");
  });
});

describe("advisory boundary gate", () => {
  test("passes exact convention low findings stamped by orchestration", () => {
    const gated = gateAdvisoryBoundary([finding("a1")]);
    expect(gated.passed.map((item) => item.id)).toEqual(["a1"]);
    expect(gated.rejected).toBe(0);
  });

  test("rejects category, severity, ruleId, and provenance violations", () => {
    const gated = gateAdvisoryBoundary([
      finding("bad-category", { category: "bug" }),
      finding("bad-severity", { severity: "medium" }),
      finding("bad-info", { severity: "info" }),
      finding("bad-rule", { ruleId: "real-rule" }),
      finding("bad-pass", { origin: { pass: "code-review-v1", unitId: "unit-1" } }),
      finding("good", {}),
    ]);
    expect(gated.passed.map((item) => item.id)).toEqual(["good"]);
    expect(gated.rejected).toBe(5);
  });
});
