import { describe, expect, test } from "bun:test";
import {
  CONVENTION_DETECTOR_COMMON_WRAPPERS,
  CONVENTION_DETECTOR_COMMON_WRAPPERS_VERSION,
} from "../../../src/conventions/constants.ts";
import { detectCommonWrappers } from "../../../src/conventions/detectors/wrappers.ts";
import { filterConventions } from "../../../src/conventions/support.ts";
import { withParsedSamples } from "./sample-helpers.ts";
import type { SampleFixture } from "./sample-helpers.ts";

const HELPER = "export function wrap(fn: () => number): number {\n  return fn();\n}\n";
const HELPER_EACH = "export function each(fn: () => number): number {\n  return fn();\n}\n";

const WRAP_PATTERN = "Modules importing the repository helper wrap repeatedly wrap callbacks with it.";
const EACH_PATTERN = "Modules importing the repository helper each repeatedly wrap callbacks with it.";

function importer(marker: string, from = "../lib/wrap", local = "wrap"): string {
  return `// ${marker}\nimport { ${local === "wrap" ? "wrap" : `wrap as ${local}`} } from "${from}";\nexport const out = ${local}(() => 1);\n`;
}

function importerFixtures(count: number): SampleFixture[] {
  const fixtures: SampleFixture[] = [{ path: "src/lib/wrap.ts", language: "typescript", source: HELPER }];
  for (let index = 0; index < count; index += 1) {
    fixtures.push({
      path: `src/pages/p${index}.ts`,
      language: "typescript",
      source: importer(`marker-${index}`),
    });
  }
  return fixtures;
}

function unrelated(path: string, marker: string): SampleFixture {
  return { path, language: "typescript", source: `// ${marker}\nexport const value = 1;\n` };
}

function silentImporter(path: string, marker: string): SampleFixture {
  return {
    path,
    language: "typescript",
    source: `// ${marker}\nimport { wrap } from "../lib/wrap";\nexport const value = 1;\n`,
  };
}

describe("common-wrappers detector", () => {
  test("reports helpers used by at least five importing files", async () => {
    await withParsedSamples(importerFixtures(5), (files) => {
      const candidates = detectCommonWrappers(files);
      expect(candidates).toHaveLength(1);
      const candidate = candidates[0];
      expect(candidate?.detector).toBe(CONVENTION_DETECTOR_COMMON_WRAPPERS);
      expect(candidate?.detectorVersion).toBe(CONVENTION_DETECTOR_COMMON_WRAPPERS_VERSION);
      expect(candidate?.pattern).toBe(WRAP_PATTERN);
      expect(candidate?.matchingFiles).toBe(5);
      expect(candidate?.eligibleFiles).toBe(5);
      expect(candidate?.sampledFiles).toBe(6);
      expect(candidate?.evidence.map((entry) => entry.file)).toEqual([
        "src/pages/p0.ts",
        "src/pages/p1.ts",
        "src/pages/p2.ts",
        "src/pages/p3.ts",
        "src/pages/p4.ts",
      ]);
      for (const entry of candidate?.evidence ?? []) {
        expect(Object.keys(entry).sort()).toEqual(["endLine", "file", "kind", "startLine"]);
      }
    });
  });

  test("ignores sampled files that never import the helper", async () => {
    const fixtures = [
      ...importerFixtures(5),
      unrelated("src/other/u0.ts", "u-marker-0"),
      unrelated("src/other/u1.ts", "u-marker-1"),
      unrelated("src/other/u2.ts", "u-marker-2"),
    ];
    await withParsedSamples(fixtures, (files) => {
      const candidates = detectCommonWrappers(files);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.matchingFiles).toBe(5);
      expect(candidates[0]?.eligibleFiles).toBe(5);
      expect(candidates[0]?.sampledFiles).toBe(9);
    });
  });

  test("accepts exactly at the support boundary", async () => {
    const fixtures: SampleFixture[] = [{ path: "src/lib/wrap.ts", language: "typescript", source: HELPER }];
    for (let index = 0; index < 6; index += 1) {
      fixtures.push({
        path: `src/pages/p${index}.ts`,
        language: "typescript",
        source: importer(`marker-${index}`),
      });
    }
    fixtures.push(silentImporter("src/pages/s0.ts", "silent-0"));
    fixtures.push(silentImporter("src/pages/s1.ts", "silent-1"));
    await withParsedSamples(fixtures, (files) => {
      const candidates = detectCommonWrappers(files);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.matchingFiles).toBe(6);
      expect(candidates[0]?.eligibleFiles).toBe(8);
      expect(candidates[0]?.supportRatio).toBe(0.75);
      const conventions = filterConventions(candidates);
      expect(conventions).toHaveLength(1);
      expect(conventions[0]?.matchingFiles).toBe(6);
      expect(conventions[0]?.eligibleFiles).toBe(8);
      expect(conventions[0]?.supportRatio).toBe(0.75);
      expect(conventions[0]?.id).toMatch(/^inf-[0-9a-f]{16}$/);
    });
  });

  test("rejects just below the support ratio", async () => {
    const fixtures: SampleFixture[] = [{ path: "src/lib/wrap.ts", language: "typescript", source: HELPER }];
    for (let index = 0; index < 5; index += 1) {
      fixtures.push({
        path: `src/pages/p${index}.ts`,
        language: "typescript",
        source: importer(`marker-${index}`),
      });
    }
    fixtures.push(silentImporter("src/pages/s0.ts", "silent-0"));
    fixtures.push(silentImporter("src/pages/s1.ts", "silent-1"));
    await withParsedSamples(fixtures, (files) => {
      // The detector still emits at the evidence minimum; the support gate
      // rejects 5 of 7 below the ratio.
      const candidates = detectCommonWrappers(files);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.matchingFiles).toBe(5);
      expect(candidates[0]?.eligibleFiles).toBe(7);
      expect(filterConventions(candidates)).toEqual([]);
    });
  });

  test("fewer than five users emits nothing", async () => {
    await withParsedSamples(importerFixtures(4), (files) => {
      expect(detectCommonWrappers(files)).toEqual([]);
    });
  });

  test("counts at most one match per file with several calls", async () => {
    const fixtures: SampleFixture[] = [{ path: "src/lib/wrap.ts", language: "typescript", source: HELPER }];
    for (let index = 0; index < 5; index += 1) {
      fixtures.push({
        path: `src/pages/p${index}.ts`,
        language: "typescript",
        source: `// multi-${index}\nimport { wrap } from "../lib/wrap";\nexport const a = wrap(() => 1);\nexport const b = wrap(() => 2);\nexport const c = wrap(() => 3);\n`,
      });
    }
    await withParsedSamples(fixtures, (files) => {
      const candidates = detectCommonWrappers(files);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.matchingFiles).toBe(5);
      expect(candidates[0]?.eligibleFiles).toBe(5);
      expect(candidates[0]?.evidence).toHaveLength(5);
    });
  });

  test("duplicate and aliased imports of one helper count once", async () => {
    const fixtures = importerFixtures(4);
    fixtures.push({
      path: "src/pages/dup.ts",
      language: "typescript",
      source:
        '// dup\nimport { wrap } from "../lib/wrap";\nimport { wrap } from "../lib/wrap";\nimport { wrap as w } from "../lib/wrap";\nexport const a = wrap(() => 1);\nexport const b = w(() => 2);\n',
    });
    await withParsedSamples(fixtures, (files) => {
      const candidates = detectCommonWrappers(files);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.matchingFiles).toBe(5);
      expect(candidates[0]?.eligibleFiles).toBe(5);
    });
  });

  test("keeps per-helper denominators independent", async () => {
    const fixtures: SampleFixture[] = [
      { path: "src/lib/wrap.ts", language: "typescript", source: HELPER },
      { path: "src/lib/other.ts", language: "typescript", source: HELPER_EACH },
    ];
    for (let index = 0; index < 5; index += 1) {
      fixtures.push({
        path: `src/pages/q${index}.ts`,
        language: "typescript",
        source: `// both-${index}\nimport { wrap } from "../lib/wrap";\nimport { each } from "../lib/other";\nexport const a = wrap(() => 1);\nexport const b = each(() => 2);\n`,
      });
    }
    fixtures.push(unrelated("src/other/u0.ts", "u-marker-0"));
    fixtures.push(unrelated("src/other/u1.ts", "u-marker-1"));
    fixtures.push(unrelated("src/other/u2.ts", "u-marker-2"));
    await withParsedSamples(fixtures, (files) => {
      const candidates = detectCommonWrappers(files);
      expect(candidates).toHaveLength(2);
      expect(candidates.map((candidate) => candidate.pattern)).toEqual([EACH_PATTERN, WRAP_PATTERN]);
      for (const candidate of candidates) {
        expect(candidate.matchingFiles).toBe(5);
        expect(candidate.eligibleFiles).toBe(5);
        expect(candidate.sampledFiles).toBe(10);
      }
    });
  });

  test("ignores calls shadowed by function and arrow parameters", async () => {
    const fixtures: SampleFixture[] = [{ path: "src/lib/wrap.ts", language: "typescript", source: HELPER }];
    for (let index = 0; index < 3; index += 1) {
      fixtures.push({
        path: `src/pages/f${index}.ts`,
        language: "typescript",
        source: `// fparam-${index}\nimport { wrap } from "../lib/wrap";\nexport function run(wrap: (fn: () => number) => number): number {\n  return wrap(() => 1);\n}\n`,
      });
    }
    for (let index = 0; index < 2; index += 1) {
      fixtures.push({
        path: `src/pages/a${index}.ts`,
        language: "typescript",
        source: `// aparam-${index}\nimport { wrap } from "../lib/wrap";\nexport const run = (wrap: (fn: () => number) => number): number => wrap(() => 1);\n`,
      });
    }
    await withParsedSamples(fixtures, (files) => {
      expect(detectCommonWrappers(files)).toEqual([]);
    });
  });

  test("ignores calls shadowed by blocks, vars, destructuring, and catch", async () => {
    const fixtures: SampleFixture[] = [
      { path: "src/lib/wrap.ts", language: "typescript", source: HELPER },
      {
        path: "src/pages/block.ts",
        language: "typescript",
        source:
          '// block\nimport { wrap } from "../lib/wrap";\n{\n  const wrap = (fn: () => number): number => fn();\n  wrap(() => 1);\n}\n',
      },
      {
        path: "src/pages/hoisted.ts",
        language: "typescript",
        source:
          '// hoisted\nimport { wrap } from "../lib/wrap";\nexport function run(): number {\n  {\n    var wrap = 1;\n  }\n  return wrap(() => 1);\n}\n',
      },
      {
        path: "src/pages/destructure.ts",
        language: "typescript",
        source:
          '// destructure\nimport { wrap } from "../lib/wrap";\nconst box = { wrap: (fn: () => number): number => fn() };\nconst { wrap } = box;\nexport const out = wrap(() => 1);\n',
      },
      {
        path: "src/pages/array.ts",
        language: "typescript",
        source:
          '// array\nimport { wrap } from "../lib/wrap";\nconst fns = [(fn: () => number): number => fn()];\nconst [wrap] = fns;\nexport const out = wrap(() => 1);\n',
      },
      {
        path: "src/pages/caught.ts",
        language: "typescript",
        source:
          '// caught\nimport { wrap } from "../lib/wrap";\ntry {\n  throw new Error("x");\n} catch (wrap) {\n  wrap(() => 1);\n}\n',
      },
    ];
    await withParsedSamples(fixtures, (files) => {
      expect(detectCommonWrappers(files)).toEqual([]);
    });
  });

  test("ignores calls shadowed by local function and class declarations", async () => {
    const fixtures: SampleFixture[] = [{ path: "src/lib/wrap.ts", language: "typescript", source: HELPER }];
    for (let index = 0; index < 3; index += 1) {
      fixtures.push({
        path: `src/pages/f${index}.ts`,
        language: "typescript",
        source: `// fndecl-${index}\nimport { wrap } from "../lib/wrap";\nfunction wrap(fn: () => number): number {\n  return fn();\n}\nexport const out = wrap(() => 1);\n`,
      });
    }
    for (let index = 0; index < 2; index += 1) {
      fixtures.push({
        path: `src/pages/c${index}.ts`,
        language: "typescript",
        source: `// classdecl-${index}\nimport { wrap } from "../lib/wrap";\nclass wrap {\n  run(fn: () => number): number {\n    return fn();\n  }\n}\nexport const out = wrap(() => 1);\n`,
      });
    }
    await withParsedSamples(fixtures, (files) => {
      expect(detectCommonWrappers(files)).toEqual([]);
    });
  });

  test("matches unshadowed calls in nested scopes", async () => {
    const fixtures: SampleFixture[] = [{ path: "src/lib/wrap.ts", language: "typescript", source: HELPER }];
    for (let index = 0; index < 3; index += 1) {
      fixtures.push({
        path: `src/pages/n${index}.ts`,
        language: "typescript",
        source: `// nested-${index}\nimport { wrap } from "../lib/wrap";\nexport function run(): number {\n  return wrap(() => 1);\n}\n`,
      });
    }
    for (let index = 0; index < 2; index += 1) {
      fixtures.push({
        path: `src/pages/d${index}.ts`,
        language: "typescript",
        source: `// property-${index}\nimport { wrap } from "../lib/wrap";\nconst box = { wrap: 1 };\nconst { wrap: renamed } = box;\nexport const out = wrap(() => 1);\nexport const kept = renamed;\n`,
      });
    }
    await withParsedSamples(fixtures, (files) => {
      const candidates = detectCommonWrappers(files);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.matchingFiles).toBe(5);
      expect(candidates[0]?.eligibleFiles).toBe(5);
    });
  });

  test("matches files with both shadowed and unshadowed calls", async () => {
    const fixtures: SampleFixture[] = [{ path: "src/lib/wrap.ts", language: "typescript", source: HELPER }];
    for (let index = 0; index < 5; index += 1) {
      fixtures.push({
        path: `src/pages/m${index}.ts`,
        language: "typescript",
        source: `// mixed-${index}\nimport { wrap } from "../lib/wrap";\nexport function shadowed(wrap: (fn: () => number) => number): number {\n  return wrap(() => 1);\n}\nexport const out = wrap(() => 2);\n`,
      });
    }
    await withParsedSamples(fixtures, (files) => {
      const candidates = detectCommonWrappers(files);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.matchingFiles).toBe(5);
      expect(candidates[0]?.eligibleFiles).toBe(5);
    });
  });

  test("ambiguous bindings across two helpers match neither", async () => {
    const fixtures: SampleFixture[] = [
      { path: "src/lib/a.ts", language: "typescript", source: HELPER },
      {
        path: "src/lib/b.ts",
        language: "typescript",
        source: "export function wrap(fn: () => number): number {\n  return fn();\n}\n",
      },
    ];
    for (let index = 0; index < 5; index += 1) {
      fixtures.push({
        path: `src/pages/p${index}.ts`,
        language: "typescript",
        source: `// ambiguous-${index}\nimport { wrap } from "../lib/a";\nimport { wrap } from "../lib/b";\nexport const out = wrap(() => 1);\n`,
      });
    }
    await withParsedSamples(fixtures, (files) => {
      expect(detectCommonWrappers(files)).toEqual([]);
    });
  });

  test("skips calls inside dynamic with scopes", async () => {
    const fixtures: SampleFixture[] = [{ path: "src/lib/wrap.ts", language: "typescript", source: HELPER }];
    for (let index = 0; index < 5; index += 1) {
      fixtures.push({
        path: `src/pages/w${index}.ts`,
        language: "typescript",
        source: `// with-${index}\nimport { wrap } from "../lib/wrap";\nconst obj = { run: 1 };\nwith (obj) {\n  wrap(() => 1);\n}\nexport const done = 1;\n`,
      });
    }
    await withParsedSamples(fixtures, (files) => {
      expect(detectCommonWrappers(files)).toEqual([]);
    });
  });

  test("for-in let shadows, bare targets still resolve", async () => {
    const fixtures: SampleFixture[] = [{ path: "src/lib/wrap.ts", language: "typescript", source: HELPER }];
    for (let index = 0; index < 5; index += 1) {
      fixtures.push({
        path: `src/pages/s${index}.ts`,
        language: "typescript",
        source: `// forin-shadow-${index}\nimport { wrap } from "../lib/wrap";\nconst obj = {};\nfor (let wrap in obj) {\n  wrap(() => 1);\n}\n`,
      });
    }
    for (let index = 0; index < 5; index += 1) {
      fixtures.push({
        path: `src/pages/b${index}.ts`,
        language: "typescript",
        source: `// forin-bare-${index}\nimport { wrap } from "../lib/wrap";\nconst obj = {};\nfor (wrap in obj) {\n  wrap(() => 1);\n}\n`,
      });
    }
    await withParsedSamples(fixtures, (files) => {
      const candidates = detectCommonWrappers(files);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.matchingFiles).toBe(5);
      expect(candidates[0]?.eligibleFiles).toBe(10);
      expect(candidates[0]?.evidence.map((entry) => entry.file).sort()).toEqual([
        "src/pages/b0.ts",
        "src/pages/b1.ts",
        "src/pages/b2.ts",
        "src/pages/b3.ts",
        "src/pages/b4.ts",
      ]);
    });
  });

  test("is deterministic across input orders", async () => {
    const fixtures = [
      ...importerFixtures(5),
      unrelated("src/other/u0.ts", "u-marker-0"),
      unrelated("src/other/u1.ts", "u-marker-1"),
    ];
    await withParsedSamples(fixtures, (files) => {
      const forward = detectCommonWrappers(files);
      const backward = detectCommonWrappers([...files].reverse());
      expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
      expect(forward).toHaveLength(1);
    });
  });

  test("local aliases resolve to the exported name", async () => {
    const fixtures = importerFixtures(4);
    fixtures.push({
      path: "src/pages/alias.ts",
      language: "typescript",
      source: importer("marker-alias", "../lib/wrap", "w"),
    });
    await withParsedSamples(fixtures, (files) => {
      const candidates = detectCommonWrappers(files);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.pattern).toBe(WRAP_PATTERN);
      expect(candidates[0]?.matchingFiles).toBe(5);
    });
  });

  test("non-relative, package, and unresolved imports never match", async () => {
    await withParsedSamples(
      [
        { path: "src/lib/wrap.ts", language: "typescript", source: HELPER },
        {
          path: "src/a.ts",
          language: "typescript",
          source: 'import { wrap } from "lodash";\nexport const out = wrap(() => 1);\n',
        },
        {
          path: "src/b.ts",
          language: "typescript",
          source: 'import { wrap } from "@/lib/wrap";\nexport const out = wrap(() => 1);\n',
        },
        {
          path: "src/c.ts",
          language: "typescript",
          source: 'import { wrap } from "./missing";\nexport const out = wrap(() => 1);\n',
        },
      ],
      (files) => {
        expect(detectCommonWrappers(files)).toEqual([]);
      },
    );
  });

  test("ambiguous extension resolution emits nothing", async () => {
    await withParsedSamples(
      [
        { path: "src/lib/foo.ts", language: "typescript", source: HELPER },
        { path: "src/lib/foo.tsx", language: "tsx", source: HELPER },
        ...[0, 1, 2, 3, 4].map((index) => ({
          path: `src/p${index}.ts`,
          language: "typescript" as const,
          source: `import { wrap } from "./lib/foo";\nexport const out = wrap(() => ${index});\n`,
        })),
      ],
      (files) => {
        expect(detectCommonWrappers(files)).toEqual([]);
      },
    );
  });

  test("non-function first arguments and non-callback calls never match", async () => {
    await withParsedSamples(
      [
        { path: "src/lib/wrap.ts", language: "typescript", source: HELPER },
        {
          path: "src/a.ts",
          language: "typescript",
          source: 'import { wrap } from "./lib/wrap";\nconst fn = () => 1;\nexport const out = wrap(fn);\n',
        },
        {
          path: "src/b.ts",
          language: "typescript",
          source: 'import { wrap } from "../lib/wrap";\nexport const out = wrap(() => 1);\n',
        },
      ],
      (files) => {
        // src/a.ts resolves but passes a named reference instead of an
        // inline callback; src/b.ts escapes the sampled tree. Neither matches.
        expect(detectCommonWrappers(files)).toEqual([]);
      },
    );
  });

  test("default and namespace imports are not wrapper bindings", async () => {
    await withParsedSamples(
      [
        { path: "src/lib/wrap.ts", language: "typescript", source: HELPER },
        ...[0, 1, 2, 3, 4].map((index) => ({
          path: `src/pages/p${index}.ts`,
          language: "typescript" as const,
          source: `import wrap from "../lib/wrap";\nexport const out = wrap(() => ${index});\n`,
        })),
      ],
      (files) => {
        expect(detectCommonWrappers(files)).toEqual([]);
      },
    );
    await withParsedSamples(
      [
        { path: "src/lib/wrap.ts", language: "typescript", source: HELPER },
        ...[0, 1, 2, 3, 4].map((index) => ({
          path: `src/pages/p${index}.ts`,
          language: "typescript" as const,
          source: `import * as lib from "../lib/wrap";\nexport const out = lib.wrap(() => ${index});\n`,
        })),
      ],
      (files) => {
        expect(detectCommonWrappers(files)).toEqual([]);
      },
    );
  });

  test("arbitrary string import names fail the identifier allowlist", async () => {
    const fixtures: SampleFixture[] = [{ path: "src/lib/wrap.ts", language: "typescript", source: HELPER }];
    for (let index = 0; index < 5; index += 1) {
      fixtures.push({
        path: `src/pages/s${index}.ts`,
        language: "typescript",
        source: `import { "weird name" as w } from "../lib/wrap";\nexport const out = w(() => ${index});\n`,
      });
    }
    await withParsedSamples(fixtures, (files) => {
      expect(detectCommonWrappers(files)).toEqual([]);
    });
  });

  test("test files never count as importing modules", async () => {
    const fixtures: SampleFixture[] = [{ path: "src/lib/wrap.ts", language: "typescript", source: HELPER }];
    for (let index = 0; index < 5; index += 1) {
      fixtures.push({
        path: `src/pages/p${index}.test.ts`,
        language: "typescript",
        source: importer(`marker-${index}`),
      });
    }
    await withParsedSamples(fixtures, (files) => {
      expect(detectCommonWrappers(files)).toEqual([]);
    });
  });

  test("output carries no source excerpts", async () => {
    const fixtures = importerFixtures(5);
    await withParsedSamples(fixtures, (files) => {
      const candidates = detectCommonWrappers(files);
      expect(candidates).toHaveLength(1);
      const serialized = JSON.stringify(candidates);
      expect(serialized).not.toContain("marker-");
      expect(serialized).not.toContain("return fn()");
    });
  });
});
