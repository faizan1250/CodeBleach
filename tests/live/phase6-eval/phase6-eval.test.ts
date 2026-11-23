import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { API_KEY_ENV, TRAINING_OPT_IN_ENV } from "../../../src/llm/constants.ts";
import { git } from "../../helpers/git-repo.ts";
import corpus from "./corpus.json";

// Manual-only real-PR usefulness evaluation (P6-05, plan 15/16.5). Gated by
// CODEBLEACH_PHASE6_EVAL=1 so plain `bun test` and CI skip it without
// credentials, checkouts, or network. Manual invocation and the adjudication
// procedure are documented in tests/live/phase6-eval/README.md.
//
// For every corpus PR the harness runs the production CLI twice on the same
// pinned merge-base/head pair (primary-only, then --convention-advisory) and
// records per-PR results plus bounded log-derived advisory usage. Labeling
// and the 30-candidate/80%-useful gate happen offline afterwards via gate.ts.
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
  primaryOnly: { ms: number; status: string; validatedTotal: number; accepted: number } | null;
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
    "warn",
    ...(advisory ? ["--convention-advisory"] : []),
  ];
  const started = Date.now();
  const child = Bun.spawn(["bun", ...args], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const ms = Date.now() - started;
  if (exitCode !== 0) {
    throw new Error(`cli exit ${exitCode} for ${slug} (${advisory ? "advisory" : "primary"}): ${stdout.slice(-500)}`);
  }
  return { ms, stderr };
}

function tryParseNumbers(line: string): Record<string, number> | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const numbers: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number") numbers[key] = value;
    }
    return numbers;
  } catch {
    return null;
  }
}

function logField(stderr: string, message: string): Record<string, number> {
  for (const line of stderr.split("\n")) {
    if (!line.includes(`"msg":"${message}"`)) continue;
    const numbers = tryParseNumbers(line);
    if (numbers !== null) return numbers;
  }
  return {};
}

async function readArtifact(outDir: string): Promise<{
  validated: Array<{ finding: Record<string, unknown>; status: string }>;
  status: string;
}> {
  const raw = JSON.parse(await readFile(join(outDir, "run.json"), "utf8")) as {
    validated?: Array<{ finding: Record<string, unknown>; status: string }> | undefined;
    status?: string | undefined;
  };
  return { validated: raw.validated ?? [], status: raw.status ?? "unknown" };
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
    };
    const advisoryRun = await runCli(entry, mergeBase, true);
    const advisoryArtifact = await readArtifact(join(OUT_ROOT, `${slug}-advisory`));
    const passFields = logField(advisoryRun.stderr, "advisory pass completed");
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
      if (finding.origin?.pass !== "convention-advisory") continue;
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
      batches: passFields.batches ?? 0,
      inputTokens: passFields.inputTokens ?? 0,
      outputTokens: passFields.outputTokens ?? 0,
      projectedUnits: passFields.projectedUnits ?? 0,
      skippedUnits: passFields.skippedUnits ?? 0,
      retained: result.advisoryFindings.length,
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
