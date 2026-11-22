import type { Tree } from "web-tree-sitter";
import { parseSource } from "../../../src/context/parser.ts";
import type { SupportedLanguage } from "../../../src/context/runtime.ts";
import type { ParsedSampledFile } from "../../../src/conventions/detectors/index.ts";

export interface SampleFixture {
  path: string;
  language: SupportedLanguage;
  source: string;
}

// Parses fixtures in memory (no Git, no network) and keeps every tree alive
// for the callback; trees are deleted afterwards. Detectors receive live
// trees but retain only line numbers.
export async function withParsedSamples<T>(
  fixtures: readonly SampleFixture[],
  fn: (files: ParsedSampledFile[]) => T,
): Promise<T> {
  const held: Array<{ tree: Tree; file: ParsedSampledFile }> = [];
  try {
    for (const fixture of fixtures) {
      const result = await parseSource({
        source: fixture.source,
        language: fixture.language,
        filePath: fixture.path,
        perFileMs: 5000,
      });
      if (result.tree === null) throw new Error(`parse timed out for ${fixture.path}`);
      held.push({
        tree: result.tree,
        file: {
          path: fixture.path,
          language: fixture.language,
          source: result.source,
          tree: result.tree,
        },
      });
    }
    return fn(held.map((entry) => entry.file));
  } finally {
    for (const entry of held) entry.tree.delete();
  }
}

// Deterministic sample sources with unique markers (asserted absent from output).
export const NAMED_MODULE = (marker: string): string =>
  `// ${marker}\nexport function alpha(): number {\n  return 1;\n}\nexport const beta = 2;\n`;

export const DEFAULT_MODULE = (marker: string): string =>
  `// ${marker}\nexport default function gamma(): number {\n  return 3;\n}\n`;

export const RESULT_MODULE = (marker: string): string =>
  `// ${marker}\nexport function load(): Result<string, Error> {\n  return null as unknown as Result<string, Error>;\n}\n`;

export const THROW_MODULE = (marker: string): string =>
  `// ${marker}\nexport function save(flag: boolean): void {\n  if (flag) throw new Error("bad");\n}\n`;
