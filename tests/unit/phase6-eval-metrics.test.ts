import { describe, expect, test } from "bun:test";
import {
  ADVISORY_MERGE_COMPLETED,
  ADVISORY_MERGE_SKIPPED,
  ADVISORY_PASS_COMPLETED,
  ADVISORY_PASS_SKIPPED,
  collectAdvisoryMetrics,
  findLogEvent,
  isAdvisoryProvenance,
  parseJsonLogEvents,
} from "../live/phase6-eval/eval-metrics.ts";

function event(msg: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", level: "info", runId: "run-1", msg, ...fields });
}

function passCompleted(overrides: Record<string, unknown> = {}): string {
  return event(ADVISORY_PASS_COMPLETED, {
    conventions: 2,
    projectedUnits: 4,
    skippedUnits: 1,
    batches: 2,
    candidates: 3,
    boundaryRejected: 0,
    inputTokens: 200,
    outputTokens: 20,
    codes: [],
    ...overrides,
  });
}

function mergeCompleted(overrides: Record<string, unknown> = {}): string {
  return event(ADVISORY_MERGE_COMPLETED, {
    candidates: 3,
    retained: 2,
    suppressed: 0,
    advisoryDuplicates: 0,
    unmappableExcluded: 0,
    codes: [],
    ...overrides,
  });
}

function mergeSkipped(overrides: Record<string, unknown> = {}): string {
  return event(ADVISORY_MERGE_SKIPPED, { candidates: 0, retained: 0, codes: [], ...overrides });
}

function skippedPass(overrides: Record<string, unknown> = {}): string {
  return event(ADVISORY_PASS_SKIPPED, {
    projectedUnits: 0,
    skippedUnits: 5,
    batches: 0,
    codes: ["advisory_skipped_no_conventions"],
    ...overrides,
  });
}

describe("eval advisory metrics", () => {
  test("parses completed pass and merge events", () => {
    const stderr = [event("stage completed", { stage: "diff" }), passCompleted(), mergeCompleted()].join("\n");
    const metrics = collectAdvisoryMetrics(stderr);
    expect(metrics.status).toBe("completed");
    expect(metrics.batches).toBe(2);
    expect(metrics.inputTokens).toBe(200);
    expect(metrics.outputTokens).toBe(20);
    expect(metrics.projectedUnits).toBe(4);
    expect(metrics.skippedUnits).toBe(1);
    expect(metrics.candidates).toBe(3);
    expect(metrics.retained).toBe(2);
    expect(metrics.codes).toEqual([]);
    expect(metrics.detail).toBeNull();
  });

  test("treats skipped pass events as genuine zeros", () => {
    const stderr = [skippedPass(), mergeSkipped()].join("\n");
    const metrics = collectAdvisoryMetrics(stderr);
    expect(metrics.status).toBe("skipped");
    expect(metrics.batches).toBe(0);
    expect(metrics.inputTokens).toBe(0);
    expect(metrics.projectedUnits).toBe(0);
    expect(metrics.skippedUnits).toBe(5);
    expect(metrics.codes).toEqual(["advisory_skipped_no_conventions"]);
    expect(metrics.detail).toBeNull();
  });

  test("requires a merge outcome after a skipped pass", () => {
    const metrics = collectAdvisoryMetrics(skippedPass());
    expect(metrics.status).toBe("missing");
    expect(metrics.detail).toContain("merge");
  });

  test("rejects merge-completed after a skipped pass", () => {
    const stderr = [skippedPass(), mergeCompleted()].join("\n");
    const metrics = collectAdvisoryMetrics(stderr);
    expect(metrics.status).toBe("missing");
    expect(metrics.detail).toContain("contradictory");
  });

  test("rejects duplicate merge outcomes after a skipped pass", () => {
    const doubled = [skippedPass(), mergeSkipped(), mergeSkipped()].join("\n");
    expect(collectAdvisoryMetrics(doubled).status).toBe("missing");
    expect(collectAdvisoryMetrics(doubled).detail).toContain("duplicate");
    const mixed = [skippedPass(), mergeSkipped(), mergeCompleted()].join("\n");
    expect(collectAdvisoryMetrics(mixed).status).toBe("missing");
    expect(collectAdvisoryMetrics(mixed).detail).toContain("contradictory");
  });

  test("rejects duplicate skipped pass events", () => {
    const stderr = [skippedPass(), skippedPass(), mergeSkipped()].join("\n");
    const metrics = collectAdvisoryMetrics(stderr);
    expect(metrics.status).toBe("missing");
    expect(metrics.detail).toContain("duplicate");
  });

  test("rejects malformed merge-skipped numerics after a skipped pass", () => {
    const stderr = [skippedPass(), mergeSkipped({ retained: "zero" })].join("\n");
    const metrics = collectAdvisoryMetrics(stderr);
    expect(metrics.status).toBe("missing");
    expect(metrics.detail).toContain("malformed");
  });

  test("rejects nonzero merge counts after a skipped pass", () => {
    const stderr = [skippedPass(), mergeSkipped({ retained: 1 })].join("\n");
    const metrics = collectAdvisoryMetrics(stderr);
    expect(metrics.status).toBe("missing");
    expect(metrics.detail).toContain("contradictory");
  });

  test("reports missing telemetry instead of silent zeros", () => {
    const stderr = [event("stage completed", { stage: "diff" }), event("context complete", {})].join("\n");
    const metrics = collectAdvisoryMetrics(stderr);
    expect(metrics.status).toBe("missing");
    expect(metrics.batches).toBe(0);
    expect(metrics.inputTokens).toBe(0);
    expect(metrics.detail).not.toBeNull();
  });

  test("reports empty stderr as missing", () => {
    const metrics = collectAdvisoryMetrics("");
    expect(metrics.status).toBe("missing");
    expect(metrics.detail).not.toBeNull();
  });

  test("rejects malformed numerics with field detail", () => {
    const metrics = collectAdvisoryMetrics(`${passCompleted({ batches: "two" })}\n${mergeCompleted()}`);
    expect(metrics.status).toBe("missing");
    expect(metrics.detail).toContain("batches");
  });

  test("ignores truncated and non-JSON lines", () => {
    const stderr = [
      "not json at all",
      '{"ts":"2026-01-01T00:00:00.000Z","level":"info","runId":"run-1","msg":"advisory pass comp',
      passCompleted(),
      mergeCompleted(),
    ].join("\n");
    expect(collectAdvisoryMetrics(stderr).status).toBe("completed");
  });

  test("matches event names exactly", () => {
    const events = parseJsonLogEvents(event("advisory pass completed v2", {}));
    expect(findLogEvent(events, ADVISORY_PASS_COMPLETED)).toBeNull();
    expect(findLogEvent(events, "advisory pass completed v2")).not.toBeNull();
  });

  test("rejects contradictory pass telemetry", () => {
    const stderr = [
      event(ADVISORY_PASS_SKIPPED, { projectedUnits: 0, skippedUnits: 0, batches: 0, codes: [] }),
      passCompleted(),
      mergeCompleted(),
    ].join("\n");
    const metrics = collectAdvisoryMetrics(stderr);
    expect(metrics.status).toBe("missing");
    expect(metrics.detail).toContain("contradictory");
  });

  test("requires a merge outcome after a completed pass", () => {
    expect(collectAdvisoryMetrics(passCompleted()).status).toBe("missing");
    expect(collectAdvisoryMetrics(passCompleted()).detail).toContain("merge");
  });

  test("accepts a skipped merge after a completed pass as retained zero", () => {
    const stderr = [passCompleted(), event(ADVISORY_MERGE_SKIPPED, { candidates: 0, retained: 0, codes: [] })].join(
      "\n",
    );
    const metrics = collectAdvisoryMetrics(stderr);
    expect(metrics.status).toBe("completed");
    expect(metrics.retained).toBe(0);
  });

  test("absorbs fail-open warning codes", () => {
    const stderr = [
      event("advisory conventions build failed open", {}),
      event(ADVISORY_PASS_SKIPPED, { projectedUnits: 0, skippedUnits: 0, batches: 0, codes: [] }),
      mergeSkipped(),
    ].join("\n");
    const metrics = collectAdvisoryMetrics(stderr);
    expect(metrics.status).toBe("skipped");
    expect(metrics.codes).toEqual(["advisory conventions build failed open"]);
  });

  test("absorbs batch-failure codes on completed passes", () => {
    const stderr = [
      event("advisory pass failed open", { codes: ["advisory_batch_failed"] }),
      passCompleted({ codes: ["advisory_batch_failed"] }),
      mergeCompleted({ retained: 1 }),
    ].join("\n");
    const metrics = collectAdvisoryMetrics(stderr);
    expect(metrics.status).toBe("completed");
    expect(metrics.codes).toEqual(["advisory pass failed open", "advisory_batch_failed"]);
  });
});

describe("eval advisory provenance", () => {
  test("keeps convention-advisory findings and drops primaries", () => {
    expect(isAdvisoryProvenance({ origin: { pass: "convention-advisory", unitId: "u1" } })).toBe(true);
    expect(isAdvisoryProvenance({ origin: { pass: "code-review-v1", unitId: "u1" } })).toBe(false);
    expect(isAdvisoryProvenance({ id: "x" })).toBe(false);
    expect(isAdvisoryProvenance(null)).toBe(false);
    expect(isAdvisoryProvenance("convention-advisory")).toBe(false);
  });
});
