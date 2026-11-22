import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  CONVENTION_DETECTOR_ERROR_HANDLING,
  CONVENTION_DETECTOR_ERROR_HANDLING_VERSION,
  CONVENTION_DETECTOR_NAMING,
  CONVENTION_DETECTOR_NAMING_VERSION,
  MAX_CONVENTIONS_PER_RUN,
  MAX_EVIDENCE_PER_CONVENTION,
} from "../../../src/conventions/constants.ts";
import { toCandidate } from "../../../src/conventions/detectors/index.ts";
import type { DetectorCandidate, FileMatch } from "../../../src/conventions/detectors/index.ts";
import { detectErrorHandling } from "../../../src/conventions/detectors/errors.ts";
import { conventionIdFor, filterConventions, hasDominanceMargin } from "../../../src/conventions/support.ts";
import { RESULT_MODULE, THROW_MODULE, withParsedSamples } from "./sample-helpers.ts";

function matchedPaths(count: number, prefix: string): FileMatch[] {
  const out: FileMatch[] = [];
  for (let index = 0; index < count; index += 1) {
    out.push({
      path: `${prefix}${String(index).padStart(2, "0")}.ts`,
      startLine: index + 1,
      endLine: index + 1,
    });
  }
  return out;
}

function passingCandidate(overrides: {
  detector?: string;
  detectorVersion?: number;
  pattern?: string;
  matching?: number;
  eligible?: number;
  sampled?: number;
  prefix?: string;
}): DetectorCandidate {
  const candidate = toCandidate({
    detector: overrides.detector ?? CONVENTION_DETECTOR_NAMING,
    detectorVersion: overrides.detectorVersion ?? CONVENTION_DETECTOR_NAMING_VERSION,
    pattern: overrides.pattern ?? "Modules predominantly use named exports.",
    matches: matchedPaths(overrides.matching ?? 15, overrides.prefix ?? "src/m"),
    eligibleFiles: overrides.eligible ?? 20,
    sampledFiles: overrides.sampled ?? 20,
  });
  if (candidate === null) throw new Error("test fixture candidate must be constructible");
  return candidate;
}

describe("support filter", () => {
  test("rejects 3 of 5", () => {
    const candidate = toCandidate({
      detector: CONVENTION_DETECTOR_NAMING,
      detectorVersion: CONVENTION_DETECTOR_NAMING_VERSION,
      pattern: "Modules predominantly use named exports.",
      matches: matchedPaths(3, "src/m"),
      eligibleFiles: 5,
      sampledFiles: 5,
    });
    expect(candidate).not.toBeNull();
    expect(filterConventions(candidate === null ? [] : [candidate])).toEqual([]);
  });

  test("rejects passing ratio with fewer than five matching files", () => {
    const candidate = toCandidate({
      detector: CONVENTION_DETECTOR_NAMING,
      detectorVersion: CONVENTION_DETECTOR_NAMING_VERSION,
      pattern: "Modules predominantly use named exports.",
      matches: matchedPaths(4, "src/m"),
      eligibleFiles: 5,
      sampledFiles: 5,
    });
    expect(candidate?.supportRatio).toBe(0.8);
    expect(filterConventions(candidate === null ? [] : [candidate])).toEqual([]);
  });

  test("accepts exactly at both thresholds", () => {
    const conventions = filterConventions([passingCandidate({ matching: 15, eligible: 20 })]);
    expect(conventions).toHaveLength(1);
    expect(conventions[0]?.matchingFiles).toBe(15);
    expect(conventions[0]?.eligibleFiles).toBe(20);
    expect(conventions[0]?.supportRatio).toBe(0.75);
    expect(conventions[0]?.id).toMatch(/^inf-[0-9a-f]+$/);
  });

  test("rejects just below the support ratio", () => {
    expect(filterConventions([passingCandidate({ matching: 14, eligible: 20 })])).toEqual([]);
  });

  test("drops zero-eligible candidates without dividing", () => {
    const zero: DetectorCandidate = {
      detector: CONVENTION_DETECTOR_NAMING,
      detectorVersion: CONVENTION_DETECTOR_NAMING_VERSION,
      pattern: "Modules predominantly use named exports.",
      evidence: [],
      matchingFiles: 0,
      eligibleFiles: 0,
      sampledFiles: 0,
      supportRatio: 0,
    };
    expect(filterConventions([zero])).toEqual([]);
    expect(filterConventions([])).toEqual([]);
  });

  test("drops counts where matching exceeds eligible", () => {
    const bad: DetectorCandidate = {
      ...passingCandidate({ matching: 6, eligible: 6 }),
      matchingFiles: 7,
      eligibleFiles: 6,
    };
    expect(filterConventions([bad])).toEqual([]);
  });

  test("keeps per-detector denominators independent", () => {
    const naming = passingCandidate({ matching: 15, eligible: 20, prefix: "src/n" });
    const wrappers = passingCandidate({
      detector: "common-wrappers",
      detectorVersion: 1,
      pattern: "Modules repeatedly wrap callbacks with the repository helper alpha.",
      matching: 6,
      eligible: 8,
      prefix: "src/w",
    });
    const conventions = filterConventions([naming, wrappers]);
    expect(conventions).toHaveLength(2);
    expect(conventions.map((entry) => entry.detector).sort()).toEqual(["common-wrappers", "naming-exports"]);
  });

  test("truncates evidence after counting the full match set", () => {
    const conventions = filterConventions([passingCandidate({ matching: 12, eligible: 12, prefix: "src/t" })]);
    expect(conventions).toHaveLength(1);
    expect(conventions[0]?.matchingFiles).toBe(12);
    expect(conventions[0]?.evidence).toHaveLength(MAX_EVIDENCE_PER_CONVENTION);
    expect(conventions[0]?.evidence.map((entry) => entry.file)).toEqual(
      matchedPaths(MAX_EVIDENCE_PER_CONVENTION, "src/t").map((match) => match.path),
    );
  });

  test("orders by support, count, detector, then id", () => {
    const full = passingCandidate({
      detector: "common-wrappers",
      detectorVersion: 1,
      pattern: "Modules repeatedly wrap callbacks with the repository helper full.",
      matching: 6,
      eligible: 6,
      prefix: "src/f",
    });
    const namedStrong = passingCandidate({ matching: 15, eligible: 20, prefix: "src/a" });
    const errorsTied = passingCandidate({
      detector: CONVENTION_DETECTOR_ERROR_HANDLING,
      detectorVersion: CONVENTION_DETECTOR_ERROR_HANDLING_VERSION,
      pattern: "The repository predominantly uses throw-style error handling.",
      matching: 9,
      eligible: 12,
      sampled: 12,
      prefix: "src/e",
    });
    const namedTied = passingCandidate({
      detector: CONVENTION_DETECTOR_NAMING,
      detectorVersion: CONVENTION_DETECTOR_NAMING_VERSION,
      pattern: "Modules predominantly use default exports.",
      matching: 6,
      eligible: 8,
      sampled: 8,
      prefix: "src/g",
    });
    const wrappersTied = passingCandidate({
      detector: "common-wrappers",
      detectorVersion: 1,
      pattern: "Modules repeatedly wrap callbacks with the repository helper tied.",
      matching: 6,
      eligible: 8,
      sampled: 8,
      prefix: "src/h",
    });
    const conventions = filterConventions([wrappersTied, namedTied, errorsTied, namedStrong, full]);
    expect(conventions.map((entry) => entry.pattern)).toEqual([
      "Modules repeatedly wrap callbacks with the repository helper full.",
      "Modules predominantly use named exports.",
      "The repository predominantly uses throw-style error handling.",
      "Modules repeatedly wrap callbacks with the repository helper tied.",
      "Modules predominantly use default exports.",
    ]);
  });

  test("breaks full ties by stable id order", () => {
    const alpha = passingCandidate({
      detector: "common-wrappers",
      detectorVersion: 1,
      pattern: "Modules repeatedly wrap callbacks with the repository helper alpha.",
      matching: 6,
      eligible: 8,
      sampled: 8,
      prefix: "src/p",
    });
    const beta = passingCandidate({
      detector: "common-wrappers",
      detectorVersion: 1,
      pattern: "Modules repeatedly wrap callbacks with the repository helper beta.",
      matching: 6,
      eligible: 8,
      sampled: 8,
      prefix: "src/q",
    });
    const conventions = filterConventions([beta, alpha]);
    expect(conventions).toHaveLength(2);
    const ids = conventions.map((entry) => entry.id);
    expect(ids).toEqual([...ids].sort());
  });

  test("caps at twenty retaining the top-ranked", () => {
    const candidates: DetectorCandidate[] = [];
    for (let matching = 75; matching <= 95; matching += 1) {
      candidates.push(
        passingCandidate({
          detector: "common-wrappers",
          detectorVersion: 1,
          pattern: `Modules repeatedly wrap callbacks with the repository helper h${matching}.`,
          matching,
          eligible: 100,
          sampled: 100,
          prefix: `src/c${matching}`,
        }),
      );
    }
    expect(candidates).toHaveLength(21);
    const conventions = filterConventions(candidates);
    expect(conventions).toHaveLength(MAX_CONVENTIONS_PER_RUN);
    expect(conventions.some((entry) => entry.matchingFiles === 75)).toBe(false);
    expect(conventions[0]?.matchingFiles).toBe(95);
  });

  test("assigns stable ids across runs and input permutations", () => {
    const first = passingCandidate({ matching: 15, eligible: 20, prefix: "src/s" });
    const second = passingCandidate({
      detector: "common-wrappers",
      detectorVersion: 1,
      pattern: "Modules repeatedly wrap callbacks with the repository helper stable.",
      matching: 6,
      eligible: 6,
      sampled: 20,
      prefix: "src/z",
    });
    const forward = filterConventions([first, second]);
    const backward = filterConventions([second, first]);
    expect(backward).toEqual(forward);
    expect(filterConventions([first, second])).toEqual(forward);
  });

  test("derives ids from a documented canonical serialization", () => {
    const id = conventionIdFor(
      CONVENTION_DETECTOR_NAMING,
      CONVENTION_DETECTOR_NAMING_VERSION,
      "Modules predominantly use named exports.",
    );
    const expected =
      "inf-" +
      createHash("sha256")
        .update(
          `codebleach-phase6-convention-v1\0${CONVENTION_DETECTOR_NAMING}\0${CONVENTION_DETECTOR_NAMING_VERSION}\0Modules predominantly use named exports.`,
        )
        .digest("hex")
        .slice(0, 16);
    expect(id).toBe(expected);
    expect(id).toMatch(/^inf-[0-9a-f]{16}$/);
  });

  test("rejects overlong and control-character patterns", () => {
    const long: DetectorCandidate = {
      ...passingCandidate({ matching: 15, eligible: 20 }),
      pattern: `Modules predominantly use named exports. ${"x".repeat(240)}`,
    };
    const newline: DetectorCandidate = {
      ...passingCandidate({ matching: 15, eligible: 20, prefix: "src/y" }),
      pattern: "Modules predominantly use named\nexports.",
    };
    expect(filterConventions([long, newline])).toEqual([]);
  });

  test("serialized conventions carry no source text", () => {
    const conventions = filterConventions([passingCandidate({ matching: 15, eligible: 20 })]);
    expect(conventions).toHaveLength(1);
    const serialized = JSON.stringify(conventions);
    expect(serialized).not.toContain("quote");
    expect(serialized).not.toContain("excerpt");
    for (const entry of conventions[0]?.evidence ?? []) {
      expect(Object.keys(entry).sort()).toEqual(["endLine", "file", "kind", "startLine"]);
    }
  });

  test("enforces the dominance margin only from reported runner-up counts", () => {
    expect(hasDominanceMargin(15, 0, 20)).toBe(true);
    expect(hasDominanceMargin(15, 11, 20)).toBe(true);
    expect(hasDominanceMargin(15, 12, 20)).toBe(false);
    const base = passingCandidate({ matching: 15, eligible: 20, prefix: "src/d" });
    const uncontested: DetectorCandidate = {
      ...base,
      detector: CONVENTION_DETECTOR_ERROR_HANDLING,
      detectorVersion: CONVENTION_DETECTOR_ERROR_HANDLING_VERSION,
      runnerUpMatchingFiles: 0,
    };
    expect(filterConventions([uncontested])).toHaveLength(1);
    const contested: DetectorCandidate = { ...uncontested, runnerUpMatchingFiles: 12 };
    expect(filterConventions([contested])).toEqual([]);
  });

  test("error-handling detector output flows through the support gates", async () => {
    await withParsedSamples(
      [
        { path: "src/r0.ts", language: "typescript", source: RESULT_MODULE("w-a") },
        { path: "src/r1.ts", language: "typescript", source: RESULT_MODULE("w-b") },
        { path: "src/r2.ts", language: "typescript", source: RESULT_MODULE("w-c") },
        { path: "src/r3.ts", language: "typescript", source: RESULT_MODULE("w-d") },
        { path: "src/r4.ts", language: "typescript", source: RESULT_MODULE("w-e") },
        { path: "src/r5.ts", language: "typescript", source: RESULT_MODULE("w-f") },
      ],
      (files) => {
        const candidates = detectErrorHandling(files);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.runnerUpMatchingFiles).toBe(0);
        const conventions = filterConventions(candidates);
        expect(conventions).toHaveLength(1);
        expect(conventions[0]?.id.startsWith("inf-")).toBe(true);
        expect(conventions[0]?.matchingFiles).toBe(6);
      },
    );
  });

  test("tied error styles emit no convention", async () => {
    await withParsedSamples(
      [
        { path: "src/r0.ts", language: "typescript", source: RESULT_MODULE("t-a") },
        { path: "src/t0.ts", language: "typescript", source: THROW_MODULE("t-b") },
      ],
      (files) => {
        expect(detectErrorHandling(files)).toEqual([]);
      },
    );
  });
});
