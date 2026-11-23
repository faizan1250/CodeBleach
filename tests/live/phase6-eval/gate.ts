// Offline adjudication gate for the Phase 6 live usefulness eval (P6-05).
//
// Usage:
//   bun tests/live/phase6-eval/gate.ts <labels.json> [results-dir] [--repos-root <dir>]
//
// labels.json is an array of {prUrl, findingId, label, notes?} with label in
// {useful, technically-correct-but-not-actionable, incorrect/unsupported}
// (see labels.template.json). Category/severity/ruleId are NOT labels: they
// are derived from the emitted records in results-dir, and labels files that
// still carry them are rejected. results-dir defaults to
// tests/live/phase6-eval/results and holds per-PR harness records plus
// corpus.json next to this script. --repos-root defaults to
// <cwd>/../phase6-eval-repos (same as the harness) and supplies the
// full-history checkouts the gate uses to recompute each merge-base.
//
// Measurement integrity beyond the 16.5 thresholds: corpus.json must pin at
// least 30 merged PRs across at least 5 repos with unique PR URLs; every
// result file must carry provenance (repo, repoUrl, PR number/URL, pinned
// base/head SHAs) matching its corpus pin exactly with a well-formed
// recomputed merge-base that history confirms; results/manifest.json is the
// run index and must list exactly the current run's result files with
// identical provenance. Anything missing, mismatched, stale, unknown, or
// malformed fails the gate. Exits 0 only when the plan 16.5 gate passes;
// otherwise prints reasons and exits 1. Never recommends routine
// enablement on failure.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../../helpers/git-repo.ts";
import { evaluateGate, type EmittedAdvisoryCandidate, type LabeledAdvisoryCandidate } from "./eval-gate.ts";

const LABELS = ["useful", "technically-correct-but-not-actionable", "incorrect/unsupported"] as const;

const METRICS_STATUSES = ["completed", "skipped", "missing"] as const;

type MetricsStatus = (typeof METRICS_STATUSES)[number];

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
  repoUrl: string;
  pr: number;
  prUrl: string;
  baseSha: string;
  baseRef: string;
  headSha: string;
  mergedAt: string;
  title: string;
  filesChanged: number;
}

// Closure floor: the gate trusts only a full pinned sweep, never a subset.
export const MIN_CORPUS_PRS = 30;
export const MIN_CORPUS_REPOS = 5;

const SHA40 = /^[0-9a-f]{40}$/;
const REPO_NAME = /^[^/\s]+\/[^/\s]+$/;

function parseCorpusEntry(index: number, raw: unknown): CorpusEntry {
  const label = `corpus.json[${index}]`;
  if (!isRecord(raw)) throw new Error(`${label} must be an object`);
  if (typeof raw.repo !== "string" || !REPO_NAME.test(raw.repo)) {
    throw new Error(`${label}.repo must be "owner/name"`);
  }
  if (raw.repoUrl !== `https://github.com/${raw.repo}`) {
    throw new Error(`${label}.repoUrl must be https://github.com/${raw.repo}`);
  }
  if (!Number.isSafeInteger(raw.pr) || (raw.pr as number) <= 0) {
    throw new Error(`${label}.pr must be a positive integer`);
  }
  if (raw.prUrl !== `${raw.repoUrl as string}/pull/${raw.pr as number}`) {
    throw new Error(`${label}.prUrl must be ${raw.repoUrl as string}/pull/${raw.pr as number}`);
  }
  for (const field of ["baseSha", "headSha"] as const) {
    if (typeof raw[field] !== "string" || !SHA40.test(raw[field] as string)) {
      throw new Error(`${label}.${field} must be a 40-hex commit SHA`);
    }
  }
  if (typeof raw.mergedAt !== "string" || raw.mergedAt.length === 0) {
    throw new Error(`${label}.mergedAt must be a non-empty string (only merged PRs count)`);
  }
  return {
    repo: raw.repo,
    repoUrl: raw.repoUrl as string,
    pr: raw.pr as number,
    prUrl: raw.prUrl as string,
    baseSha: raw.baseSha as string,
    baseRef: typeof raw.baseRef === "string" ? (raw.baseRef as string) : "",
    headSha: raw.headSha as string,
    mergedAt: raw.mergedAt,
    title: typeof raw.title === "string" ? (raw.title as string) : "",
    filesChanged: typeof raw.filesChanged === "number" ? (raw.filesChanged as number) : 0,
  };
}

export function parseCorpus(raw: unknown): CorpusEntry[] {
  if (!Array.isArray(raw)) throw new Error("corpus.json must hold a JSON array");
  if (raw.length < MIN_CORPUS_PRS) {
    throw new Error(`corpus.json holds ${raw.length} entries, need at least ${MIN_CORPUS_PRS}`);
  }
  const entries = raw.map((candidate, index) => parseCorpusEntry(index, candidate));
  const prUrls = new Set<string>();
  const slugs = new Set<string>();
  const repos = new Set<string>();
  for (const entry of entries) {
    if (prUrls.has(entry.prUrl)) throw new Error(`corpus.json holds duplicate prUrl: ${entry.prUrl}`);
    prUrls.add(entry.prUrl);
    const slug = slugForRepoPr(entry.repo, entry.pr);
    if (slugs.has(slug)) throw new Error(`corpus.json holds duplicate result slug: ${slug}`);
    slugs.add(slug);
    repos.add(entry.repo);
  }
  if (repos.size < MIN_CORPUS_REPOS) {
    throw new Error(`corpus.json spans ${repos.size} repos, need at least ${MIN_CORPUS_REPOS}`);
  }
  return entries;
}

// Provenance carried by every result file and manifest record: the corpus
// pin it claims to measure. The loader matches all six fields against the
// corpus pin and recomputes the merge-base from checkout history.
export interface ResultProvenance {
  repo: string;
  repoUrl: string;
  pr: number;
  prUrl: string;
  baseSha: string;
  headSha: string;
}

function parseProvenance(source: string, entry: unknown): ResultProvenance {
  if (!isRecord(entry)) throw new Error(`${source} has no entry object`);
  if (typeof entry.repo !== "string" || !REPO_NAME.test(entry.repo)) {
    throw new Error(`${source} has malformed provenance: repo must be "owner/name"`);
  }
  if (typeof entry.repoUrl !== "string" || entry.repoUrl.length === 0) {
    throw new Error(`${source} has malformed provenance: repoUrl must be a non-empty string`);
  }
  if (!Number.isSafeInteger(entry.pr) || (entry.pr as number) <= 0) {
    throw new Error(`${source} has malformed provenance: pr must be a positive integer`);
  }
  if (typeof entry.prUrl !== "string" || entry.prUrl.length === 0) {
    throw new Error(`${source} has malformed provenance: prUrl must be a non-empty string`);
  }
  for (const field of ["baseSha", "headSha"] as const) {
    if (typeof entry[field] !== "string" || !SHA40.test(entry[field] as string)) {
      throw new Error(`${source} has malformed provenance: ${field} must be a 40-hex commit SHA`);
    }
  }
  return {
    repo: entry.repo,
    repoUrl: entry.repoUrl,
    pr: entry.pr as number,
    prUrl: entry.prUrl,
    baseSha: entry.baseSha as string,
    headSha: entry.headSha as string,
  };
}

function parseMergeBase(source: string, raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string" || !SHA40.test(raw)) {
    throw new Error(`${source} has a malformed mergeBase: expected the recomputed 40-hex merge-base`);
  }
  return raw;
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
  provenance: ResultProvenance;
  mergeBase: string | null;
  error: string | null;
  advisory: {
    metricsStatus: MetricsStatus;
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

export function parseHarnessResult(slug: string, raw: unknown): HarnessResult {
  const source = `result ${slug}.json`;
  if (!isRecord(raw)) throw new Error(`${source} must hold a JSON object`);
  const provenance = parseProvenance(source, raw.entry);
  if (raw.error !== null && typeof raw.error !== "string") {
    throw new Error(`${source} has a non-string error`);
  }
  const mergeBase = parseMergeBase(source, raw.mergeBase ?? null);
  if (raw.error !== null) {
    return { slug, provenance, mergeBase, error: raw.error, advisory: null, primaryMs: null, findings: [] };
  }
  if (mergeBase === null) {
    throw new Error(`${source} completed without a mergeBase: expected the recomputed 40-hex merge-base`);
  }
  const primaryMs = isRecord(raw.primaryOnly) ? numericField(raw.primaryOnly.ms) : null;
  if (!isRecord(raw.advisory)) throw new Error(`${source} completed without an advisory record`);
  const advisory = raw.advisory;
  if (
    typeof advisory.metricsStatus !== "string" ||
    !(METRICS_STATUSES as readonly string[]).includes(advisory.metricsStatus)
  ) {
    throw new Error(`${source} advisory record has an unknown metricsStatus`);
  }
  if (advisory.metricsDetail !== null && typeof advisory.metricsDetail !== "string") {
    throw new Error(`${source} advisory record has a non-string metricsDetail`);
  }
  if (!Array.isArray(raw.advisoryFindings)) {
    throw new Error(`${source} has no advisoryFindings array`);
  }
  const findings: ResultFinding[] = raw.advisoryFindings.map((candidate: unknown, index: number) => {
    if (!isRecord(candidate)) throw new Error(`${source} advisoryFindings[${index}] must be an object`);
    for (const field of ["findingId", "file", "category", "severity"] as const) {
      if (typeof candidate[field] !== "string" || (candidate[field] as string).length === 0) {
        throw new Error(`${source} advisoryFindings[${index}].${field} must be a non-empty string`);
      }
    }
    if (candidate.ruleId !== undefined && typeof candidate.ruleId !== "string") {
      throw new Error(`${source} advisoryFindings[${index}].ruleId must be a string when present`);
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
    provenance,
    mergeBase,
    error: null,
    advisory: {
      metricsStatus: advisory.metricsStatus as MetricsStatus,
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

export interface ManifestRecord {
  slug: string;
  provenance: ResultProvenance;
  mergeBase: string | null;
}

export function parseManifest(raw: unknown): ManifestRecord[] {
  if (!Array.isArray(raw)) throw new Error("manifest.json must hold a JSON array");
  const records = raw.map((candidate, index) => {
    const source = `manifest.json[${index}]`;
    if (!isRecord(candidate)) throw new Error(`${source} must be an object`);
    if (typeof candidate.slug !== "string" || candidate.slug.length === 0) {
      throw new Error(`${source}.slug must be a non-empty string`);
    }
    return {
      slug: candidate.slug,
      provenance: parseProvenance(source, candidate.entry),
      mergeBase: parseMergeBase(source, candidate.mergeBase ?? null),
    };
  });
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.slug)) throw new Error(`manifest.json holds duplicate slug: ${record.slug}`);
    seen.add(record.slug);
  }
  return records;
}

// manifest.json is the run index: the gate trusts only the current run, so
// every result file must be indexed with identical provenance and every
// manifest entry must have its file. Compares provenance plus merge-base,
// the freshness-relevant subset; emitted findings are joined later.
export function checkManifestConsistency(
  manifest: readonly ManifestRecord[],
  files: ReadonlyMap<string, { provenance: ResultProvenance; mergeBase: string | null }>,
): string[] {
  const reasons: string[] = [];
  const indexed = new Map(manifest.map((record) => [record.slug, record] as const));
  for (const slug of [...files.keys()].sort()) {
    if (!indexed.has(slug)) {
      reasons.push(`result ${slug}.json absent from manifest.json (stale run dir or stale manifest)`);
    }
  }
  const provenanceFields: (keyof ResultProvenance)[] = ["repo", "repoUrl", "pr", "prUrl", "baseSha", "headSha"];
  for (const record of [...manifest].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))) {
    const file = files.get(record.slug);
    if (file === undefined) {
      reasons.push(`manifest lists ${record.slug} with no result file (stale manifest or unknown PR)`);
      continue;
    }
    const drifted =
      file.mergeBase !== record.mergeBase ||
      provenanceFields.some((field) => file.provenance[field] !== record.provenance[field]);
    if (drifted) {
      reasons.push(
        `manifest entry for ${record.slug} differs from ${record.slug}.json (stale manifest or edited result)`,
      );
    }
  }
  return reasons;
}

export interface MergeBaseQuery {
  checkoutDir: string;
  baseSha: string;
  headSha: string;
}

export type MergeBaseResolver = (query: MergeBaseQuery) => Promise<string>;

// Read-only history check reusing the harness git helper: merge-base only,
// the same command the harness runs before each paired CLI invocation.
async function defaultResolveMergeBase(query: MergeBaseQuery): Promise<string> {
  return (await git(query.checkoutDir, ["merge-base", query.baseSha, query.headSha])).trim();
}

export interface GateLoaderOptions {
  reposRoot?: string | undefined;
  resolveMergeBase?: MergeBaseResolver | undefined;
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

export async function loadGateInputs(
  resultsDir: string,
  opts: GateLoaderOptions = {},
): Promise<{
  emitted: EmittedAdvisoryCandidate[];
  knownPrUrls: string[];
  healthReasons: string[];
  latency: LatencyInput[];
  metricsBad: string[];
}> {
  const scriptDir = import.meta.dir;
  let corpus: CorpusEntry[];
  try {
    corpus = parseCorpus(JSON.parse(await readFile(join(scriptDir, "corpus.json"), "utf8")) as unknown);
  } catch (error) {
    return {
      emitted: [],
      knownPrUrls: [],
      healthReasons: [`invalid corpus.json: ${truncate(error instanceof Error ? error.message : String(error))}`],
      latency: [],
      metricsBad: [],
    };
  }
  const knownPrUrls = corpus.map((entry) => entry.prUrl);
  const bySlug = new Map(corpus.map((entry) => [slugForRepoPr(entry.repo, entry.pr), entry] as const));
  // Same default as the harness sweep so the gate recomputes history where
  // the results were produced.
  const reposRoot = opts.reposRoot ?? join(process.cwd(), "..", "phase6-eval-repos");
  const resolveMergeBase = opts.resolveMergeBase ?? defaultResolveMergeBase;

  const healthReasons: string[] = [];
  let manifest: ManifestRecord[] | null = null;
  try {
    manifest = parseManifest(JSON.parse(await readFile(join(resultsDir, "manifest.json"), "utf8")) as unknown);
  } catch (error) {
    healthReasons.push(
      `manifest.json absent or invalid: ${truncate(error instanceof Error ? error.message : String(error))} (gate consumes the current run only)`,
    );
  }

  let files: string[] = [];
  try {
    files = (await readdir(resultsDir)).filter((file) => file.endsWith(".json") && file !== "manifest.json");
  } catch {
    return {
      emitted: [],
      knownPrUrls,
      healthReasons: [...healthReasons, `results dir unreadable: ${resultsDir}`],
      latency: [],
      metricsBad: [],
    };
  }
  const seen = new Set<string>();
  const emitted: EmittedAdvisoryCandidate[] = [];
  const latency: LatencyInput[] = [];
  const metricsBad: string[] = [];
  const fileRecords = new Map<string, { provenance: ResultProvenance; mergeBase: string | null }>();
  for (const file of files.sort()) {
    const slug = file.slice(0, -".json".length);
    const expected = bySlug.get(slug);
    if (expected === undefined) {
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
    const provenance = parsed.provenance;
    if (
      provenance.repo !== expected.repo ||
      provenance.repoUrl !== expected.repoUrl ||
      provenance.pr !== expected.pr ||
      provenance.prUrl !== expected.prUrl
    ) {
      healthReasons.push(
        `result ${file} provenance mismatch: recorded ${truncate(`${provenance.repo}#${provenance.pr} ${provenance.prUrl}`)}, expected ${expected.prUrl}`,
      );
      continue;
    }
    if (provenance.baseSha !== expected.baseSha || provenance.headSha !== expected.headSha) {
      healthReasons.push(`result ${file} pins stale SHAs: expected base ${expected.baseSha} head ${expected.headSha}`);
      continue;
    }
    fileRecords.set(slug, { provenance, mergeBase: parsed.mergeBase });
    if (parsed.error !== null) {
      healthReasons.push(`failed run for ${provenance.prUrl}: ${truncate(parsed.error)}`);
      continue;
    }
    if (parsed.advisory === null) {
      healthReasons.push(`incomplete run for ${provenance.prUrl}: advisory record absent`);
      continue;
    }
    if (parsed.mergeBase !== null) {
      const checkoutDir = join(reposRoot, provenance.repo.replace("/", "-"));
      let observed: string;
      try {
        observed = (
          await resolveMergeBase({ checkoutDir, baseSha: provenance.baseSha, headSha: provenance.headSha })
        ).trim();
      } catch (error) {
        healthReasons.push(
          `cannot verify history for ${provenance.prUrl}: ${truncate(error instanceof Error ? error.message : String(error))} (missing checkout or SHAs)`,
        );
        continue;
      }
      if (!SHA40.test(observed)) {
        healthReasons.push(`recomputed merge-base for ${provenance.prUrl} malformed: ${truncate(observed)}`);
        continue;
      }
      if (observed !== parsed.mergeBase) {
        healthReasons.push(
          `stale merge-base for ${provenance.prUrl}: result records ${parsed.mergeBase}, history recomputes ${observed}`,
        );
        continue;
      }
    }
    if (parsed.advisory.metricsStatus === "missing") {
      metricsBad.push(
        `${provenance.prUrl}${parsed.advisory.metricsDetail === null ? "" : `: ${truncate(parsed.advisory.metricsDetail)}`}`,
      );
    }
    for (const finding of parsed.findings) {
      emitted.push({
        prUrl: provenance.prUrl,
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
  for (const [slug, entry] of [...bySlug.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!seen.has(slug)) healthReasons.push(`missing result for ${entry.prUrl} (expected ${slug}.json)`);
  }
  if (manifest !== null) {
    healthReasons.push(...checkManifestConsistency(manifest, fileRecords));
  }
  return { emitted, knownPrUrls, healthReasons, latency, metricsBad };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const positionals: string[] = [];
  let reposRoot: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repos-root") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        console.error("usage: bun tests/live/phase6-eval/gate.ts <labels.json> [results-dir] [--repos-root <dir>]");
        process.exit(2);
      }
      reposRoot = value;
      index += 1;
    } else if (arg !== undefined) {
      positionals.push(arg);
    }
  }
  const labelsPath = positionals[0];
  if (labelsPath === undefined) {
    console.error("usage: bun tests/live/phase6-eval/gate.ts <labels.json> [results-dir] [--repos-root <dir>]");
    process.exit(2);
  }
  const resultsDir = positionals[1] ?? "tests/live/phase6-eval/results";
  const labels = parseLabels(JSON.parse(await readFile(labelsPath, "utf8")) as unknown);
  const { emitted, knownPrUrls, healthReasons, latency, metricsBad } = await loadGateInputs(
    resultsDir,
    reposRoot === undefined ? {} : { reposRoot },
  );
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
