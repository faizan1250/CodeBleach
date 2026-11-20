import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigFileSchema } from "../src/config/schema.ts";
import { createLogger } from "../src/core/logger.ts";
import { ContextEngineImpl } from "../src/context/engine.ts";
import { GitDiffEngine } from "../src/diff/git.ts";
import { runProcess } from "../src/utils/spawn.ts";

// Manual-only context benchmark (not part of `bun test`): reproducible ~22
// changed-file fixture, prints Context time, git launches, blob reads, parse
// counts, and a canonical output hash for before/after comparison.
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const FIXED_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "CodeBleach Bench",
  GIT_AUTHOR_EMAIL: "bench@codebleach.local",
  GIT_COMMITTER_NAME: "CodeBleach Bench",
  GIT_COMMITTER_EMAIL: "bench@codebleach.local",
  GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z",
};

async function git(dir: string, args: string[], env?: Record<string, string>): Promise<string> {
  const result = await runProcess(
    env === undefined ? { cmd: ["git", ...args], cwd: dir } : { cmd: ["git", ...args], cwd: dir, env },
  );
  return decode(result.stdout).trim();
}

function modSource(index: number, variant: number): string {
  const prev = index === 0 ? `"./shared/util.ts"` : `"./mod${index - 1}.ts"`;
  const prevName = index === 0 ? "helper" : "prev";
  const offset = variant === 0 ? 0 : 100 + index;
  return (
    `import { helper } from "./shared/util.ts";\n` +
    `import { prev } from ${prev};\n` +
    `export function compute${index}(x: number): number {\n` +
    `  return helper(x + ${offset}) + ${prevName}(x);\n` +
    `}\n` +
    `export function describe${index}(): string {\n` +
    `  return "mod${index}-v${variant}:" + String(compute${index}(1));\n` +
    `}\n` +
    `export class Handler${index} {\n` +
    `  handle(input: number): number {\n` +
    `    return compute${index}(input) * 2;\n` +
    `  }\n` +
    `}\n`
  );
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "codebleach-bench-context-"));
  try {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.name", "CodeBleach Bench"]);
    await git(dir, ["config", "user.email", "bench@codebleach.local"]);
    await git(dir, ["config", "commit.gpgsign", "false"]);
    const files: Record<string, string> = {
      "src/shared/util.ts":
        "export function helper(x: number): number {\n  return x * 2 + 1;\n}\n" +
        "export function prev(x: number): number {\n  return x - 1;\n}\n",
      "src/main.ts":
        'import { compute0 } from "./mod0.ts";\n' +
        "export function main(): number {\n" +
        "  return compute0(42);\n" +
        "}\n",
    };
    for (let index = 0; index < 20; index += 1) {
      files[`src/mod${index}.ts`] = modSource(index, 0);
    }
    for (let index = 0; index < 6; index += 1) {
      files[`tests/mod${index}.test.ts`] =
        `import { compute${index} } from "../src/mod${index}.ts";\n` +
        `import { strict as assert } from "node:assert";\n` +
        `export function check${index}(): void {\n` +
        `  assert.equal(compute${index}(1) > 0, true);\n` +
        `}\n`;
    }
    for (const [name, content] of Object.entries(files)) {
      const full = join(dir, name);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    }
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "base", "--quiet"], FIXED_ENV);
    const baseSha = await git(dir, ["rev-parse", "HEAD"]);
    for (let index = 0; index < 20; index += 1) {
      await writeFile(join(dir, `src/mod${index}.ts`), modSource(index, 1));
    }
    await writeFile(
      join(dir, "src/extra-a.ts"),
      'import { helper } from "./shared/util.ts";\n' +
        "export function extraA(x: number): number {\n" +
        "  return helper(x) + 7;\n" +
        "}\n",
    );
    await writeFile(
      join(dir, "src/extra-b.ts"),
      'import { extraA } from "./extra-a.ts";\n' +
        "export function extraB(x: number): number {\n" +
        "  return extraA(x) * 3;\n" +
        "}\n",
    );
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "head", "--quiet"], FIXED_ENV);
    const headSha = await git(dir, ["rev-parse", "HEAD"]);

    const logger = createLogger({ level: "error", runId: "bench-context" });
    const config = ConfigFileSchema.parse({});
    const diffEngine = new GitDiffEngine({ logger });
    const diff = await diffEngine.run({ repoDir: dir, baseSha, headSha, config });
    const heapBefore = process.memoryUsage().heapUsed;
    const context = new ContextEngineImpl({ logger });
    const started = performance.now();
    const first = await context.build(diff, config, dir);
    const wallMs = performance.now() - started;
    const heapAfter = process.memoryUsage().heapUsed;
    const second = await new ContextEngineImpl({ logger }).build(diff, config, dir);
    const firstHash = createHash("sha1").update(stableStringify(first.units)).digest("hex");
    const secondHash = createHash("sha1").update(stableStringify(second.units)).digest("hex");
    const report = {
      filesChanged: diff.files.length,
      contextStatus: first.status,
      wallMs: Math.round(wallMs * 10) / 10,
      engineElapsedMs: Math.round(first.diagnostics.elapsedMs * 10) / 10,
      unitsCreated: first.diagnostics.unitsCreated,
      filesParsed: first.diagnostics.filesParsed,
      filesParseTimedOut: first.diagnostics.filesParseTimedOut,
      parseCacheHits: first.diagnostics.parseCacheHits,
      parseCacheMisses: first.diagnostics.parseCacheMisses,
      parseCacheEntries: first.diagnostics.parseCacheEntries,
      gitCalls: first.diagnostics.gitCalls,
      blobsFetched: first.diagnostics.blobsFetched,
      blobCacheHits: first.diagnostics.blobCacheHits,
      batchFetches: first.diagnostics.batchFetches,
      queryTimeouts: first.diagnostics.queryTimeouts,
      heapDeltaBytes: heapAfter - heapBefore,
      unitsHash: firstHash,
      deterministic: firstHash === secondHash,
      secondRunUnits: second.units.length,
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await main();
