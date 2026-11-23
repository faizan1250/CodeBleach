// Corpus curation helper for the Phase 6 live usefulness eval (P6-05).
//
// Lists recently closed PRs for a fixed set of TypeScript/JavaScript
// repositories, keeps merged PRs that touch sampled source files, and writes
// tests/live/phase6-eval/corpus.json. Operator tooling only: never runs under
// `bun test`, needs no CodeBleach credentials, uses the public GitHub API.
//
// Usage:
//   bun tests/live/phase6-eval/curate-corpus.ts [--per-repo 5] [--out tests/live/phase6-eval/corpus.json]
//   GITHUB_TOKEN=... bun tests/live/phase6-eval/curate-corpus.ts   # higher rate budget

const REPOS: readonly string[] = [
  "sveltejs/svelte",
  "vuejs/core",
  "vitejs/vite",
  "trpc/trpc",
  "eslint/eslint",
  "prettier/prettier",
];

const SAMPLED_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".js", ".jsx"];
const MAX_FILES_PER_PR = 20;

export interface CorpusEntry {
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

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined) throw new Error(`missing value for ${name}`);
  return value;
}

function headers(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  return {
    "User-Agent": "codebleach-phase6-eval",
    Accept: "application/vnd.github+json",
    ...(token === undefined || token.length === 0 ? {} : { Authorization: `Bearer ${token}` }),
  };
}

interface PullSummary {
  number: number;
  html_url: string;
  title: string;
  merged_at: string | null;
  head: { sha: string };
  base: { sha: string; ref: string };
}

interface PullFile {
  filename: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: headers() });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${url}`);
  }
  return (await response.json()) as T;
}

function isSampledFile(path: string): boolean {
  if (path.endsWith(".lock")) return false;
  if (path.includes("package-lock.json") || path.includes("yarn.lock") || path.includes("pnpm-lock.yaml")) return false;
  return SAMPLED_EXTENSIONS.some((extension) => path.endsWith(extension));
}

async function candidatesFor(repo: string): Promise<PullSummary[]> {
  const pulls = await fetchJson<PullSummary[]>(
    `https://api.github.com/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=25`,
  );
  return pulls.filter((pull) => pull.merged_at !== null);
}

export async function curateCorpus(repoList: readonly string[], perRepo: number): Promise<CorpusEntry[]> {
  const corpus: CorpusEntry[] = [];
  for (const repo of repoList) {
    const candidates = await candidatesFor(repo);
    let kept = 0;
    for (const pull of candidates) {
      if (kept >= perRepo) break;
      const files = await fetchJson<PullFile[]>(
        `https://api.github.com/repos/${repo}/pulls/${pull.number}/files?per_page=100`,
      );
      const sampled = files.filter((file) => isSampledFile(file.filename));
      if (sampled.length === 0 || files.length > MAX_FILES_PER_PR) continue;
      if (pull.merged_at === null) continue;
      corpus.push({
        repo,
        repoUrl: `https://github.com/${repo}`,
        pr: pull.number,
        prUrl: pull.html_url,
        baseSha: pull.base.sha,
        baseRef: pull.base.ref,
        headSha: pull.head.sha,
        mergedAt: pull.merged_at,
        title: pull.title,
        filesChanged: files.length,
      });
      kept += 1;
    }
    console.log(`kept ${kept} PRs for ${repo}`);
  }
  return corpus;
}

const perRepo = Number.parseInt(argValue("--per-repo", "5"), 10);
if (!Number.isSafeInteger(perRepo) || perRepo < 1) throw new Error("--per-repo must be a positive integer");
const out = argValue("--out", "tests/live/phase6-eval/corpus.json");
const corpus = await curateCorpus(REPOS, perRepo);
if (corpus.length < REPOS.length * perRepo) {
  console.warn(`short corpus: ${corpus.length} entries (rate limit or strict filters); rerun later to fill`);
}
await (await import("node:fs/promises")).writeFile(out, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
console.log(`wrote ${corpus.length} entries to ${out}`);
