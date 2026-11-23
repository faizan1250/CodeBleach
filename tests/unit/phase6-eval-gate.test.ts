import { describe, expect, test } from "bun:test";
import { evaluateGate, MIN_EVAL_CANDIDATES, MIN_USEFUL_PRECISION } from "../live/phase6-eval/eval-gate.ts";
import type { LabeledAdvisoryCandidate } from "../live/phase6-eval/eval-gate.ts";

function labeled(id: string, label: LabeledAdvisoryCandidate["label"]): LabeledAdvisoryCandidate {
  return {
    prUrl: "https://github.com/example/repo/pull/1",
    findingId: id,
    label,
    category: "convention",
    severity: "low",
  };
}

function many(count: number, label: LabeledAdvisoryCandidate["label"]): LabeledAdvisoryCandidate[] {
  return Array.from({ length: count }, (_, index) => labeled(`f${index}`, label));
}

describe("phase6 eval gate", () => {
  test("passes at thirty candidates and eighty percent useful", () => {
    const result = evaluateGate({
      labels: [...many(24, "useful"), ...many(6, "technically-correct-but-not-actionable")],
    });
    expect(result.passed).toBe(true);
    expect(result.totalCandidates).toBe(30);
    expect(result.usefulPrecision).toBe(0.8);
    expect(result.reasons).toEqual([]);
  });

  test("fails below the candidate minimum", () => {
    const result = evaluateGate({ labels: many(29, "useful") });
    expect(result.passed).toBe(false);
    expect(result.totalCandidates).toBe(29);
    expect(result.reasons.some((reason) => reason.includes(String(MIN_EVAL_CANDIDATES)))).toBe(true);
  });

  test("fails below the useful precision floor", () => {
    const result = evaluateGate({
      labels: [...many(23, "useful"), ...many(7, "technically-correct-but-not-actionable")],
    });
    expect(result.passed).toBe(false);
    expect(result.usefulPrecision).toBeLessThan(MIN_USEFUL_PRECISION);
  });

  test("fails on any authority violation", () => {
    const bad: LabeledAdvisoryCandidate = {
      ...labeled("bad", "useful"),
      category: "bug",
    };
    const result = evaluateGate({ labels: [...many(30, "useful"), bad] });
    expect(result.passed).toBe(false);
    expect(result.violations).toBe(1);
  });

  test("fails on ruleId and severity violations", () => {
    const rule: LabeledAdvisoryCandidate = { ...labeled("rule", "useful"), ruleId: "real-rule" };
    const severity: LabeledAdvisoryCandidate = { ...labeled("sev", "useful"), severity: "medium" };
    const result = evaluateGate({ labels: [...many(30, "useful"), rule, severity] });
    expect(result.passed).toBe(false);
    expect(result.violations).toBe(2);
  });

  test("counts only useful labels toward precision", () => {
    const result = evaluateGate({
      labels: [
        ...many(24, "useful"),
        ...many(3, "incorrect/unsupported"),
        ...many(3, "technically-correct-but-not-actionable"),
      ],
    });
    expect(result.totalCandidates).toBe(30);
    expect(result.usefulPrecision).toBe(0.8);
    expect(result.passed).toBe(true);
  });
});
