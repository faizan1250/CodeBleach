import { describe, expect, test } from "bun:test";
import {
  CONVENTION_DETECTOR_ERROR_HANDLING,
  CONVENTION_DETECTOR_ERROR_HANDLING_VERSION,
} from "../../../src/conventions/constants.ts";
import { detectErrorHandling } from "../../../src/conventions/detectors/errors.ts";
import { RESULT_MODULE, THROW_MODULE, withParsedSamples } from "./sample-helpers.ts";

const REJECT_MODULE = (marker: string): string =>
  `// ${marker}\nexport function run(): Promise<number> {\n  return Promise.reject(new Error("no"));\n}\n`;

describe("error-handling detector", () => {
  test("reports dominant result style", async () => {
    await withParsedSamples(
      [
        { path: "src/a.ts", language: "typescript", source: RESULT_MODULE("marker-a") },
        { path: "src/b.ts", language: "typescript", source: RESULT_MODULE("marker-b") },
      ],
      (files) => {
        const candidates = detectErrorHandling(files);
        expect(candidates).toHaveLength(1);
        const candidate = candidates[0];
        expect(candidate?.detector).toBe(CONVENTION_DETECTOR_ERROR_HANDLING);
        expect(candidate?.detectorVersion).toBe(CONVENTION_DETECTOR_ERROR_HANDLING_VERSION);
        expect(candidate?.pattern).toBe("The repository predominantly uses typed Result-style error returns.");
        expect(candidate?.matchingFiles).toBe(2);
        expect(candidate?.eligibleFiles).toBe(2);
        expect(candidate?.supportRatio).toBe(1);
      },
    );
  });

  test("reports dominant throw style", async () => {
    await withParsedSamples(
      [
        { path: "src/a.ts", language: "typescript", source: THROW_MODULE("marker-a") },
        { path: "src/b.ts", language: "typescript", source: THROW_MODULE("marker-b") },
      ],
      (files) => {
        const candidates = detectErrorHandling(files);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.pattern).toBe("The repository predominantly uses throw-style error handling.");
        expect(candidates[0]?.matchingFiles).toBe(2);
      },
    );
  });

  test("promise rejection counts as throw signal", async () => {
    await withParsedSamples(
      [{ path: "src/a.ts", language: "typescript", source: REJECT_MODULE("marker-a") }],
      (files) => {
        const candidates = detectErrorHandling(files);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.pattern).toBe("The repository predominantly uses throw-style error handling.");
      },
    );
  });

  test("mixed signals in one file support neither style", async () => {
    await withParsedSamples(
      [
        {
          path: "src/a.ts",
          language: "typescript",
          source:
            'export function load(): Result<string, Error> {\n  if (1 > 2) throw new Error("x");\n  return null as unknown as Result<string, Error>;\n}\n',
        },
        { path: "src/b.ts", language: "typescript", source: RESULT_MODULE("marker-b") },
      ],
      (files) => {
        const candidates = detectErrorHandling(files);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.matchingFiles).toBe(1);
        expect(candidates[0]?.eligibleFiles).toBe(2);
      },
    );
  });

  test("signal-free files stay outside the denominator", async () => {
    await withParsedSamples(
      [
        { path: "src/a.ts", language: "typescript", source: "export function pure(): number {\n  return 1;\n}\n" },
        {
          path: "src/b.ts",
          language: "typescript",
          source: "export function maybe(): Promise<number> {\n  return Promise.resolve(1);\n}\n",
        },
      ],
      (files) => {
        expect(detectErrorHandling(files)).toEqual([]);
      },
    );
  });

  test("qualified result types and unions are not recognized", async () => {
    await withParsedSamples(
      [
        {
          path: "src/a.ts",
          language: "typescript",
          source: "export function q(): Foo.Result<number> {\n  return null as unknown as Foo.Result<number>;\n}\n",
        },
      ],
      (files) => {
        expect(detectErrorHandling(files)).toEqual([]);
      },
    );
    await withParsedSamples(
      [
        {
          path: "src/a.ts",
          language: "typescript",
          source: "export function u(): Result<number> | null {\n  return null;\n}\n",
        },
      ],
      (files) => {
        expect(detectErrorHandling(files)).toEqual([]);
      },
    );
  });

  test("bare result and promise-wrapped results are recognized", async () => {
    await withParsedSamples(
      [
        {
          path: "src/a.ts",
          language: "typescript",
          source: "export function bare(): Result {\n  return null as unknown as Result;\n}\n",
        },
        {
          path: "src/b.ts",
          language: "typescript",
          source:
            "export async function wrapped(): Promise<Result<string>> {\n  return null as unknown as Promise<Result<string>>;\n}\n",
        },
        {
          path: "src/c.ts",
          language: "typescript",
          source:
            "export function either(): Either<string, number> {\n  return null as unknown as Either<string, number>;\n}\n",
        },
      ],
      (files) => {
        const candidates = detectErrorHandling(files);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.matchingFiles).toBe(3);
      },
    );
  });

  test("tie emits nothing and output is order-invariant", async () => {
    const fixtures = [
      { path: "src/a.ts", language: "typescript" as const, source: RESULT_MODULE("secret-a") },
      { path: "src/b.ts", language: "typescript" as const, source: THROW_MODULE("secret-b") },
    ];
    await withParsedSamples(fixtures, (files) => {
      expect(detectErrorHandling(files)).toEqual([]);
    });
    const named = [
      { path: "src/b.ts", language: "typescript" as const, source: RESULT_MODULE("m-b") },
      { path: "src/a.ts", language: "typescript" as const, source: RESULT_MODULE("m-a") },
    ];
    const forward = await withParsedSamples(named, (files) => detectErrorHandling(files));
    const backward = await withParsedSamples([...named].reverse(), (files) => detectErrorHandling(files));
    expect(backward).toEqual(forward);
    expect(JSON.stringify(forward)).not.toContain("secret");
  });

  test("javascript throw signals classify without annotations", async () => {
    await withParsedSamples(
      [
        {
          path: "src/a.js",
          language: "javascript",
          source: 'export function fail(x) {\n  if (!x) throw new Error("bad");\n  return x;\n}\n',
        },
      ],
      (files) => {
        const candidates = detectErrorHandling(files);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.pattern).toBe("The repository predominantly uses throw-style error handling.");
      },
    );
  });
});
