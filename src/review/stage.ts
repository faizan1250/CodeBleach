import type { ReviewUnit } from "../types/context.ts";
import { emptyReviewUsage, type UnitOutcome } from "./result.ts";

// P4-08 stop reasons: caller cancellation wins over the stage deadline.
export type StopReason = "cancelled" | "deadline" | null;

export function stopCode(reason: StopReason): "REVIEW_CANCELLED" | "REVIEW_DEADLINE_EXCEEDED" | undefined {
  if (reason === "cancelled") return "REVIEW_CANCELLED";
  if (reason === "deadline") return "REVIEW_DEADLINE_EXCEEDED";
  return undefined;
}

// Units never started after a stop keep stable order with a content-free skip.
export function skipOutcome(unit: ReviewUnit, reason: "cancelled" | "deadline"): UnitOutcome {
  const code = reason === "cancelled" ? "REVIEW_CANCELLED" : "REVIEW_DEADLINE_EXCEEDED";
  return {
    ok: false,
    findings: [],
    diagnostics: [
      {
        stage: "unit",
        code,
        message:
          reason === "cancelled"
            ? "review unit skipped: run was cancelled before review started"
            : "review unit skipped: stage deadline expired before review started",
        unitId: unit.id,
        retryable: false,
      },
    ],
    usage: emptyReviewUsage(),
  };
}

export interface StageController {
  readonly signal: AbortSignal;
  stopped: () => StopReason;
  abort: (reason?: unknown) => void;
  dispose: () => void;
}

// One wall-clock ceiling over every per-unit request, transport retry,
// repair, and cap escalation. Zero means the deadline is already expired:
// no unit starts. Expired callers abort via the stage controller below;
// dispose in the finally always wins.
export function createStageController(callerSignal: AbortSignal | undefined, stageBudgetMs: number): StageController {
  const stage = new AbortController();
  let deadlineFired = false;
  const onCallerAbort = (): void => {
    if (!stage.signal.aborted) stage.abort(callerSignal?.reason);
  };
  if (callerSignal?.aborted === true) {
    stage.abort(callerSignal.reason);
  } else {
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (stageBudgetMs <= 0 || stage.signal.aborted) {
    deadlineFired = stageBudgetMs <= 0;
  } else {
    timer = setTimeout(() => {
      deadlineFired = true;
      stage.abort(new Error("review stage deadline expired"));
    }, stageBudgetMs);
  }
  return {
    signal: stage.signal,
    stopped: (): StopReason => {
      if (callerSignal?.aborted === true) return "cancelled";
      if (deadlineFired || stage.signal.aborted) return "deadline";
      return null;
    },
    abort: (reason?: unknown): void => {
      if (!stage.signal.aborted) stage.abort(reason);
    },
    dispose: (): void => {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}
