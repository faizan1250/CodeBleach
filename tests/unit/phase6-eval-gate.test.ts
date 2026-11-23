import { describe, expect, test } from "bun:test";
import {
  evaluateGate,
  MIN_EVAL_CANDIDATES,
  MIN_USEFUL_PRECISION,
  type EmittedAdvisoryCandidate,
  type LabeledAdvisoryCandidate,
} from "../live/phase6-eval/eval-gate.ts";

const PR = "https://github.com/example/repo/pull/1";
const KNOWN = [PR, "https://github.com/example/repo/pull/2"];

function emitted(id: string, overrides: Partial<EmittedAdvisoryCandidate> = {}): EmittedAdvisoryCandidate {
  return { prUrl: PR, findingId: id, category: "convention", severity: "low", ...overrides };
}

function labeled(id: string, label: LabeledAdvisoryCandidate["label"] = "useful"): LabeledAdvisoryCandidate {
  return { prUrl: PR, findingId: id, label };
}

function manyEmitted(
  count: number,
  label: LabeledAdvisoryCandidate["label"] = "useful",
): {
  emitted: EmittedAdvisoryCandidate[];
  labels: LabeledAdvisoryCandidate[];
} {
  const emittedList = Array.from({ length: count }, (_, index) => emitted(`f${index}`));
  const labelList = emittedList.map((candidate) => labeled(candidate.findingId, label));
  return { emitted: emittedList, labels: labelList };
}

function usefulLabels(
  count: number,
  nonUseful: LabeledAdvisoryCandidate["label"],
  nonUsefulCount: number,
): {
  emitted: EmittedAdvisoryCandidate[];
  labels: LabeledAdvisoryCandidate[];
} {
  const total = count + nonUsefulCount;
  const emittedList = Array.from({ length: total }, (_, index) => emitted(`f${index}`));
  const labels = [
    ...emittedList.slice(0, count).map((candidate) => labeled(candidate.findingId, "useful")),
    ...emittedList.slice(count).map((candidate) => labeled(candidate.findingId, nonUseful)),
  ];
  return { emitted: emittedList, labels };
}

describe("phase6 eval gate", () => {
  test("passes at thirty emitted candidates and eighty percent useful", () => {
    const { emitted: emittedList, labels } = usefulLabels(24, "technically-correct-but-not-actionable", 6);
    const result = evaluateGate({ labels, emitted: emittedList, knownPrUrls: KNOWN });
    expect(result.passed).toBe(true);
    expect(result.totalCandidates).toBe(30);
    expect(result.usefulPrecision).toBe(0.8);
    expect(result.reasons).toEqual([]);
  });

  test("fails below the candidate minimum", () => {
    const { emitted: emittedList, labels } = manyEmitted(29);
    const result = evaluateGate({ labels, emitted: emittedList });
    expect(result.passed).toBe(false);
    expect(result.totalCandidates).toBe(29);
    expect(result.reasons.some((reason) => reason.includes(String(MIN_EVAL_CANDIDATES)))).toBe(true);
  });

  test("counts emitted records not labels", () => {
    const { emitted: emittedList, labels } = manyEmitted(30);
    const extra = [...labels, { ...labeled("invented"), label: "useful" as const }];
    const result = evaluateGate({ labels: extra, emitted: emittedList });
    expect(result.passed).toBe(false);
    expect(result.totalCandidates).toBe(30);
    expect(result.unmatched).toEqual([`${PR}#invented`]);
  });

  test("fails below the useful precision floor", () => {
    const { emitted: emittedList, labels } = usefulLabels(23, "technically-correct-but-not-actionable", 7);
    const result = evaluateGate({ labels, emitted: emittedList });
    expect(result.passed).toBe(false);
    expect(result.usefulPrecision).toBeLessThan(MIN_USEFUL_PRECISION);
  });

  test("derives authority from emitted records", () => {
    const emittedList = [emitted("bug", { category: "bug" }), emitted("sev", { severity: "medium" })];
    const labels = [labeled("bug"), labeled("sev")];
    const result = evaluateGate({ labels, emitted: emittedList });
    expect(result.passed).toBe(false);
    expect(result.violations).toBe(2);
  });

  test("fails on emitted ruleId violations", () => {
    const { emitted: emittedList, labels } = manyEmitted(30);
    const result = evaluateGate({
      labels: [...labels, labeled("rule")],
      emitted: [...emittedList, emitted("rule", { ruleId: "real-rule" })],
    });
    expect(result.passed).toBe(false);
    expect(result.violations).toBe(1);
  });

  test("counts only useful labels toward precision", () => {
    const { emitted: emittedList, labels } = {
      emitted: Array.from({ length: 30 }, (_, index) => emitted(`f${index}`)),
      labels: [
        ...Array.from({ length: 24 }, (_, index) => labeled(`f${index}`, "useful")),
        ...Array.from({ length: 3 }, (_, index) => labeled(`f${24 + index}`, "incorrect/unsupported")),
        ...Array.from({ length: 3 }, (_, index) => labeled(`f${27 + index}`, "technically-correct-but-not-actionable")),
      ],
    };
    const result = evaluateGate({ labels, emitted: emittedList });
    expect(result.totalCandidates).toBe(30);
    expect(result.usefulPrecision).toBe(0.8);
    expect(result.passed).toBe(true);
  });

  test("rejects duplicate labels for one finding", () => {
    const { emitted: emittedList, labels } = manyEmitted(30);
    const result = evaluateGate({ labels: [...labels, labels[0]!], emitted: emittedList });
    expect(result.passed).toBe(false);
    expect(result.duplicates).toEqual([`${PR}#f0`]);
  });

  test("rejects labels for never-emitted findings", () => {
    const { emitted: emittedList, labels } = manyEmitted(30);
    const result = evaluateGate({ labels: [...labels.slice(1), labeled("ghost")], emitted: emittedList });
    expect(result.passed).toBe(false);
    expect(result.unmatched).toEqual([`${PR}#ghost`]);
    expect(result.missing).toEqual([`${PR}#f0`]);
  });

  test("rejects unknown PR URLs against the corpus", () => {
    const { emitted: emittedList, labels } = manyEmitted(30);
    const foreign = { ...labeled("f0"), prUrl: "https://github.com/example/other/pull/9" };
    const result = evaluateGate({ labels: [...labels.slice(1), foreign], emitted: emittedList, knownPrUrls: KNOWN });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("unknown PR URL"))).toBe(true);
  });

  test("rejects emitted records for unknown PRs", () => {
    const { emitted: emittedList, labels } = manyEmitted(30);
    const foreign = emitted("x", { prUrl: "https://github.com/example/other/pull/9" });
    const result = evaluateGate({
      labels: [...labels, { ...labeled("x"), prUrl: foreign.prUrl }],
      emitted: [...emittedList, foreign],
      knownPrUrls: KNOWN,
    });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("unknown PR URL"))).toBe(true);
  });

  test("requires every emitted candidate to carry exactly one label", () => {
    const { emitted: emittedList, labels } = manyEmitted(30);
    const result = evaluateGate({ labels: labels.slice(0, 29), emitted: emittedList });
    expect(result.passed).toBe(false);
    expect(result.missing).toEqual([`${PR}#f29`]);
  });

  test("rejects duplicate emitted identities", () => {
    const { emitted: emittedList, labels } = manyEmitted(30);
    const result = evaluateGate({ labels, emitted: [...emittedList, emittedList[0]!] });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("duplicate emitted"))).toBe(true);
  });

  test("reports deterministically sorted identities", () => {
    const emittedList = [emitted("b"), emitted("a")];
    const labels = [labeled("b", "incorrect/unsupported")];
    const first = evaluateGate({ labels, emitted: emittedList });
    const second = evaluateGate({ labels: [...labels].reverse(), emitted: [...emittedList].reverse() });
    expect(first.missing).toEqual(second.missing);
    expect(first.reasons).toEqual(second.reasons);
  });
});
