import { describe, expect, test } from "bun:test";
import { createStageController, skipOutcome, stopCode } from "../../src/review/stage.ts";
import type { ReviewUnit } from "../../src/types/context.ts";

function unit(id = "unit-1"): ReviewUnit {
  return {
    id,
    file: {
      path: "src/auth.ts",
      oldPath: null,
      status: "modified",
      language: "typescript",
      commentableLines: [9],
    },
    diff: {
      hunks: [],
      originalHunkCount: 0,
      includedHunkCount: 0,
      omittedHunkCount: 0,
      truncated: false,
    },
    symbol: { name: "check", kind: "function", startLine: 8, endLine: 14, changedLines: [9] },
    context: [],
    rules: [],
  };
}

describe("stopCode", () => {
  test("maps stop reasons to error codes", () => {
    expect(stopCode("cancelled")).toBe("REVIEW_CANCELLED");
    expect(stopCode("deadline")).toBe("REVIEW_DEADLINE_EXCEEDED");
    expect(stopCode(null)).toBeUndefined();
  });
});

describe("skipOutcome", () => {
  test("emits content-free cancelled skip bound to the unit", () => {
    const outcome = skipOutcome(unit("u-7"), "cancelled");
    expect(outcome.ok).toBe(false);
    expect(outcome.findings).toHaveLength(0);
    expect(outcome.diagnostics).toHaveLength(1);
    expect(outcome.diagnostics[0]).toMatchObject({ stage: "unit", code: "REVIEW_CANCELLED", unitId: "u-7" });
  });

  test("emits deadline skip with distinct code and message", () => {
    const outcome = skipOutcome(unit("u-7"), "deadline");
    expect(outcome.diagnostics[0]?.code).toBe("REVIEW_DEADLINE_EXCEEDED");
    expect(outcome.diagnostics[0]?.message).toContain("deadline");
  });
});

describe("createStageController", () => {
  test("zero budget stops immediately without starting the timer", () => {
    const stage = createStageController(undefined, 0);
    try {
      expect(stage.stopped()).toBe("deadline");
      expect(stage.signal.aborted).toBe(false);
    } finally {
      stage.dispose();
    }
  });

  test("pre-aborted caller reports cancelled", () => {
    const caller = new AbortController();
    caller.abort(new Error("caller went away"));
    const stage = createStageController(caller.signal, 600000);
    try {
      expect(stage.stopped()).toBe("cancelled");
      expect(stage.signal.aborted).toBe(true);
    } finally {
      stage.dispose();
    }
  });

  test("live controller is unstopped and dispose detaches the caller listener", () => {
    const caller = new AbortController();
    const stage = createStageController(caller.signal, 600000);
    expect(stage.stopped()).toBe(null);
    expect(stage.signal.aborted).toBe(false);
    stage.dispose();
    caller.abort(new Error("late abort"));
    expect(stage.signal.aborted).toBe(false);
    expect(stage.stopped()).toBe("cancelled");
    stage.dispose();
  });

  test("caller abort mid-run flips the controller to cancelled", () => {
    const caller = new AbortController();
    const stage = createStageController(caller.signal, 600000);
    try {
      caller.abort(new Error("cancel now"));
      expect(stage.stopped()).toBe("cancelled");
      expect(stage.signal.aborted).toBe(true);
    } finally {
      stage.dispose();
    }
  });
});
