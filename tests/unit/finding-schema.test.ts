import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { EvidenceSchema, RawFindingSchema, RawReviewOutputSchema } from "../../src/types/finding.ts";
import { LlmVerdictSchema } from "../../src/types/validation.ts";

const validEvidence = {
  file: "src/a.ts",
  startLine: 1,
  endLine: 2,
  quote: "const x = 1;",
};

function validFinding() {
  return {
    title: "Possible null dereference",
    severity: "high",
    category: "null-handling",
    file: "src/a.ts",
    line: 10,
    description: "x may be null here.",
    confidence: 0.9,
    evidence: [validEvidence],
    introducedByPr: true,
  };
}

describe("finding schemas", () => {
  test("accepts valid finding", () => {
    expect(RawFindingSchema.parse(validFinding())).toMatchObject({ title: "Possible null dereference" });
  });

  test("accepts optional endLine/suggestion/ruleId", () => {
    const parsed = RawFindingSchema.parse({
      ...validFinding(),
      endLine: 12,
      suggestion: "guard it",
      ruleId: "arch-001",
    });
    expect(parsed.endLine).toBe(12);
  });

  test("rejects missing evidence", () => {
    expect(() => RawFindingSchema.parse({ ...validFinding(), evidence: [] })).toThrow();
  });

  test("rejects confidence out of range", () => {
    expect(() => RawFindingSchema.parse({ ...validFinding(), confidence: 1.5 })).toThrow();
    expect(() => RawFindingSchema.parse({ ...validFinding(), confidence: -0.1 })).toThrow();
  });

  test("rejects unknown keys", () => {
    expect(() =>
      RawFindingSchema.parse({ ...validFinding(), fingerprint: "abc" }),
    ).toThrow();
    expect(() =>
      RawFindingSchema.parse({ ...validFinding(), id: "x", headSha: "y", origin: {} }),
    ).toThrow();
  });

  test("rejects non-positive line numbers", () => {
    expect(() => RawFindingSchema.parse({ ...validFinding(), line: 0 })).toThrow();
    expect(() => EvidenceSchema.parse({ ...validEvidence, startLine: -1 })).toThrow();
  });

  test("rejects endLine below line", () => {
    expect(() =>
      RawFindingSchema.parse({ ...validFinding(), line: 10, endLine: 9 }),
    ).toThrow();
  });

  test("rejects evidence endLine below startLine", () => {
    expect(() =>
      EvidenceSchema.parse({ ...validEvidence, startLine: 5, endLine: 4 }),
    ).toThrow();
  });

  test("rejects overlong title and description", () => {
    expect(() => RawFindingSchema.parse({ ...validFinding(), title: "t".repeat(121) })).toThrow();
    expect(() =>
      RawFindingSchema.parse({ ...validFinding(), description: "d".repeat(2001) }),
    ).toThrow();
  });

  test("raw review output requires findings array", () => {
    expect(RawReviewOutputSchema.parse({ findings: [validFinding()] }).findings).toHaveLength(1);
    expect(() => RawReviewOutputSchema.parse({ findings: "nope" })).toThrow();
  });

  test("converts to JSON schema", () => {
    const jsonSchema = z.toJSONSchema(RawReviewOutputSchema);
    expect(jsonSchema.type).toBe("object");
  });

  test("llm verdict accepts known verdicts", () => {
    expect(LlmVerdictSchema.parse({ verdict: "confirmed", reasoning: "why" })).toMatchObject({
      verdict: "confirmed",
    });
    expect(LlmVerdictSchema.parse({ verdict: "refuted", reasoning: "why" })).toMatchObject({
      verdict: "refuted",
    });
    expect(() => LlmVerdictSchema.parse({ verdict: "maybe", reasoning: "why" })).toThrow();
  });
});
