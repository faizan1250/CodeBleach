import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkManifestConsistency,
  loadGateInputs,
  MIN_CORPUS_PRS,
  MIN_CORPUS_REPOS,
  parseCorpus,
  parseHarnessResult,
  parseManifest,
  type MergeBaseResolver,
  type ResultProvenance,
} from "../live/phase6-eval/gate.ts";
import {
  evaluateGate,
  MIN_EVAL_CANDIDATES,
  MIN_USEFUL_PRECISION,
  type EmittedAdvisoryCandidate,
  type LabeledAdvisoryCandidate,
} from "../live/phase6-eval/eval-gate.ts";
import corpus from "../live/phase6-eval/corpus.json";

const PR = "https://github.com/example/repo/pull/1";
const KNOWN = [PR, "https://github.com/example/repo/pull/2"];

function emitted(id: string, overrides: Partial<EmittedAdvisoryCandidate> = {}): EmittedAdvisoryCandidate {
  return { prUrl: PR, findingId: id, category: "convention", severity: "low", ...overrides };
}

function labeled(id: string, label: LabeledAdvisoryCandidate["label"] = "useful"): LabeledAdvisoryCandidate {
  return { prUrl: PR, findingId: id, label };
}

function manyEmitted(
  count: number,
  label: LabeledAdvisoryCandidate["label"] = "useful",
): {
  emitted: EmittedAdvisoryCandidate[];
  labels: LabeledAdvisoryCandidate[];
} {
  const emittedList = Array.from({ length: count }, (_, index) => emitted(`f${index}`));
  const labelList = emittedList.map((candidate) => labeled(candidate.findingId, label));
  return { emitted: emittedList, labels: labelList };
}

function usefulLabels(
  count: number,
  nonUseful: LabeledAdvisoryCandidate["label"],
  nonUsefulCount: number,
): {
  emitted: EmittedAdvisoryCandidate[];
  labels: LabeledAdvisoryCandidate[];
} {
  const total = count + nonUsefulCount;
  const emittedList = Array.from({ length: total }, (_, index) => emitted(`f${index}`));
  const labels = [
    ...emittedList.slice(0, count).map((candidate) => labeled(candidate.findingId, "useful")),
    ...emittedList.slice(count).map((candidate) => labeled(candidate.findingId, nonUseful)),
  ];
  return { emitted: emittedList, labels };
}

describe("phase6 eval gate", () => {
  test("passes at thirty emitted candidates and eighty percent useful", () => {
    const { emitted: emittedList, labels } = usefulLabels(24, "technically-correct-but-not-actionable", 6);
    const result = evaluateGate({ labels, emitted: emittedList, knownPrUrls: KNOWN });
    expect(result.passed).toBe(true);
    expect(result.totalCandidates).toBe(30);
    expect(result.usefulPrecision).toBe(0.8);
    expect(result.reasons).toEqual([]);
  });

  test("fails below the candidate minimum", () => {
    const { emitted: emittedList, labels } = manyEmitted(29);
    const result = evaluateGate({ labels, emitted: emittedList });
    expect(result.passed).toBe(false);
    expect(result.totalCandidates).toBe(29);
    expect(result.reasons.some((reason) => reason.includes(String(MIN_EVAL_CANDIDATES)))).toBe(true);
  });

  test("counts emitted records not labels", () => {
    const { emitted: emittedList, labels } = manyEmitted(30);
    const extra = [...labels, { ...labeled("invented"), label: "useful" as const }];
    const result = evaluateGate({ labels: extra, emitted: emittedList });
    expect(result.passed).toBe(false);
    expect(result.totalCandidates).toBe(30);
    expect(result.unmatched).toEqual([`${PR}#invented`]);
  });

  test("fails below the useful precision floor", () => {
    const { emitted: emittedList, labels } = usefulLabels(23, "technically-correct-but-not-actionable", 7);
    const result = evaluateGate({ labels, emitted: emittedList });
    expect(result.passed).toBe(false);
    expect(result.usefulPrecision).toBeLessThan(MIN_USEFUL_PRECISION);
  });

  test("derives authority from emitted records", () => {
    const emittedList = [emitted("bug", { category: "bug" }), emitted("sev", { severity: "medium" })];
    const labels = [labeled("bug"), labeled("sev")];
    const result = evaluateGate({ labels, emitted: emittedList });
    expect(result.passed).toBe(false);
    expect(result.violations).toBe(2);
  });

  test("fails on emitted ruleId violations", () => {
    const { emitted: emittedList, labels } = manyEmitted(30);
    const result = evaluateGate({
      labels: [...labels, labeled("rule")],
      emitted: [...emittedList, emitted("rule", { ruleId: "real-rule" })],
    });
    expect(result.passed).toBe(false);
    expect(result.violations).toBe(1);
  });

  test("counts only useful labels toward precision", () => {
    const { emitted: emittedList, labels } = {
      emitted: Array.from({ length: 30 }, (_, index) => emitted(`f${index}`)),
      labels: [
        ...Array.from({ length: 24 }, (_, index) => labeled(`f${index}`, "useful")),
        ...Array.from({ length: 3 }, (_, index) => labeled(`f${24 + index}`, "incorrect/unsupported")),
        ...Array.from({ length: 3 }, (_, index) => labeled(`f${27 + index}`, "technically-correct-but-not-actionable")),
      ],
    };
    const result = evaluateGate({ labels, emitted: emittedList });
    expect(result.totalCandidates).toBe(30);
    expect(result.usefulPrecision).toBe(0.8);
    expect(result.passed).toBe(true);
  });

  test("rejects duplicate labels for one finding", () => {
    const { emitted: emittedList, labels } = manyEmitted(30);
    const result = evaluateGate({ labels: [...labels, labels[0]!], emitted: emittedList });
    expect(result.passed).toBe(false);
    expect(result.duplicates).toEqual([`${PR}#f0`]);
  });

  test("rejects labels for never-emitted findings", () => {
    const { emitted: emittedList, labels } = manyEmitted(30);
    const result = evaluateGate({ labels: [...labels.slice(1), labeled("ghost")], emitted: emittedList });
    expect(result.passed).toBe(false);
    expect(result.unmatched).toEqual([`${PR}#ghost`]);
    expect(result.missing).toEqual([`${PR}#f0`]);
  });

  test("rejects unknown PR URLs against the corpus", () => {
    const { emitted: emittedList, labels } = manyEmitted(30);
    const foreign = { ...labeled("f0"), prUrl: "https://github.com/example/other/pull/9" };
    const result = evaluateGate({ labels: [...labels.slice(1), foreign], emitted: emittedList, knownPrUrls: KNOWN });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("unknown PR URL"))).toBe(true);
  });

  test("rejects emitted records for unknown PRs", () => {
    const { emitted: emittedList, labels } = manyEmitted(30);
    const foreign = emitted("x", { prUrl: "https://github.com/example/other/pull/9" });
    const result = evaluateGate({
      labels: [...labels, { ...labeled("x"), prUrl: foreign.prUrl }],
      emitted: [...emittedList, foreign],
      knownPrUrls: KNOWN,
    });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("unknown PR URL"))).toBe(true);
  });

  test("requires every emitted candidate to carry exactly one label", () => {
    const { emitted: emittedList, labels } = manyEmitted(30);
    const result = evaluateGate({ labels: labels.slice(0, 29), emitted: emittedList });
    expect(result.passed).toBe(false);
    expect(result.missing).toEqual([`${PR}#f29`]);
  });

  test("rejects duplicate emitted identities", () => {
    const { emitted: emittedList, labels } = manyEmitted(30);
    const result = evaluateGate({ labels, emitted: [...emittedList, emittedList[0]!] });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("duplicate emitted"))).toBe(true);
  });

  test("reports deterministically sorted identities", () => {
    const emittedList = [emitted("b"), emitted("a")];
    const labels = [labeled("b", "incorrect/unsupported")];
    const first = evaluateGate({ labels, emitted: emittedList });
    const second = evaluateGate({ labels: [...labels].reverse(), emitted: [...emittedList].reverse() });
    expect(first.missing).toEqual(second.missing);
    expect(first.reasons).toEqual(second.reasons);
  });

  test("rejects unknown metricsStatus values", () => {
    const base = {
      entry: {
        repo: "example/repo",
        repoUrl: "https://github.com/example/repo",
        pr: 1,
        prUrl: PR,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
      },
      mergeBase: "c".repeat(40),
      error: null,
      primaryOnly: null,
      advisoryFindings: [],
    };
    for (const status of ["completed", "skipped", "missing"] as const) {
      const parsed = parseHarnessResult("slug", { ...base, advisory: { metricsStatus: status, metricsDetail: null } });
      expect(parsed.advisory?.metricsStatus).toBe(status);
    }
    expect(() =>
      parseHarnessResult("slug", { ...base, advisory: { metricsStatus: "partial", metricsDetail: null } }),
    ).toThrow(/unknown metricsStatus/);
  });

  test("rejects malformed provenance and mergeBase", () => {
    const entry = {
      repo: "example/repo",
      repoUrl: "https://github.com/example/repo",
      pr: 1,
      prUrl: PR,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    };
    const completed = {
      entry,
      mergeBase: "c".repeat(40),
      error: null,
      primaryOnly: null,
      advisory: { metricsStatus: "completed", metricsDetail: null },
      advisoryFindings: [],
    };
    expect(() => parseHarnessResult("slug", { ...completed, entry: { ...entry, headSha: "short" } })).toThrow(
      /malformed provenance/,
    );
    expect(() => parseHarnessResult("slug", { ...completed, entry: { ...entry, pr: -1 } })).toThrow(
      /malformed provenance/,
    );
    expect(() => parseHarnessResult("slug", { ...completed, mergeBase: "short" })).toThrow(/malformed mergeBase/);
    expect(() => parseHarnessResult("slug", { ...completed, mergeBase: null })).toThrow(/without a mergeBase/);
    expect(() => parseHarnessResult("slug", { entry: null, error: "boom", mergeBase: null })).toThrow(/no entry/);
    const failed = parseHarnessResult("slug", { entry, error: "boom", mergeBase: null });
    expect(failed.error).toBe("boom");
    expect(failed.mergeBase).toBeNull();
  });
});

describe("phase6 eval corpus", () => {
  test("accepts the pinned corpus", () => {
    const entries = parseCorpus(corpus as unknown);
    expect(entries.length).toBeGreaterThanOrEqual(MIN_CORPUS_PRS);
    expect(new Set(entries.map((entry) => entry.repo)).size).toBeGreaterThanOrEqual(MIN_CORPUS_REPOS);
  });

  test("rejects short, duplicate, or narrow corpora", () => {
    const entries = parseCorpus(corpus as unknown);
    expect(() => parseCorpus(entries.slice(0, MIN_CORPUS_PRS - 1))).toThrow(/need at least 30/);
    expect(() => parseCorpus([...entries, entries[0]!])).toThrow(/duplicate prUrl/);
    const narrow = entries.map((entry, index) => ({
      ...entry,
      repo: "acme/mono",
      repoUrl: "https://github.com/acme/mono",
      pr: index + 1,
      prUrl: `https://github.com/acme/mono/pull/${index + 1}`,
    }));
    expect(() => parseCorpus(narrow)).toThrow(/spans 1 repos/);
  });

  test("rejects malformed pins", () => {
    const entries = parseCorpus(corpus as unknown);
    const badSha = structuredClone(entries);
    badSha[0]!.headSha = "not-a-sha";
    expect(() => parseCorpus(badSha)).toThrow(/headSha/);
    const badUrl = structuredClone(entries);
    badUrl[1]!.prUrl = "https://github.com/example/repo/pull/999";
    expect(() => parseCorpus(badUrl)).toThrow(/prUrl/);
    const unmerged = structuredClone(entries);
    unmerged[2]!.mergedAt = "";
    expect(() => parseCorpus(unmerged)).toThrow(/merged/);
  });

  test("rejects duplicate manifest slugs", () => {
    const record = { slug: "s", entry: parseCorpus(corpus as unknown)[0], mergeBase: "d".repeat(40) };
    expect(() => parseManifest([record, record])).toThrow(/duplicate slug/);
  });
});

describe("phase6 eval loader provenance", () => {
  const MERGE = "d".repeat(40);
  const OTHER = "e".repeat(40);
  const CORPUS = corpus as ResultProvenance[];
  const resolveMerge: MergeBaseResolver = async () => MERGE;

  function slugFor(entry: ResultProvenance): string {
    return `${entry.repo.replace("/", "-")}-${entry.pr}`;
  }

  function resultBody(entry: ResultProvenance): {
    slug: string;
    entry: ResultProvenance;
    mergeBase: string;
    error: null;
    primaryOnly: { ms: number };
    advisory: {
      ms: number;
      batches: number;
      inputTokens: number;
      outputTokens: number;
      metricsStatus: string;
      metricsDetail: string | null;
    };
    advisoryFindings: Array<Record<string, string>>;
  } {
    return {
      slug: slugFor(entry),
      entry: { ...entry },
      mergeBase: MERGE,
      error: null,
      primaryOnly: { ms: 10 },
      advisory: {
        ms: 20,
        batches: 0,
        inputTokens: 0,
        outputTokens: 0,
        metricsStatus: "completed",
        metricsDetail: null,
      },
      advisoryFindings: [],
    };
  }

  async function populate(dir: string): Promise<void> {
    const manifest: Array<{ slug: string; entry: ResultProvenance; mergeBase: string }> = [];
    for (const [index, entry] of CORPUS.entries()) {
      const slug = slugFor(entry);
      const body = resultBody(entry);
      if (index === 0) {
        body.advisoryFindings = [
          { findingId: "f1", file: "a.ts", category: "convention", severity: "low" },
        ];
      }
      await writeFile(join(dir, `${slug}.json`), `${JSON.stringify(body, null, 2)}\n`, "utf8");
      manifest.push({ slug, entry: { ...entry }, mergeBase: MERGE });
    }
    await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  async function withRunDir(
    run: (dir: string) => Promise<void>,
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "codebleach-gate-"));
    try {
      await populate(dir);
      await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function readBody(dir: string, entry: ResultProvenance): Promise<ReturnType<typeof resultBody>> {
    return JSON.parse(await readFile(join(dir, `${slugFor(entry)}.json`), "utf8")) as ReturnType<typeof resultBody>;
  }

  async function readManifest(dir: string): Promise<Array<{ slug: string; entry: ResultProvenance; mergeBase: string }>> {
    return JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Array<{
      slug: string;
      entry: ResultProvenance;
      mergeBase: string;
    }>;
  }

  test("accepts a fresh current-run sweep", async () => {
    await withRunDir(async (dir) => {
      const inputs = await loadGateInputs(dir, { resolveMergeBase: resolveMerge });
      expect(inputs.healthReasons).toEqual([]);
      expect(inputs.metricsBad).toEqual([]);
      expect(inputs.knownPrUrls.length).toBe(CORPUS.length);
      expect(inputs.emitted).toEqual([
        { prUrl: CORPUS[0]!.prUrl, findingId: "f1", category: "convention", severity: "low" },
      ]);
    });
  });

  test("fails closed without a manifest", async () => {
    await withRunDir(async (dir) => {
      await rm(join(dir, "manifest.json"), { force: true });
      const inputs = await loadGateInputs(dir, { resolveMergeBase: resolveMerge });
      expect(inputs.healthReasons.some((reason) => reason.includes("manifest.json absent"))).toBe(true);
    });
  });

  test("rejects result files absent from the manifest", async () => {
    await withRunDir(async (dir) => {
      const manifest = await readManifest(dir);
      await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest.slice(1), null, 2), "utf8");
      const inputs = await loadGateInputs(dir, { resolveMergeBase: resolveMerge });
      expect(
        inputs.healthReasons.some((reason) => reason.includes(`${slugFor(CORPUS[0]!)}.json absent from manifest`)),
      ).toBe(true);
    });
  });

  test("rejects stale manifest entries", async () => {
    await withRunDir(async (dir) => {
      const manifest = await readManifest(dir);
      manifest[0]!.mergeBase = OTHER;
      await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
      const inputs = await loadGateInputs(dir, { resolveMergeBase: resolveMerge });
      expect(
        inputs.healthReasons.some((reason) => reason.includes(`manifest entry for ${slugFor(CORPUS[0]!)} differs`)),
      ).toBe(true);
    });
  });

  test("rejects stale pinned SHAs", async () => {
    await withRunDir(async (dir) => {
      const body = await readBody(dir, CORPUS[0]!);
      body.entry.headSha = OTHER;
      await writeFile(join(dir, `${slugFor(CORPUS[0]!)}.json`), JSON.stringify(body, null, 2), "utf8");
      const inputs = await loadGateInputs(dir, { resolveMergeBase: resolveMerge });
      expect(inputs.healthReasons.some((reason) => reason.includes("stale SHAs"))).toBe(true);
    });
  });

  test("rejects recomputed merge-base drift", async () => {
    await withRunDir(async (dir) => {
      const inputs = await loadGateInputs(dir, { resolveMergeBase: async () => OTHER });
      expect(inputs.healthReasons.some((reason) => reason.includes("stale merge-base"))).toBe(true);
    });
  });

  test("fails closed when history is unavailable", async () => {
    await withRunDir(async (dir) => {
      const failing: MergeBaseResolver = async () => {
        throw new Error("missing checkout");
      };
      const inputs = await loadGateInputs(dir, { resolveMergeBase: failing });
      expect(inputs.healthReasons.some((reason) => reason.includes("cannot verify history"))).toBe(true);
    });
  });

  test("rejects unknown result files", async () => {
    await withRunDir(async (dir) => {
      const body = resultBody(CORPUS[0]!);
      await writeFile(join(dir, "unknown-1.json"), JSON.stringify(body, null, 2), "utf8");
      const inputs = await loadGateInputs(dir, { resolveMergeBase: resolveMerge });
      expect(inputs.healthReasons.some((reason) => reason.includes("unknown PR"))).toBe(true);
    });
  });

  test("reports missing results", async () => {
    await withRunDir(async (dir) => {
      await rm(join(dir, `${slugFor(CORPUS[0]!)}.json`), { force: true });
      const manifest = (await readManifest(dir)).filter((record) => record.slug !== slugFor(CORPUS[0]!));
      await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
      const inputs = await loadGateInputs(dir, { resolveMergeBase: resolveMerge });
      expect(inputs.healthReasons.some((reason) => reason.includes(`missing result for ${CORPUS[0]!.prUrl}`))).toBe(
        true,
      );
    });
  });

  test("pins missing metrics as gate failures", async () => {
    await withRunDir(async (dir) => {
      const body = await readBody(dir, CORPUS[0]!);
      body.advisory.metricsStatus = "missing";
      body.advisory.metricsDetail = "no telemetry";
      await writeFile(join(dir, `${slugFor(CORPUS[0]!)}.json`), JSON.stringify(body, null, 2), "utf8");
      const inputs = await loadGateInputs(dir, { resolveMergeBase: resolveMerge });
      expect(inputs.healthReasons).toEqual([]);
      expect(inputs.metricsBad).toEqual([`${CORPUS[0]!.prUrl}: no telemetry`]);
    });
  });

  test("reports manifest entries with no result file", async () => {
    await withRunDir(async (dir) => {
      await rm(join(dir, `${slugFor(CORPUS[0]!)}.json`), { force: true });
      const inputs = await loadGateInputs(dir, { resolveMergeBase: resolveMerge });
      expect(
        inputs.healthReasons.some((reason) =>
          reason.includes(`manifest lists ${slugFor(CORPUS[0]!)} with no result file`),
        ),
      ).toBe(true);
    });
  });

  test("indexes exactly the current run", () => {
    const provenance = { ...CORPUS[0]! };
    const slug = slugFor(CORPUS[0]!);
    const files = new Map([[slug, { provenance, mergeBase: MERGE }]]);
    expect(checkManifestConsistency([{ slug, provenance, mergeBase: MERGE }], files)).toEqual([]);
    expect(checkManifestConsistency([{ slug, provenance, mergeBase: OTHER }], files)).toHaveLength(1);
    expect(checkManifestConsistency([], files)).toHaveLength(1);
  });
});
