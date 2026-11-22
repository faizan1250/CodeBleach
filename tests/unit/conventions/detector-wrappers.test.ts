import { describe, expect, test } from "bun:test";
import {
  CONVENTION_DETECTOR_COMMON_WRAPPERS,
  CONVENTION_DETECTOR_COMMON_WRAPPERS_VERSION,
} from "../../../src/conventions/constants.ts";
import { detectCommonWrappers } from "../../../src/conventions/detectors/wrappers.ts";
import { withParsedSamples } from "./sample-helpers.ts";
import type { SampleFixture } from "./sample-helpers.ts";

const HELPER = "export function wrap(fn: () => number): number {\n  return fn();\n}\n";

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

describe("common-wrappers detector", () => {
  test("reports helpers used by at least five files", async () => {
    await withParsedSamples(importerFixtures(5), (files) => {
      const candidates = detectCommonWrappers(files);
      expect(candidates).toHaveLength(1);
      const candidate = candidates[0];
      expect(candidate?.detector).toBe(CONVENTION_DETECTOR_COMMON_WRAPPERS);
      expect(candidate?.detectorVersion).toBe(CONVENTION_DETECTOR_COMMON_WRAPPERS_VERSION);
      expect(candidate?.pattern).toBe("Modules repeatedly wrap callbacks with the repository helper wrap.");
      expect(candidate?.matchingFiles).toBe(5);
      expect(candidate?.eligibleFiles).toBe(6);
      expect(candidate?.sampledFiles).toBe(6);
      expect(candidate?.evidence.map((entry) => entry.file)).toEqual([
        "src/pages/p0.ts",
        "src/pages/p1.ts",
        "src/pages/p2.ts",
        "src/pages/p3.ts",
        "src/pages/p4.ts",
      ]);
    });
  });

  test("fewer than five users emits nothing", async () => {
    await withParsedSamples(importerFixtures(4), (files) => {
      expect(detectCommonWrappers(files)).toEqual([]);
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
      expect(candidates[0]?.pattern).toBe("Modules repeatedly wrap callbacks with the repository helper wrap.");
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
          path: `src/p${index}.ts`,
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
          path: `src/p${index}.ts`,
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
        path: `src/p${index}.test.ts`,
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
