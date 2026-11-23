import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  MAX_SAMPLED_FILES,
  MAX_SAMPLED_FILE_BYTES,
  MAX_SAMPLED_TOTAL_BYTES,
  SAMPLING_HASH_DOMAIN,
} from "../../../src/conventions/constants.ts";
import {
  batchCheckStdoutCap,
  checkMergeBaseSizes,
  collectTouchedPaths,
  isCanonicalSamplePath,
  isSamplePathEligible,
  languageForSampledPath,
  parseBatchCheckOutput,
  rankPathsForSampling,
  sampleMergeBase,
  SAMPLING_SIZE_BATCH_OIDS,
  selectSampledFiles,
} from "../../../src/conventions/sampling.ts";
import { ReviewerError } from "../../../src/core/errors.ts";
import { runProcess } from "../../../src/utils/spawn.ts";
import type { MergeBaseCandidate } from "../../../src/conventions/sampling.ts";
import { commitIndex, git, makeRepo } from "../../helpers/git-repo.ts";

function candidate(path: string, sizeBytes: number, oid = "0".repeat(40)): MergeBaseCandidate {
  return { path, oid, sizeBytes };
}

function expectedRank(paths: readonly string[]): string[] {
  return [...paths].sort((a, b) => {
    const ha = createHash("sha256").update(`${SAMPLING_HASH_DOMAIN}\0${a}`).digest();
    const hb = createHash("sha256").update(`${SAMPLING_HASH_DOMAIN}\0${b}`).digest();
    const order = Buffer.compare(ha, hb);
    if (order !== 0) return order;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

describe("canonical sample paths", () => {
  test("accepts ordinary POSIX paths", () => {
    expect(isCanonicalSamplePath("src/a.ts")).toBe(true);
    expect(isCanonicalSamplePath("src/my module/uni café.ts")).toBe(true);
  });

  test("rejects control characters", () => {
    expect(isCanonicalSamplePath("src/a\nb.ts")).toBe(false);
    expect(isCanonicalSamplePath("src/a\rb.ts")).toBe(false);
    expect(isCanonicalSamplePath("src/a\tb.ts")).toBe(false);
    expect(isCanonicalSamplePath("src/a\0b.ts")).toBe(false);
    expect(isCanonicalSamplePath("src/we\x7fird.ts")).toBe(false);
    expect(isCanonicalSamplePath("src/a\x01b.ts")).toBe(false);
    expect(isCanonicalSamplePath("src/a\u0085b.ts")).toBe(false);
  });

  test("rejects non-canonical shapes", () => {
    expect(isCanonicalSamplePath("")).toBe(false);
    expect(isCanonicalSamplePath("/abs.ts")).toBe(false);
    expect(isCanonicalSamplePath("../esc.ts")).toBe(false);
    expect(isCanonicalSamplePath("src//a.ts")).toBe(false);
    expect(isCanonicalSamplePath("src\\a.ts")).toBe(false);
  });
});

describe("sample path eligibility", () => {
  const touched = new Set(["src/touched.ts", "src/old.ts"]);

  test("excludes touched new and old paths", () => {
    expect(isSamplePathEligible("src/touched.ts", touched, [])).toBe(false);
    expect(isSamplePathEligible("src/old.ts", touched, [])).toBe(false);
    expect(isSamplePathEligible("src/keep.ts", touched, [])).toBe(true);
  });

  test("allows only sampled extensions", () => {
    expect(isSamplePathEligible("src/a.ts", touched, [])).toBe(true);
    expect(isSamplePathEligible("src/a.tsx", touched, [])).toBe(true);
    expect(isSamplePathEligible("src/a.js", touched, [])).toBe(true);
    expect(isSamplePathEligible("src/a.jsx", touched, [])).toBe(true);
    expect(isSamplePathEligible("src/a.mts", touched, [])).toBe(false);
    expect(isSamplePathEligible("src/a.json", touched, [])).toBe(false);
    expect(isSamplePathEligible("src/a", touched, [])).toBe(false);
  });

  test("applies ignore globs and lockfiles", () => {
    expect(isSamplePathEligible("vendor/lib.ts", touched, ["vendor/**"])).toBe(false);
    expect(isSamplePathEligible("bun.lock", touched, [])).toBe(false);
    expect(isSamplePathEligible("src/bun.lock.ts", touched, [])).toBe(true);
  });

  test("rejects control-character paths before any other check", () => {
    expect(isSamplePathEligible("src/a\nb.ts", new Set(), [])).toBe(false);
  });
});

describe("touched path collection", () => {
  test("covers every diff status and both rename sides", () => {
    const touched = collectTouchedPaths([
      { path: "src/mod.ts", oldPath: null },
      { path: "src/add.ts", oldPath: null },
      { path: "src/del.ts", oldPath: null },
      { path: "src/new.ts", oldPath: "src/orig.ts" },
    ]);
    expect([...touched].sort()).toEqual(["src/add.ts", "src/del.ts", "src/mod.ts", "src/new.ts", "src/orig.ts"]);
  });
});

describe("sample language mapping", () => {
  test("maps the four sampled extensions", () => {
    expect(languageForSampledPath("src/a.ts")).toBe("typescript");
    expect(languageForSampledPath("src/a.tsx")).toBe("tsx");
    expect(languageForSampledPath("src/a.js")).toBe("javascript");
    expect(languageForSampledPath("src/a.jsx")).toBe("javascript");
    expect(languageForSampledPath("src/a.mts")).toBe(null);
  });
});

describe("deterministic hash ranking", () => {
  test("matches the spec hash and ascending order", () => {
    const paths = ["src/z.ts", "src/a.ts", "lib/m.ts", "src/q.tsx"];
    expect(rankPathsForSampling(paths)).toEqual(expectedRank(paths));
  });

  test("ignores input order and duplicates deterministically", () => {
    const paths = ["src/b.ts", "src/a.ts", "src/c.ts", "src/a.ts"];
    const once = rankPathsForSampling(paths);
    const reversed = rankPathsForSampling([...paths].reverse());
    expect(once).toEqual(reversed);
    expect(once).toEqual(expectedRank(paths));
  });
});

describe("sample cap selection", () => {
  test("first-fit skips oversize entries and keeps later fitting files", () => {
    const paths = [
      ...Array.from({ length: 62 }, (_, index) => `src/f${index}.ts`),
      "src/big.ts",
      "src/y.ts",
      "src/z.ts",
    ];
    const ranked = rankPathsForSampling(paths);
    // 62 max-size blobs leave 262144 bytes; big.ts exceeds the per-blob cap
    // while the two trailing files still fit the remaining budget.
    const selected = selectSampledFiles(
      ranked.map((path) => candidate(path, path === "src/big.ts" ? 200000 : MAX_SAMPLED_FILE_BYTES)),
    );
    expect(selected.map((entry) => entry.path)).toEqual(ranked.filter((path) => path !== "src/big.ts"));
  });

  test("enforces exact byte boundaries", () => {
    expect(selectSampledFiles([candidate("src/a.ts", MAX_SAMPLED_FILE_BYTES)])).toHaveLength(1);
    expect(selectSampledFiles([candidate("src/a.ts", MAX_SAMPLED_FILE_BYTES + 1)])).toHaveLength(0);
    expect(selectSampledFiles([candidate("src/a.ts", 0)])).toHaveLength(0);
    const full = selectSampledFiles([
      ...Array.from({ length: 64 }, (_, index) => candidate(`src/f${index}.ts`, MAX_SAMPLED_FILE_BYTES)),
      candidate("src/extra.ts", 1),
    ]);
    expect(full).toHaveLength(64);
  });

  test("caps file count at the policy maximum", () => {
    const many = Array.from({ length: MAX_SAMPLED_FILES + 5 }, (_, index) => candidate(`src/f${index}.ts`, 10));
    expect(selectSampledFiles(many)).toHaveLength(MAX_SAMPLED_FILES);
  });
});

describe("merge-base sampling from git", () => {
  async function setupSampleRepo(): Promise<{
    dir: string;
    cleanup: () => Promise<void>;
    base: string;
    head: string;
  }> {
    const { dir, cleanup } = await makeRepo();
    try {
      const baseFiles: Record<string, string | Uint8Array> = {
        "src/keep-a.ts": "export function a(): number {\n  return 1;\n}\n",
        "src/keep-b.ts": "export function b(): number {\n  return 2;\n}\n",
        "src/uni café.ts": "export function u(): number {\n  return 3;\n}\n",
        "src/touch-me.ts": "export function t(): number {\n  return 4;\n}\n",
        "src/big.ts": `${"const x = 1;\n".repeat(20000)}`,
        "src/bin.ts": new Uint8Array([0x65, 0x78, 0x70, 0x00, 0x6f, 0x72, 0x74]),
        "src/gen.ts": "// @generated by codegen. DO NOT EDIT.\nexport const g = 1;\n",
        "src/we\x7fird.ts": "export const w = 1;\n",
        "notes.txt": "plain text\n",
      };
      for (const [repoPath, content] of Object.entries(baseFiles)) {
        const full = join(dir, repoPath);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content);
      }
      await git(dir, ["add", "-A"]);
      const base = await commitIndex(dir, "base");
      await writeFile(join(dir, "src/touch-me.ts"), "export function t(): number {\n  return 42;\n}\n");
      await writeFile(join(dir, "src/new.ts"), "export function n(): number {\n  return 5;\n}\n");
      await git(dir, ["add", "-A"]);
      const head = await commitIndex(dir, "head");
      return { dir, cleanup, base, head };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  test("pins merge-base, excludes ineligible paths, ignores dirty worktree", async () => {
    const { dir, cleanup, base, head } = await setupSampleRepo();
    try {
      const input = {
        repoRoot: dir,
        mergeBase: base,
        headSha: head,
        files: [
          { path: "src/touch-me.ts", oldPath: null as string | null },
          { path: "src/new.ts", oldPath: null as string | null },
        ],
        ignorePaths: [] as readonly string[],
      };
      const first = await sampleMergeBase(input);
      const paths = first.files.map((file) => file.path).sort();
      expect(paths).toEqual(["src/keep-a.ts", "src/keep-b.ts", "src/uni café.ts"]);
      for (const file of first.files) {
        expect(file.source).toContain("return");
        expect(file.oid).toMatch(/^[0-9a-f]{40}$/);
      }
      // Merge-base tree lists 9 blobs; only the modified path is touched,
      // and binary plus generated blobs are read but skipped.
      expect(first.stats.touchedExcluded).toBe(1);
      expect(first.stats.contentSkipped).toBe(2);
      // Six eligible OIDs resolve in a single bounded batch.
      expect(first.stats.sizeBatches).toBe(1);
      await writeFile(join(dir, "src/keep-a.ts"), "export function hacked(): number {\n  return 0;\n}\n");
      expect(await sampleMergeBase(input)).toEqual(first);
    } finally {
      await cleanup();
    }
  }, 30000);
});

describe("bounded batch-check parsing", () => {
  const oidA = "a".repeat(40);
  const oidB = "b".repeat(40);

  test("maps reply lines to requested OIDs", () => {
    const sizes = parseBatchCheckOutput(`${oidA} blob 12\n${oidB} blob 34\n`, [oidA, oidB]);
    expect(sizes.get(oidA)).toEqual({ oid: oidA, type: "blob", size: 12 });
    expect(sizes.get(oidB)).toEqual({ oid: oidB, type: "blob", size: 34 });
  });

  test("normalizes uppercase request OIDs", () => {
    const sizes = parseBatchCheckOutput(`${oidA} blob 12\n`, [oidA.toUpperCase()]);
    expect(sizes.get(oidA)).toEqual({ oid: oidA, type: "blob", size: 12 });
  });

  test("keeps missing entries for the caller to fail", () => {
    const sizes = parseBatchCheckOutput(`${oidA} missing\n`, [oidA]);
    expect(sizes.get(oidA)).toEqual({ oid: oidA, type: "missing", size: null });
  });

  test("collapses duplicate reply lines", () => {
    const sizes = parseBatchCheckOutput(`${oidA} blob 12\n${oidA} blob 12\n`, [oidA]);
    expect(sizes.size).toBe(1);
  });

  test("rejects truncated replies", () => {
    expect(() => parseBatchCheckOutput(`${oidA} blob 12\n`, [oidA, oidB])).toThrow(/missing entry/);
  });

  test("rejects unknown OIDs", () => {
    expect(() => parseBatchCheckOutput(`${oidA} blob 12\n${oidB} blob 34\n`, [oidA])).toThrow(/unexpected/);
  });

  test("rejects malformed lines", () => {
    expect(() => parseBatchCheckOutput("garbage\n", [oidA])).toThrow();
    expect(() => parseBatchCheckOutput(`${oidA} blob\n`, [oidA])).toThrow();
    expect(() => parseBatchCheckOutput(`${oidA} blob -5\n`, [oidA])).toThrow();
  });
});

describe("bounded size batches", () => {
  test("pins one batch to a fixed OID count", () => {
    expect(SAMPLING_SIZE_BATCH_OIDS).toBe(200);
  });

  test("bounds stdout by request count", () => {
    expect(batchCheckStdoutCap(1)).toBe(128);
    expect(batchCheckStdoutCap(SAMPLING_SIZE_BATCH_OIDS)).toBe(25600);
    expect(batchCheckStdoutCap(SAMPLING_SIZE_BATCH_OIDS)).toBeLessThan(26 * 1024 * 1024);
  });

  test("refuses oversized batches before spawning git", async () => {
    const oids = Array.from({ length: SAMPLING_SIZE_BATCH_OIDS + 1 }, (_, index) =>
      index.toString(16).padStart(40, "0"),
    );
    let thrown: unknown;
    try {
      await checkMergeBaseSizes("/nonexistent-codebleach-repo", oids);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ReviewerError);
    expect((thrown as ReviewerError).code).toBe("INTERNAL");
  });

  test("reports missing objects instead of throwing", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const sizes = await checkMergeBaseSizes(dir, ["0".repeat(40)]);
      expect(sizes.get("0".repeat(40))).toEqual({ oid: "0".repeat(40), type: "missing", size: null });
    } finally {
      await cleanup();
    }
  });

  test("aborts before spawn on a cancelled signal", async () => {
    const controller = new AbortController();
    controller.abort();
    let thrown: unknown;
    try {
      await checkMergeBaseSizes("/nonexistent-codebleach-repo", ["a".repeat(40)], controller.signal);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ReviewerError);
    expect((thrown as ReviewerError).code).toBe("GIT_FAILED");
  });
});

describe("rank determinism across enumeration orders", () => {
  test("ranks identically for every permutation", () => {
    const paths = Array.from({ length: 50 }, (_, index) => `src/mod-${index}.ts`);
    const first = rankPathsForSampling(paths);
    const rotate = [...paths.slice(17), ...paths.slice(0, 17)];
    const oddsEvens = [...paths.filter((_, index) => index % 2 === 1), ...paths.filter((_, index) => index % 2 === 0)];
    const swapped = [...paths.slice(25), ...paths.slice(0, 25)];
    for (const permutation of [rotate, oddsEvens, swapped, [...paths].reverse()]) {
      expect(rankPathsForSampling(permutation)).toEqual(first);
    }
    expect(first).toEqual(expectedRank(paths));
  });
});

describe("rank-first batched sizing from git", () => {
  async function setupNumberedRepo(
    count: number,
    contentFor: (index: number) => string,
    touchedIndex: number,
  ): Promise<{ dir: string; cleanup: () => Promise<void>; base: string; head: string; touched: string }> {
    const { dir, cleanup } = await makeRepo();
    try {
      for (let index = 0; index < count; index += 1) {
        const full = join(dir, `src/f${index}.ts`);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, contentFor(index));
      }
      await git(dir, ["add", "-A"]);
      const base = await commitIndex(dir, "base");
      const touched = `src/f${touchedIndex}.ts`;
      await writeFile(join(dir, touched), "export const touched = 1;\n");
      await git(dir, ["add", "-A"]);
      const head = await commitIndex(dir, "head");
      return { dir, cleanup, base, head, touched };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  function sampleInput(repo: { dir: string; base: string; head: string; touched: string }) {
    return {
      repoRoot: repo.dir,
      mergeBase: repo.base,
      headSha: repo.head,
      files: [{ path: repo.touched, oldPath: null as string | null }],
      ignorePaths: [] as readonly string[],
    };
  }

  test("stops batching once the file cap fills", async () => {
    const repo = await setupNumberedRepo(251, (index) => `export const v${index} = ${index};\n`, 250);
    try {
      const eligible = Array.from({ length: 250 }, (_, index) => `src/f${index}.ts`);
      const sample = await sampleMergeBase(sampleInput(repo));
      expect(sample.stats.sizeBatches).toBe(1);
      expect(sample.files).toHaveLength(MAX_SAMPLED_FILES);
      expect(sample.files.map((file) => file.path)).toEqual(expectedRank(eligible).slice(0, MAX_SAMPLED_FILES));
    } finally {
      await repo.cleanup();
    }
  }, 30000);

  test("sweeps every batch while nothing fits", async () => {
    const padding = "x".repeat(132096);
    const repo = await setupNumberedRepo(211, (index) => `// ${index}\n${padding}\n`, 210);
    try {
      const sample = await sampleMergeBase(sampleInput(repo));
      expect(sample.stats.sizeBatches).toBe(2);
      expect(sample.files).toHaveLength(0);
      expect(sample.stats.sizeExcluded).toBe(210);
    } finally {
      await repo.cleanup();
    }
  }, 60000);

  test("continues rank-ordered batches past holes", async () => {
    const paths = Array.from({ length: 250 }, (_, index) => `src/f${index}.ts`);
    const ranked = expectedRank(paths);
    const holes = new Set(ranked.slice(0, 60));
    const padding = "y".repeat(132096);
    const repo = await setupNumberedRepo(
      251,
      (index) =>
        holes.has(`src/f${index}.ts`) ? `// hole ${index}\n${padding}\n` : `export const v${index} = ${index};\n`,
      250,
    );
    try {
      const sample = await sampleMergeBase(sampleInput(repo));
      expect(sample.stats.sizeBatches).toBe(2);
      expect(sample.stats.sizeExcluded).toBe(60);
      expect(sample.files.map((file) => file.path)).toEqual(ranked.slice(60));
    } finally {
      await repo.cleanup();
    }
  }, 60000);

  test("fills the byte budget exactly at both boundaries", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      for (let index = 0; index < 65; index += 1) {
        const full = join(dir, `src/f${index}.ts`);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, "x".repeat(MAX_SAMPLED_FILE_BYTES));
      }
      await writeFile(join(dir, "src/over.ts"), "x".repeat(MAX_SAMPLED_FILE_BYTES + 1));
      await writeFile(join(dir, "src/touched.ts"), "export const t = 1;\n");
      await git(dir, ["add", "-A"]);
      const base = await commitIndex(dir, "base");
      await writeFile(join(dir, "src/touched.ts"), "export const t = 2;\n");
      await git(dir, ["add", "-A"]);
      const head = await commitIndex(dir, "head");
      const sample = await sampleMergeBase({
        repoRoot: dir,
        mergeBase: base,
        headSha: head,
        files: [{ path: "src/touched.ts", oldPath: null as string | null }],
        ignorePaths: [],
      });
      expect(sample.stats.sizeExcluded).toBe(1);
      expect(sample.files).toHaveLength(64);
      const total = sample.files.reduce((sum, file) => sum + file.sizeBytes, 0);
      expect(total).toBe(MAX_SAMPLED_TOTAL_BYTES);
      for (const file of sample.files) expect(file.sizeBytes).toBe(MAX_SAMPLED_FILE_BYTES);
    } finally {
      await cleanup();
    }
  }, 60000);

  test("skips a rank-leading oversized file without disturbing rank", async () => {
    const eligible = Array.from({ length: 11 }, (_, index) => `src/f${index}.ts`);
    const ranked = expectedRank(eligible);
    const oversized = ranked[0] ?? "";
    const repo = await setupNumberedRepo(
      12,
      (index) => (`src/f${index}.ts` === oversized ? `${"z".repeat(200000)}\n` : `export const v${index} = 1;\n`),
      11,
    );
    try {
      const sample = await sampleMergeBase(sampleInput(repo));
      expect(sample.stats.sizeBatches).toBe(1);
      expect(sample.stats.sizeExcluded).toBe(1);
      expect(sample.files.map((file) => file.path)).toEqual(ranked.slice(1));
    } finally {
      await repo.cleanup();
    }
  }, 30000);

  test("selects duplicate blobs per path while resolving once", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const same = "export const same = 1;\n";
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src/dup-a.ts"), same);
      await writeFile(join(dir, "src/dup-b.ts"), same);
      await writeFile(join(dir, "src/keep.ts"), "export const keep = 2;\n");
      await writeFile(join(dir, "src/touched.ts"), "export const t = 1;\n");
      await git(dir, ["add", "-A"]);
      const base = await commitIndex(dir, "base");
      await writeFile(join(dir, "src/touched.ts"), "export const t = 2;\n");
      await git(dir, ["add", "-A"]);
      const head = await commitIndex(dir, "head");
      const sample = await sampleMergeBase({
        repoRoot: dir,
        mergeBase: base,
        headSha: head,
        files: [{ path: "src/touched.ts", oldPath: null as string | null }],
        ignorePaths: [],
      });
      expect(sample.stats.sizeBatches).toBe(1);
      const byPath = new Map(sample.files.map((file) => [file.path, file]));
      expect([...byPath.keys()].sort()).toEqual(["src/dup-a.ts", "src/dup-b.ts", "src/keep.ts"]);
      expect(byPath.get("src/dup-a.ts")?.oid).toBe(byPath.get("src/dup-b.ts")?.oid);
      const total = sample.files.reduce((sum, file) => sum + file.sizeBytes, 0);
      expect(total).toBe(same.length * 2 + "export const keep = 2;\n".length);
    } finally {
      await cleanup();
    }
  }, 30000);

  test("fails the run when a merge-base object is missing", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src/real.ts"), "export const r = 1;\n");
      await git(dir, ["add", "-A"]);
      // Craft a merge-base tree that references a nonexistent blob:
      // hash-object only hashes, never validates, so the corrupt tree
      // object is stored while batch-check later reports it missing.
      const realOid = (await git(dir, ["hash-object", "src/real.ts"])).trim();
      const subtreeBytes = Buffer.concat([
        Buffer.from("100644 ghost.ts\0", "utf8"),
        Buffer.alloc(20, 0x11),
        Buffer.from("100644 real.ts\0", "utf8"),
        Buffer.from(realOid, "hex"),
      ]);
      const subtreeOut = await runProcess({
        cmd: ["git", "hash-object", "-t", "tree", "-w", "--stdin"],
        cwd: dir,
        stdinData: subtreeBytes,
      });
      const subtreeSha = new TextDecoder().decode(subtreeOut.stdout).trim();
      const treeBytes = Buffer.concat([Buffer.from("40000 src\0", "utf8"), Buffer.from(subtreeSha, "hex")]);
      const treeOut = await runProcess({
        cmd: ["git", "hash-object", "-t", "tree", "-w", "--stdin"],
        cwd: dir,
        stdinData: treeBytes,
      });
      const treeSha = new TextDecoder().decode(treeOut.stdout).trim();
      const identity = {
        GIT_AUTHOR_NAME: "CodeBleach Test",
        GIT_AUTHOR_EMAIL: "edge@codebleach.local",
        GIT_COMMITTER_NAME: "CodeBleach Test",
        GIT_COMMITTER_EMAIL: "edge@codebleach.local",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      };
      const commitOut = await runProcess({
        cmd: ["git", "commit-tree", treeSha, "-m", "base"],
        cwd: dir,
        env: identity,
      });
      const base = new TextDecoder().decode(commitOut.stdout).trim();
      await git(dir, ["update-ref", "HEAD", base]);
      await writeFile(join(dir, "src/real.ts"), "export const r = 2;\n");
      await git(dir, ["add", "-A"]);
      const head = await commitIndex(dir, "head");
      await expect(
        sampleMergeBase({
          repoRoot: dir,
          mergeBase: base,
          headSha: head,
          files: [{ path: "src/real.ts", oldPath: null as string | null }],
          ignorePaths: [],
        }),
      ).rejects.toThrow(/fetch sufficient history/);
    } finally {
      await cleanup();
    }
  }, 30000);

  test("returns the same sample regardless of input order", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      await mkdir(join(dir, "src"), { recursive: true });
      for (const name of ["a", "b", "c", "d", "e"]) {
        await writeFile(join(dir, `src/${name}.ts`), `export const ${name} = 1;\n`);
      }
      await writeFile(join(dir, "src/t1.ts"), "export const t1 = 1;\n");
      await writeFile(join(dir, "src/t2.ts"), "export const t2 = 1;\n");
      await git(dir, ["add", "-A"]);
      const base = await commitIndex(dir, "base");
      await writeFile(join(dir, "src/t1.ts"), "export const t1 = 2;\n");
      await git(dir, ["add", "-A"]);
      const head = await commitIndex(dir, "head");
      const input = {
        repoRoot: dir,
        mergeBase: base,
        headSha: head,
        files: [
          { path: "src/t1.ts", oldPath: null as string | null },
          { path: "src/t2.ts", oldPath: "src/old.ts" as string | null },
        ],
        ignorePaths: [] as readonly string[],
      };
      const first = await sampleMergeBase(input);
      const reversed = await sampleMergeBase({ ...input, files: [...input.files].reverse() });
      expect(reversed).toEqual(first);
      expect(first.files.map((file) => file.path).sort()).toEqual([
        "src/a.ts",
        "src/b.ts",
        "src/c.ts",
        "src/d.ts",
        "src/e.ts",
      ]);
    } finally {
      await cleanup();
    }
  }, 30000);

  test("rejects a cancelled signal before batching", async () => {
    const repo = await setupNumberedRepo(3, (index) => `export const v${index} = 1;\n`, 2);
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(sampleMergeBase({ ...sampleInput(repo), signal: controller.signal })).rejects.toThrow();
    } finally {
      await repo.cleanup();
    }
  }, 30000);
});
