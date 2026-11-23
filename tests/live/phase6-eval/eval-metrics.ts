// Structured advisory-metrics parsing for the Phase 6 live eval harness.
//
// Pure offline helpers: no I/O, no network, no logging. Production code never
// imports this module. Every parse is a full JSON decode with exact `msg`
// matching and finite-number validation: substring matching, silent zeros,
// and missing-event telemetry are all rejected explicitly so the gate can
// never report unmeasured zeros as observed usage.

export const ADVISORY_PASS_COMPLETED = "advisory pass completed";
export const ADVISORY_PASS_SKIPPED = "advisory pass skipped";
export const ADVISORY_MERGE_COMPLETED = "advisory merge completed";
export const ADVISORY_MERGE_SKIPPED = "advisory merge skipped";

// Fail-open warn outcomes the harness treats as bounded diagnostics. The
// pipeline-level "advisory pass failed open" (thrown, not returned) is
// included: it means the pass produced no metrics event at all.
export const ADVISORY_FAIL_OPEN_WARNINGS: readonly string[] = [
  "advisory conventions build failed open",
  "advisory projection failed open",
  "advisory pass failed open",
  "advisory merge failed open",
];

// completed: pass completed event plus a merge outcome (completed, skipped,
// or fail-open warn) were all observed. skipped: the pass emitted its skipped
// event plus exactly one merge-skipped outcome (a skipped pass yields no
// findings, so any other merge outcome is contradictory). missing: no usable
// telemetry (absent, contradictory, duplicated, or malformed events).
export type AdvisoryMetricsStatus = "completed" | "skipped" | "missing";

export interface AdvisoryStderrMetrics {
  status: AdvisoryMetricsStatus;
  batches: number;
  inputTokens: number;
  outputTokens: number;
  projectedUnits: number;
  skippedUnits: number;
  candidates: number;
  retained: number;
  codes: string[];
  /** Bounded reason when status is missing; null otherwise. */
  detail: string | null;
}

type JsonEvent = Record<string, unknown>;

// Bounded detail strings: telemetry excerpts never grow with log volume.
const MAX_DETAIL_CHARS = 300;

function truncate(text: string): string {
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text;
}

function isRecord(value: unknown): value is JsonEvent {
  return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    out.push(entry);
  }
  return out;
}

/**
 * Decodes every JSON object line in stderr. Non-JSON lines (usage text,
 * progress output, truncated tails) are ignored; callers match on exact
 * `msg` values, never substrings.
 */
export function parseJsonLogEvents(stderr: string): JsonEvent[] {
  const events: JsonEvent[] = [];
  for (const line of stderr.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) events.push(parsed);
    } catch {
      // Truncated or non-JSON line: not telemetry, skip without failing.
    }
  }
  return events;
}

/** Exact-`msg` lookup over decoded events; null when the event is absent. */
export function findLogEvent(events: readonly JsonEvent[], msg: string): JsonEvent | null {
  for (const event of events) {
    if (event.msg === msg) return event;
  }
  return null;
}

/** Exact-`msg` occurrence count; duplicates are contradictory telemetry. */
export function countLogEvents(events: readonly JsonEvent[], msg: string): number {
  let count = 0;
  for (const event of events) {
    if (event.msg === msg) count += 1;
  }
  return count;
}

/**
 * Advisory provenance check for harness candidate extraction: only findings
 * whose origin pass is exactly `convention-advisory` enter the gate, so
 * primary findings from the paired advisory run can never leak into labels.
 */
export function isAdvisoryProvenance(finding: unknown): boolean {
  if (!isRecord(finding)) return false;
  const origin = finding.origin;
  return isRecord(origin) && origin.pass === "convention-advisory";
}

function takeNumbers(event: JsonEvent, names: readonly string[], failures: string[]): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const name of names) {
    const value = finiteNumber(event[name]);
    if (value === null) {
      failures.push(name);
    } else {
      out[name] = value;
    }
  }
  return failures.length === 0 ? out : null;
}

/**
 * Collects advisory metrics from advisory-run stderr. Never returns
 * silent zeros: zeros are only reported alongside a completed or skipped
 * event that carries them; anything else is status missing with a bounded
 * detail naming the absent or malformed evidence.
 */
export function collectAdvisoryMetrics(stderr: string): AdvisoryStderrMetrics {
  const zero: AdvisoryStderrMetrics = {
    status: "missing",
    batches: 0,
    inputTokens: 0,
    outputTokens: 0,
    projectedUnits: 0,
    skippedUnits: 0,
    candidates: 0,
    retained: 0,
    codes: [],
    detail: null,
  };
  const events = parseJsonLogEvents(stderr);
  const completed = findLogEvent(events, ADVISORY_PASS_COMPLETED);
  const skipped = findLogEvent(events, ADVISORY_PASS_SKIPPED);
  if (completed !== null && skipped !== null) {
    return { ...zero, detail: "contradictory advisory pass events: both completed and skipped present" };
  }
  const codes: string[] = [];
  // Fail-open warns are recorded by their static message (allowlisted
  // constants, never dynamic text) plus any codes they carry: the build and
  // projection early exits log no codes field, so the message is the only
  // trace of which exit fired.
  const absorbWarning = (warning: string): void => {
    const warnEvent = findLogEvent(events, warning);
    if (warnEvent === null) return;
    if (!codes.includes(warning)) codes.push(warning);
    const list = stringList(warnEvent.codes);
    if (list === null) return;
    for (const code of list) {
      if (!codes.includes(code)) codes.push(code);
    }
  };
  for (const warning of ADVISORY_FAIL_OPEN_WARNINGS) {
    absorbWarning(warning);
  }
  const absorbCodes = (codeEvent: JsonEvent | null): void => {
    if (codeEvent === null) return;
    const list = stringList(codeEvent.codes);
    if (list === null) return;
    for (const code of list) {
      if (!codes.includes(code)) codes.push(code);
    }
  };
  if (skipped !== null) {
    if (countLogEvents(events, ADVISORY_PASS_SKIPPED) > 1) {
      return { ...zero, codes, detail: `duplicate ${ADVISORY_PASS_SKIPPED} events` };
    }
    const failures: string[] = [];
    const numbers = takeNumbers(skipped, ["projectedUnits", "skippedUnits", "batches"], failures);
    if (numbers === null) {
      return { ...zero, codes, detail: `malformed ${ADVISORY_PASS_SKIPPED} event: ${truncate(failures.join(", "))}` };
    }
    absorbCodes(skipped);
    // A skipped pass runs no provider work and yields no findings, so the
    // merge must record exactly one skipped outcome. Merge-completed is
    // unreachable with zero findings; anything else is contradictory,
    // duplicated, or lost telemetry, never a genuine zero.
    if (findLogEvent(events, ADVISORY_MERGE_COMPLETED) !== null) {
      return {
        ...zero,
        codes,
        detail: `contradictory advisory merge outcome after ${ADVISORY_PASS_SKIPPED}: merge completed observed`,
      };
    }
    const mergeSkipped = findLogEvent(events, ADVISORY_MERGE_SKIPPED);
    if (mergeSkipped === null) {
      return { ...zero, codes, detail: `missing advisory merge outcome after ${ADVISORY_PASS_SKIPPED}` };
    }
    if (countLogEvents(events, ADVISORY_MERGE_SKIPPED) > 1) {
      return { ...zero, codes, detail: `duplicate ${ADVISORY_MERGE_SKIPPED} events` };
    }
    const mergeFailures: string[] = [];
    const mergeNumbers = takeNumbers(mergeSkipped, ["candidates", "retained"], mergeFailures);
    if (mergeNumbers === null) {
      return {
        ...zero,
        codes,
        detail: `malformed ${ADVISORY_MERGE_SKIPPED} event: ${truncate(mergeFailures.join(", "))}`,
      };
    }
    if ((mergeNumbers.candidates ?? 0) !== 0 || (mergeNumbers.retained ?? 0) !== 0) {
      return {
        ...zero,
        codes,
        detail: `contradictory advisory merge outcome after ${ADVISORY_PASS_SKIPPED}: skipped merge carries nonzero counts`,
      };
    }
    absorbCodes(mergeSkipped);
    return {
      status: "skipped",
      batches: numbers.batches ?? 0,
      inputTokens: 0,
      outputTokens: 0,
      projectedUnits: numbers.projectedUnits ?? 0,
      skippedUnits: numbers.skippedUnits ?? 0,
      candidates: 0,
      retained: 0,
      codes,
      detail: null,
    };
  }
  if (completed === null) {
    const observed = events.length === 0 ? "no JSON log events" : `${events.length} JSON event(s), none advisory`;
    return { ...zero, codes, detail: `missing advisory pass telemetry: ${observed}` };
  }
  const failures: string[] = [];
  const numbers = takeNumbers(
    completed,
    ["batches", "inputTokens", "outputTokens", "projectedUnits", "skippedUnits", "candidates"],
    failures,
  );
  if (numbers === null) {
    return { ...zero, codes, detail: `malformed ${ADVISORY_PASS_COMPLETED} event: ${truncate(failures.join(", "))}` };
  }
  absorbCodes(completed);
  const mergeCompleted = findLogEvent(events, ADVISORY_MERGE_COMPLETED);
  const mergeSkipped = findLogEvent(events, ADVISORY_MERGE_SKIPPED);
  if (mergeCompleted !== null && mergeSkipped !== null) {
    return { ...zero, codes, detail: "contradictory advisory merge events: both completed and skipped present" };
  }
  if (mergeCompleted === null && mergeSkipped === null) {
    return { ...zero, codes, detail: `missing advisory merge outcome after ${ADVISORY_PASS_COMPLETED}` };
  }
  absorbCodes(mergeCompleted);
  absorbCodes(mergeSkipped);
  let retained = 0;
  if (mergeCompleted !== null) {
    const mergeFailures: string[] = [];
    const mergeNumbers = takeNumbers(mergeCompleted, ["retained"], mergeFailures);
    if (mergeNumbers === null) {
      return {
        ...zero,
        codes,
        detail: `malformed ${ADVISORY_MERGE_COMPLETED} event: ${truncate(mergeFailures.join(", "))}`,
      };
    }
    retained = mergeNumbers.retained ?? 0;
  }
  return {
    status: "completed",
    batches: numbers.batches ?? 0,
    inputTokens: numbers.inputTokens ?? 0,
    outputTokens: numbers.outputTokens ?? 0,
    projectedUnits: numbers.projectedUnits ?? 0,
    skippedUnits: numbers.skippedUnits ?? 0,
    candidates: numbers.candidates ?? 0,
    retained,
    codes,
    detail: null,
  };
}
