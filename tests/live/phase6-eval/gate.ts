// Offline adjudication gate for the Phase 6 live usefulness eval (P6-05).
//
// Usage:
//   bun tests/live/phase6-eval/gate.ts <labels.json> [results-dir]
//
// labels.json is an array of {prUrl, findingId, label, notes?} with label in
// {useful, technically-correct-but-not-actionable, incorrect/unsupported}
// (see labels.template.json). Category/severity/ruleId are NOT labels: they
// are derived from the emitted records in results-dir, and labels files that
// still carry them are rejected. results-dir defaults to
// tests/live/phase6-eval/results and holds per-PR harness records plus
// corpus.json next to this script. Exits 0 only when the plan 16.5 gate
// passes; otherwise prints reasons and exits 1. Never recommends routine
// enablement on failure.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluateGate, type EmittedAdvisoryCandidate, type LabeledAdvisoryCandidate } from "./eval-gate.ts";

const LABELS = ["useful", "technically-correct-but-not-actionable", "incorrect/unsupported"] as const;

// Bounded excerpts in reasons: full evidence lives in the result files.
const MAX_REASON_ITEMS = 5;
const MAX_DETAIL_CHARS = 120;

function truncate(text: string): string {
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text;
}

function nameItems(items: readonly string[]): string {
  const shown = items.slice(0, MAX_REASON_ITEMS).join(", ");
  return items.length > MAX_REASON_ITEMS ? `${shown}, and ${items.length - MAX_REASON_ITEMS} more` : shown;
}

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
    for (const field of ["prUrl", "findingId"] as const) {
      if (typeof entry[field] !== "string" || (entry[field] as string).length === 0) {
        throw new Error(`labels[${index}].${field} must be a non-empty string`);
      }
    }
    if (entry.notes !== undefined && typeof entry.notes !== "string") {
      throw new Error(`labels[${index}].notes must be a string when present`);
    }
    // Authority derives from emitted records: label metadata must not
    // smuggle category/severity/ruleId claims past the gate.
    for (const field of ["category", "severity", "ruleId"] as const) {
      if (entry[field] !== undefined) {
        throw new Error(
          `labels[${index}].${field} is not a label: category/severity/ruleId come from emitted results, remove it`,
        );
      }
    }
    return {
      prUrl: entry.prUrl as string,
      findingId: entry.findingId as string,
      label: label as LabeledAdvisoryCandidate["label"],
      ...(typeof entry.notes === "string" ? { notes: entry.notes as string } : {}),
    };
  });
}

interface CorpusEntry {
  repo: string;
  prUrl: string;
  pr: number;
}

function slugForRepoPr(repo: string, pr: number): string {
  // Must match slugFor in phase6-eval.test.ts: "<repo-with-dash>-<pr>".
  return `${repo.replace("/", "-")}-${pr}`;
}

interface ResultFinding {
  findingId: string;
  category: string;
  severity: string;
  ruleId?: string | undefined;
}

interface HarnessResult {
  slug: string;
  prUrl: string;
  error: string | null;
  advisory: {
    metricsStatus: string;
    metricsDetail: string | null;
    ms: number | null;
    batches: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
  } | null;
  primaryMs: number | null;
  findings: ResultFinding[];
}

function numericField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseHarnessResult(slug: string, raw: unknown): HarnessResult {
  if (!isRecord(raw)) throw new Error(`result ${slug}.json must hold a JSON object`);
  if (!isRecord(raw.entry) || typeof raw.entry.prUrl !== "string" || raw.entry.prUrl.length === 0) {
    throw new Error(`result ${slug}.json has no entry.prUrl string`);
  }
  const prUrl = raw.entry.prUrl;
  if (raw.error !== null && typeof raw.error !== "string") {
    throw new Error(`result ${slug}.json has a non-string error`);
  }
  if (raw.error !== null) {
    return { slug, prUrl, error: raw.error, advisory: null, primaryMs: null, findings: [] };
  }
  const primaryMs = isRecord(raw.primaryOnly) ? numericField(raw.primaryOnly.ms) : null;
  if (!isRecord(raw.advisory)) throw new Error(`result ${slug}.json completed without an advisory record`);
  const advisory = raw.advisory;
  if (typeof advisory.metricsStatus !== "string") {
    throw new Error(`result ${slug}.json advisory record has no metricsStatus`);
  }
  if (advisory.metricsDetail !== null && typeof advisory.metricsDetail !== "string") {
    throw new Error(`result ${slug}.json advisory record has a non-string metricsDetail`);
  }
  if (!Array.isArray(raw.advisoryFindings)) {
    throw new Error(`result ${slug}.json has no advisoryFindings array`);
  }
  const findings: ResultFinding[] = raw.advisoryFindings.map((candidate: unknown, index: number) => {
    if (!isRecord(candidate)) throw new Error(`result ${slug}.json advisoryFindings[${index}] must be an object`);
    for (const field of ["findingId", "file", "category", "severity"] as const) {
      if (typeof candidate[field] !== "string" || (candidate[field] as string).length === 0) {
        throw new Error(`result ${slug}.json advisoryFindings[${index}].${field} must be a non-empty string`);
      }
    }
    if (candidate.ruleId !== undefined && typeof candidate.ruleId !== "string") {
      throw new Error(`result ${slug}.json advisoryFindings[${index}].ruleId must be a string when present`);
    }
    return {
      findingId: candidate.findingId as string,
      category: candidate.category as string,
      severity: candidate.severity as string,
      ...(typeof candidate.ruleId === "string" ? { ruleId: candidate.ruleId as string } : {}),
    };
  });
  return {
    slug,
    prUrl,
    error: null,
    advisory: {
      metricsStatus: advisory.metricsStatus as string,
      metricsDetail: (advisory.metricsDetail as string | null) ?? null,
      ms: numericField(advisory.ms),
      batches: numericField(advisory.batches),
      inputTokens: numericField(advisory.inputTokens),
      outputTokens: numericField(advisory.outputTokens),
    },
    primaryMs,
    findings,
  };
}

function percentile(sorted: number[], rank: number): number {
  if (sorted.length === 0) return 0;
  const position = Math.min(sorted.length - 1, Math.floor(rank * sorted.length));
  return sorted[position] ?? 0;
}

interface LatencyInput {
  primaryMs: number | null;
  advisoryMs: number | null;
  batches: number;
  inputTokens: number;
  outputTokens: number;
  retained: number;
  metricsOk: boolean;
}

function latencyReport(inputs: LatencyInput[]): {
  entries: number;
  medianAddedMs: number;
  p95AddedMs: number;
  batches: number;
  inputTokens: number;
  outputTokens: number;
  retained: number;
} {
  const added: number[] = [];
  let batches = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let retained = 0;
  let entries = 0;
  for (const input of inputs) {
    // Metrics columns only aggregate runs with observed (never zero-filled)
    // telemetry; missing-metrics runs fail the gate separately.
    if (!input.metricsOk || input.primaryMs === null || input.advisoryMs === null) continue;
    entries += 1;
    added.push(input.advisoryMs - input.primaryMs);
    batches += input.batches;
    inputTokens += input.inputTokens;
    outputTokens += input.outputTokens;
    retained += input.retained;
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

async function loadGateInputs(
  resultsDir: string,
): Promise<{
  emitted: EmittedAdvisoryCandidate[];
  knownPrUrls: string[];
  healthReasons: string[];
  latency: LatencyInput[];
  metricsBad: string[];
}> {
  const scriptDir = import.meta.dir;
  const corpus = JSON.parse(await readFile(join(scriptDir, "corpus.json"), "utf8")) as CorpusEntry[];
  const knownPrUrls = corpus.map((entry) => entry.prUrl);
  if (new Set(knownPrUrls).size !== knownPrUrls.length) {
    throw new Error("corpus.json holds duplicate prUrl entries");
  }
  const bySlug = new Map(corpus.map((entry) => [slugForRepoPr(entry.repo, entry.pr), entry.prUrl] as const));

  const healthReasons: string[] = [];
  let files: string[] = [];
  try {
    files = (await readdir(resultsDir)).filter((file) => file.endsWith(".json") && file !== "manifest.json");
  } catch {
    return {
      emitted: [],
      knownPrUrls,
      healthReasons: [`results dir unreadable: ${resultsDir}`],
      latency: [],
      metricsBad: [],
    };
  }
  const seen = new Set<string>();
  const emitted: EmittedAdvisoryCandidate[] = [];
  const latency: LatencyInput[] = [];
  const metricsBad: string[] = [];
  for (const file of files.sort()) {
    const slug = file.slice(0, -".json".length);
    const expectedPrUrl = bySlug.get(slug);
    if (expectedPrUrl === undefined) {
      healthReasons.push(`result for unknown PR (not in corpus.json): ${file}`);
      continue;
    }
    seen.add(slug);
    let parsed: HarnessResult;
    try {
      parsed = parseHarnessResult(slug, JSON.parse(await readFile(join(resultsDir, file), "utf8")) as unknown);
    } catch (error) {
      healthReasons.push(`invalid result ${file}: ${truncate(error instanceof Error ? error.message : String(error))}`);
      continue;
    }
    if (parsed.prUrl !== expectedPrUrl) {
      healthReasons.push(`result ${file} is for ${parsed.prUrl}, expected ${expectedPrUrl ?? "(unknown)"}`);
      continue;
    }
    if (parsed.error !== null) {
      healthReasons.push(`failed run for ${parsed.prUrl}: ${truncate(parsed.error)}`);
      continue;
    }
    if (parsed.advisory === null) {
      healthReasons.push(`incomplete run for ${parsed.prUrl}: advisory record absent`);
      continue;
    }
    if (parsed.advisory.metricsStatus === "missing") {
      metricsBad.push(
        `${parsed.prUrl}${parsed.advisory.metricsDetail === null ? "" : `: ${truncate(parsed.advisory.metricsDetail)}`}`,
      );
    }
    for (const finding of parsed.findings) {
      emitted.push({
        prUrl: parsed.prUrl,
        findingId: finding.findingId,
        category: finding.category,
        severity: finding.severity,
        ...(finding.ruleId === undefined ? {} : { ruleId: finding.ruleId }),
      });
    }
    // Wall-clock and token columns for the added-latency report. Numeric
    // fields were validated as finite numbers at parse time; non-finite
    // values are dropped from the report rather than zero-filled.
    const metricsOk = parsed.advisory.metricsStatus !== "missing";
    latency.push({
      primaryMs: parsed.primaryMs,
      advisoryMs: parsed.advisory.ms,
      batches: parsed.advisory.batches ?? 0,
      inputTokens: parsed.advisory.inputTokens ?? 0,
      outputTokens: parsed.advisory.outputTokens ?? 0,
      retained: parsed.findings.length,
      metricsOk,
    });
  }
  for (const [slug, prUrl] of [...bySlug.entries()].sort()) {
    if (!seen.has(slug)) healthReasons.push(`missing result for ${prUrl} (expected ${slug}.json)`);
  }
  return { emitted, knownPrUrls, healthReasons, latency, metricsBad };
}

if (import.meta.main) {
  const labelsPath = process.argv[2];
  if (labelsPath === undefined) {
    console.error("usage: bun tests/live/phase6-eval/gate.ts <labels.json> [results-dir]");
    process.exit(2);
  }
  const resultsDir = process.argv[3] ?? "tests/live/phase6-eval/results";
  const labels = parseLabels(JSON.parse(await readFile(labelsPath, "utf8")) as unknown);
  const { emitted, knownPrUrls, healthReasons, latency, metricsBad } = await loadGateInputs(resultsDir);
  const gate = evaluateGate({ labels, emitted, knownPrUrls });
  const reasons = [...healthReasons, ...gate.reasons];
  if (metricsBad.length > 0) {
    reasons.push(`advisory metrics missing for ${metricsBad.length} result(s): ${nameItems(metricsBad)}`);
  }
  const report = {
    gate: reasons.length === 0 ? "pass" : "fail",
    totalCandidates: gate.totalCandidates,
    useful: gate.useful,
    usefulPrecision: gate.usefulPrecision,
    violations: gate.violations,
    missing: gate.missing,
    unmatched: gate.unmatched,
    duplicates: gate.duplicates,
    reasons,
    ...latencyReport(latency),
  };
  console.log(JSON.stringify(report, null, 2));
  if (reasons.length > 0) {
    console.error(
      "evaluation gate failed: keep --convention-advisory for development/experiments; do not recommend routine use",
    );
    process.exit(1);
  }
}
