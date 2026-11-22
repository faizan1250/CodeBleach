import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MAX_SAMPLED_FILES, MAX_SAMPLED_FILE_BYTES, SAMPLING_HASH_DOMAIN } from "../../../src/conventions/constants.ts";
import {
  collectTouchedPaths,
  isCanonicalSamplePath,
  isSamplePathEligible,
  languageForSampledPath,
  rankPathsForSampling,
  sampleMergeBase,
  selectSampledFiles,
} from "../../../src/conventions/sampling.ts";
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
      await writeFile(join(dir, "src/keep-a.ts"), "export function hacked(): number {\n  return 0;\n}\n");
      expect(await sampleMergeBase(input)).toEqual(first);
    } finally {
      await cleanup();
    }
  }, 30000);
});
