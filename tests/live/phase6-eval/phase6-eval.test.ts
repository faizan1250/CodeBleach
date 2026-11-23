import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { API_KEY_ENV, TRAINING_OPT_IN_ENV } from "../../../src/llm/constants.ts";
import { runProcess, type RunProcessResult } from "../../../src/utils/spawn.ts";
import { collectAdvisoryMetrics, isAdvisoryProvenance, type AdvisoryMetricsStatus } from "./eval-metrics.ts";
import { git } from "../../helpers/git-repo.ts";
import corpus from "./corpus.json";

// Manual-only real-PR usefulness evaluation (P6-05, plan 15/16.5). Gated by
// CODEBLEACH_PHASE6_EVAL=1 so plain `bun test` and CI skip it without
// credentials, checkouts, or network. Manual invocation and the adjudication
// procedure are documented in tests/live/phase6-eval/README.md.
//
// For every corpus PR the harness runs the production CLI twice on the same
// pinned merge-base/head pair at --log-level info (info carries the advisory
// metrics events; warn would suppress them) and records per-PR results plus
// structured advisory usage parsed from stderr JSON events, never substring
// matching and never silent zeros. Labeling and the
// emitted-validated gate happen offline afterwards via gate.ts.
const EVAL = process.env.CODEBLEACH_PHASE6_EVAL === "1";
const REPOS_ROOT = process.env.CODEBLEACH_PHASE6_EVAL_REPOS ?? join(process.cwd(), "..", "phase6-eval-repos");
const OUT_ROOT = process.env.CODEBLEACH_PHASE6_EVAL_OUT ?? join(process.cwd(), "tests/live/phase6-eval/results");
const ONLY = (process.env.CODEBLEACH_PHASE6_EVAL_ONLY ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
// Six wall-clock hours for the full 30-PR sweep; operators re-run single PRs
// with CODEBLEACH_PHASE6_EVAL_ONLY for iteration.
const EVAL_TIMEOUT_MS = 6 * 3600_000;
const RUN_TIMEOUT_MS = 20 * 60_000;

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

interface EvalPrResult {
  slug: string;
  entry: CorpusEntry;
  mergeBase: string | null;
  primaryOnly: {
    ms: number;
    status: string;
    validatedTotal: number;
    accepted: number;
    promptVersion: string | null;
    promptHash: string | null;
  } | null;
  advisory: {
    ms: number;
    status: string;
    validatedTotal: number;
    accepted: number;
    batches: number;
    inputTokens: number;
    outputTokens: number;
    projectedUnits: number;
    skippedUnits: number;
    retained: number;
    // completed: pass + merge telemetry observed. skipped: the pass emitted
    // its skipped event (genuine zero, not missing data). missing: neither
    // usable telemetry nor a skipped event; see metricsDetail, never silent
    // zeros.
    metricsStatus: AdvisoryMetricsStatus;
    metricsDetail: string | null;
    diagnosticCodes: string[];
    promptVersion: string | null;
    promptHash: string | null;
  } | null;
  advisoryFindings: Array<{
    findingId: string;
    file: string;
    line: number;
    category: string;
    severity: string;
    ruleId?: string | undefined;
    title: string;
  }>;
  error: string | null;
}

function slugFor(entry: CorpusEntry): string {
  return `${entry.repo.replace("/", "-")}-${entry.pr}`;
}

function checkoutFor(entry: CorpusEntry): string {
  return join(REPOS_ROOT, entry.repo.replace("/", "-"));
}

function requireLiveEnv(): void {
  if (process.env[TRAINING_OPT_IN_ENV] !== "true") {
    throw new Error(`[phase6-eval] refusing pre-network: set ${TRAINING_OPT_IN_ENV}=true (exact)`);
  }
  const key = process.env[API_KEY_ENV];
  if (key === undefined || key.length === 0) {
    throw new Error(`[phase6-eval] refusing pre-network: set ${API_KEY_ENV}`);
  }
}

async function ensureCheckout(entry: CorpusEntry): Promise<void> {
  const checkout = checkoutFor(entry);
  try {
    await git(checkout, ["rev-parse", "--git-dir"]);
  } catch {
    throw new Error(`missing checkout for ${entry.repo}: clone ${entry.repoUrl} to ${checkout} (full history)`);
  }
  await git(checkout, ["fetch", "origin", `pull/${entry.pr}/head`, "--quiet"]);
  for (const sha of [entry.baseSha, entry.headSha]) {
    const kind = await git(checkout, ["cat-file", "-t", sha]).catch(() => "missing");
    if (kind.trim() !== "commit") throw new Error(`sha ${sha} not found in ${checkout}; fetch full history`);
  }
}

async function runCli(
  entry: CorpusEntry,
  mergeBase: string,
  advisory: boolean,
): Promise<{ ms: number; stderr: string }> {
  const slug = slugFor(entry);
  const outDir = join(OUT_ROOT, advisory ? `${slug}-advisory` : `${slug}-primary`);
  await mkdir(outDir, { recursive: true });
  // Info level is load-bearing: the advisory metrics events are info logs,
  // so warn would suppress them and every token/projection column would read
  // zero. Metrics parsing below treats a missing event as missing telemetry,
  // never as zero usage.
  const args = [
    "src/cli/index.ts",
    "review",
    "--base",
    mergeBase,
    "--head",
    entry.headSha,
    "--repo",
    checkoutFor(entry),
    "--out",
    outDir,
    "--dry-run",
    "--log-level",
    "info",
    ...(advisory ? ["--convention-advisory"] : []),
  ];
  const started = Date.now();
  // Bounded per-run execution: runProcess kills the child on RUN_TIMEOUT_MS
  // (timeout behavior is unit-tested in tests/unit/spawn.test.ts), so a hung
  // provider call can never stall the sweep indefinitely.
  let result: RunProcessResult;
  try {
    result = await runProcess({ cmd: ["bun", ...args], cwd: process.cwd(), timeoutMs: RUN_TIMEOUT_MS });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cli failed for ${slug} (${advisory ? "advisory" : "primary"}): ${detail.slice(0, 500)}`);
  }
  return { ms: Date.now() - started, stderr: new TextDecoder().decode(result.stderr) };
}

async function readArtifact(outDir: string): Promise<{
  validated: Array<{ finding: Record<string, unknown>; status: string }>;
  status: string;
  promptVersion: string | null;
  promptHash: string | null;
}> {
  const raw = JSON.parse(await readFile(join(outDir, "run.json"), "utf8")) as {
    validated?: Array<{ finding: Record<string, unknown>; status: string }> | undefined;
    status?: string | undefined;
    reviewPromptVersion?: unknown;
    reviewPromptHash?: unknown;
  };
  return {
    validated: raw.validated ?? [],
    status: raw.status ?? "unknown",
    promptVersion: typeof raw.reviewPromptVersion === "string" ? raw.reviewPromptVersion : null,
    promptHash: typeof raw.reviewPromptHash === "string" ? raw.reviewPromptHash : null,
  };
}

async function evaluatePr(entry: CorpusEntry): Promise<EvalPrResult> {
  const slug = slugFor(entry);
  const result: EvalPrResult = {
    slug,
    entry,
    mergeBase: null,
    primaryOnly: null,
    advisory: null,
    advisoryFindings: [],
    error: null,
  };
  try {
    await ensureCheckout(entry);
    const mergeBase = (await git(checkoutFor(entry), ["merge-base", entry.baseSha, entry.headSha])).trim();
    result.mergeBase = mergeBase;
    const primaryRun = await runCli(entry, mergeBase, false);
    const primaryArtifact = await readArtifact(join(OUT_ROOT, `${slug}-primary`));
    result.primaryOnly = {
      ms: primaryRun.ms,
      status: primaryArtifact.status,
      validatedTotal: primaryArtifact.validated.length,
      accepted: primaryArtifact.validated.filter((item) => item.status === "accepted").length,
      promptVersion: primaryArtifact.promptVersion,
      promptHash: primaryArtifact.promptHash,
    };
    const advisoryRun = await runCli(entry, mergeBase, true);
    const advisoryArtifact = await readArtifact(join(OUT_ROOT, `${slug}-advisory`));
    const metrics = collectAdvisoryMetrics(advisoryRun.stderr);
    for (const item of advisoryArtifact.validated) {
      const finding = item.finding as {
        origin?: { pass?: string } | undefined;
        id?: string | undefined;
        file?: string | undefined;
        line?: number | undefined;
        category?: string | undefined;
        severity?: string | undefined;
        ruleId?: string | undefined;
        title?: string | undefined;
      };
      // Provenance-identified extraction: primaries from the paired advisory
      // run never enter the gate, only convention-advisory findings do.
      if (!isAdvisoryProvenance(finding.origin)) continue;
      result.advisoryFindings.push({
        findingId: String(finding.id ?? ""),
        file: String(finding.file ?? ""),
        line: typeof finding.line === "number" ? finding.line : -1,
        category: String(finding.category ?? ""),
        severity: String(finding.severity ?? ""),
        ...(finding.ruleId === undefined ? {} : { ruleId: String(finding.ruleId) }),
        title: String(finding.title ?? "").slice(0, 200),
      });
    }
    result.advisory = {
      ms: advisoryRun.ms,
      status: advisoryArtifact.status,
      validatedTotal: advisoryArtifact.validated.length,
      accepted: advisoryArtifact.validated.filter((item) => item.status === "accepted").length,
      batches: metrics.batches,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      projectedUnits: metrics.projectedUnits,
      skippedUnits: metrics.skippedUnits,
      retained: result.advisoryFindings.length,
      metricsStatus: metrics.status,
      metricsDetail: metrics.detail,
      diagnosticCodes: metrics.codes,
      promptVersion: advisoryArtifact.promptVersion,
      promptHash: advisoryArtifact.promptHash,
    };
  } catch (error) {
    result.error = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  }
  return result;
}

describe.skipIf(!EVAL)("phase6 live usefulness evaluation (opt-in, Not-ZDR)", () => {
  test(
    "sweeps the pinned corpus and records per-PR results",
    async () => {
      requireLiveEnv();
      const entries = (corpus as CorpusEntry[]).filter((entry) => ONLY.length === 0 || ONLY.includes(slugFor(entry)));
      expect(entries.length).toBeGreaterThan(0);
      await mkdir(OUT_ROOT, { recursive: true });
      const results: EvalPrResult[] = [];
      for (const entry of entries) {
        const result = await evaluatePr(entry);
        results.push(result);
        await writeFile(join(OUT_ROOT, `${result.slug}.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
        console.log(
          JSON.stringify({
            slug: result.slug,
            error: result.error,
            primaryMs: result.primaryOnly?.ms ?? null,
            advisoryMs: result.advisory?.ms ?? null,
            advisoryCandidates: result.advisoryFindings.length,
            metricsStatus: result.advisory?.metricsStatus ?? null,
            metricsDetail: result.advisory?.metricsDetail ?? null,
            diagnosticCodes: result.advisory?.diagnosticCodes ?? null,
          }),
        );
      }
      await writeFile(join(OUT_ROOT, "manifest.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
      const failures = results.filter((result) => result.error !== null);
      expect(failures.map((result) => `${result.slug}: ${result.error}`)).toEqual([]);
    },
    { timeout: EVAL_TIMEOUT_MS },
  );
});

export { RUN_TIMEOUT_MS };
