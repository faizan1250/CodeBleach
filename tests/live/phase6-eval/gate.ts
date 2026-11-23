// Offline adjudication gate for the Phase 6 live usefulness eval (P6-05).
//
// Usage:
//   bun tests/live/phase6-eval/gate.ts <labels.json> [results-dir]
//
// labels.json is an array of {prUrl, findingId, label, category, severity,
// ruleId?, notes?} with label in {useful, technically-correct-but-not-actionable,
// incorrect/unsupported} (see labels.template.json). results-dir defaults to
// tests/live/phase6-eval/results and supplies per-PR timings for the
// added-latency report. Exits 0 only when the plan 16.5 gate passes; otherwise
// prints reasons and exits 1. Never recommends routine enablement on failure.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluateGate, type LabeledAdvisoryCandidate } from "./eval-gate.ts";

const LABELS = ["useful", "technically-correct-but-not-actionable", "incorrect/unsupported"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseLabels(raw: unknown): LabeledAdvisoryCandidate[] {
  if (!Array.isArray(raw)) throw new Error("labels file must hold a JSON array");
  return raw.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`labels[${index}] must be an object`);
    const label = entry.label;
    if (typeof label !== "string" || !(LABELS as readonly string[]).includes(label)) {
      throw new Error(`labels[${index}].label must be one of ${LABELS.join(" | ")}`);
    }
    for (const field of ["prUrl", "findingId", "category", "severity"] as const) {
      if (typeof entry[field] !== "string" || (entry[field] as string).length === 0) {
        throw new Error(`labels[${index}].${field} must be a non-empty string`);
      }
    }
    if (entry.ruleId !== undefined && typeof entry.ruleId !== "string") {
      throw new Error(`labels[${index}].ruleId must be a string when present`);
    }
    return {
      prUrl: entry.prUrl as string,
      findingId: entry.findingId as string,
      label: label as LabeledAdvisoryCandidate["label"],
      category: entry.category as string,
      severity: entry.severity as string,
      ...(typeof entry.ruleId === "string" ? { ruleId: entry.ruleId as string } : {}),
    };
  });
}

function percentile(sorted: number[], rank: number): number {
  if (sorted.length === 0) return 0;
  const position = Math.min(sorted.length - 1, Math.floor(rank * sorted.length));
  return sorted[position] ?? 0;
}

async function latencyReport(resultsDir: string): Promise<Record<string, number>> {
  const added: number[] = [];
  let batches = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let retained = 0;
  let entries = 0;
  let files: string[] = [];
  try {
    files = (await readdir(resultsDir)).filter((file) => file.endsWith(".json") && file !== "manifest.json");
  } catch {
    return { entries: 0, medianAddedMs: 0, p95AddedMs: 0, batches: 0, inputTokens: 0, outputTokens: 0, retained: 0 };
  }
  for (const file of files) {
    try {
      const result = JSON.parse(await readFile(join(resultsDir, file), "utf8")) as {
        primaryOnly?: { ms?: number } | null;
        advisory?: {
          ms?: number;
          batches?: number;
          inputTokens?: number;
          outputTokens?: number;
          retained?: number;
        } | null;
        error?: string | null;
      };
      if (result.error !== null || result.primaryOnly?.ms === undefined || result.advisory?.ms === undefined) continue;
      entries += 1;
      added.push((result.advisory.ms ?? 0) - (result.primaryOnly.ms ?? 0));
      batches += result.advisory.batches ?? 0;
      inputTokens += result.advisory.inputTokens ?? 0;
      outputTokens += result.advisory.outputTokens ?? 0;
      retained += result.advisory.retained ?? 0;
    } catch {
      // Unreadable result files are skipped; readable entries still report.
    }
  }
  added.sort((a, b) => a - b);
  return {
    entries,
    medianAddedMs: percentile(added, 0.5),
    p95AddedMs: percentile(added, 0.95),
    batches,
    inputTokens,
    outputTokens,
    retained,
  };
}

if (import.meta.main) {
  const labelsPath = process.argv[2];
  if (labelsPath === undefined) {
    console.error("usage: bun tests/live/phase6-eval/gate.ts <labels.json> [results-dir]");
    process.exit(2);
  }
  const resultsDir = process.argv[3] ?? "tests/live/phase6-eval/results";
  const labels = parseLabels(JSON.parse(await readFile(labelsPath, "utf8")) as unknown);
  const gate = evaluateGate({ labels });
  const latency = await latencyReport(resultsDir);
  const report = {
    gate: gate.passed ? "pass" : "fail",
    totalCandidates: gate.totalCandidates,
    useful: gate.useful,
    usefulPrecision: gate.usefulPrecision,
    violations: gate.violations,
    reasons: gate.reasons,
    ...latency,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!gate.passed) {
    console.error(
      "evaluation gate failed: keep --convention-advisory for development/experiments; do not recommend routine use",
    );
    process.exit(1);
  }
}
