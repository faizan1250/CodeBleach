import { describe, expect, test } from "bun:test";
import { CONVENTION_DETECTOR_NAMING, CONVENTION_DETECTOR_NAMING_VERSION } from "../../../src/conventions/constants.ts";
import { detectNamingExports } from "../../../src/conventions/detectors/naming.ts";
import { DEFAULT_MODULE, NAMED_MODULE, withParsedSamples } from "./sample-helpers.ts";

describe("naming-export detector", () => {
  test("reports dominant named style", async () => {
    await withParsedSamples(
      [
        { path: "src/a.ts", language: "typescript", source: NAMED_MODULE("marker-a") },
        { path: "src/b.ts", language: "typescript", source: NAMED_MODULE("marker-b") },
        { path: "src/c.ts", language: "typescript", source: NAMED_MODULE("marker-c") },
      ],
      (files) => {
        const candidates = detectNamingExports(files);
        expect(candidates).toHaveLength(1);
        const candidate = candidates[0];
        expect(candidate?.detector).toBe(CONVENTION_DETECTOR_NAMING);
        expect(candidate?.detectorVersion).toBe(CONVENTION_DETECTOR_NAMING_VERSION);
        expect(candidate?.pattern).toBe("Modules predominantly use named exports.");
        expect(candidate?.matchingFiles).toBe(3);
        expect(candidate?.eligibleFiles).toBe(3);
        expect(candidate?.sampledFiles).toBe(3);
        expect(candidate?.supportRatio).toBe(1);
        expect(candidate?.evidence.map((entry) => entry.file)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
      },
    );
  });

  test("reports dominant default style", async () => {
    await withParsedSamples(
      [
        { path: "src/a.ts", language: "typescript", source: DEFAULT_MODULE("marker-a") },
        { path: "src/b.ts", language: "typescript", source: DEFAULT_MODULE("marker-b") },
      ],
      (files) => {
        const candidates = detectNamingExports(files);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.pattern).toBe("Modules predominantly use default exports.");
        expect(candidates[0]?.matchingFiles).toBe(2);
      },
    );
  });

  test("plurality wins across mixed files", async () => {
    await withParsedSamples(
      [
        { path: "src/a.ts", language: "typescript", source: NAMED_MODULE("m-a") },
        { path: "src/b.ts", language: "typescript", source: NAMED_MODULE("m-b") },
        { path: "src/c.ts", language: "typescript", source: DEFAULT_MODULE("m-c") },
      ],
      (files) => {
        const candidates = detectNamingExports(files);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.pattern).toBe("Modules predominantly use named exports.");
        expect(candidates[0]?.matchingFiles).toBe(2);
        expect(candidates[0]?.eligibleFiles).toBe(3);
      },
    );
  });

  test("tie and export-free input emit nothing", async () => {
    await withParsedSamples(
      [
        { path: "src/a.ts", language: "typescript", source: NAMED_MODULE("m-a") },
        { path: "src/b.ts", language: "typescript", source: DEFAULT_MODULE("m-b") },
      ],
      (files) => {
        expect(detectNamingExports(files)).toEqual([]);
      },
    );
    await withParsedSamples(
      [{ path: "src/a.ts", language: "typescript", source: "const x = 1;\nconsole.log(x);\n" }],
      (files) => {
        expect(detectNamingExports(files)).toEqual([]);
      },
    );
    await withParsedSamples([], (files) => {
      expect(detectNamingExports(files)).toEqual([]);
    });
  });

  test("mixed named-plus-default file supports neither style", async () => {
    await withParsedSamples(
      [
        {
          path: "src/a.ts",
          language: "typescript",
          source: "export function a(): void {}\nexport default function b(): void {}\n",
        },
        { path: "src/b.ts", language: "typescript", source: NAMED_MODULE("m-b") },
      ],
      (files) => {
        const candidates = detectNamingExports(files);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.matchingFiles).toBe(1);
        expect(candidates[0]?.eligibleFiles).toBe(2);
      },
    );
  });

  test("star re-export counts toward named style", async () => {
    await withParsedSamples(
      [
        { path: "src/a.ts", language: "typescript", source: 'export * from "./inner";\n' },
        { path: "src/b.ts", language: "typescript", source: NAMED_MODULE("m-b") },
      ],
      (files) => {
        const candidates = detectNamingExports(files);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.pattern).toBe("Modules predominantly use named exports.");
        expect(candidates[0]?.matchingFiles).toBe(2);
      },
    );
  });

  test("output is order-invariant and excerpt-free", async () => {
    const fixtures = [
      { path: "src/b.ts", language: "typescript" as const, source: NAMED_MODULE("secret-marker-b") },
      { path: "src/a.ts", language: "typescript" as const, source: NAMED_MODULE("secret-marker-a") },
      { path: "src/c.ts", language: "typescript" as const, source: NAMED_MODULE("secret-marker-c") },
    ];
    const forward = await withParsedSamples(fixtures, (files) => detectNamingExports(files));
    const backward = await withParsedSamples([...fixtures].reverse(), (files) => detectNamingExports(files));
    expect(backward).toEqual(forward);
    const serialized = JSON.stringify(forward);
    expect(serialized).not.toContain("secret-marker");
  });
});
