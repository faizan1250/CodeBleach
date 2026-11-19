import { describe, expect, test } from "bun:test";
import { ReviewerError } from "../../src/core/errors.ts";
import { RunBudget } from "../../src/context/limits.ts";
import { parseSource } from "../../src/context/parser.ts";
import {
  createParser,
  loadLanguage,
  loadLanguageFromBytes,
  queryMatches,
  runtimeDiagnostics,
} from "../../src/context/runtime.ts";
import type { SupportedLanguage } from "../../src/context/runtime.ts";

const LANGUAGES: readonly SupportedLanguage[] = ["typescript", "tsx", "javascript"];

const SAMPLES: Record<SupportedLanguage, { source: string; needle: string }> = {
  typescript: {
    source: "export function greet(name: string): string { return `hi ${name}`; }",
    needle: "function_declaration",
  },
  tsx: {
    source: "export function App(): unknown { return <div>hi</div>; }",
    needle: "jsx_element",
  },
  javascript: {
    source: "function add(a, b) { return a + b; }",
    needle: "function_declaration",
  },
};

describe("parser runtime", () => {
  test("each grammar loads and parses a known sample", async () => {
    for (const language of LANGUAGES) {
      const loaded = await loadLanguage(language);
      expect(loaded.abiVersion).toBeGreaterThanOrEqual(13);
      expect(loaded.abiVersion).toBeLessThanOrEqual(15);
      const parser = createParser(loaded);
      try {
        const sample = SAMPLES[language] as { source: string; needle: string };
        const tree = parser.parse(sample.source);
        if (tree === null) throw new Error(`${language} sample parse returned null`);
        try {
          expect(tree.rootNode.type).toBe("program");
          expect(tree.rootNode.hasError).toBe(false);
          expect(tree.rootNode.toString()).toContain(sample.needle);
        } finally {
          tree.delete();
        }
      } finally {
        parser.delete();
      }
    }
  });

  test("repeated loads reuse the cached language", async () => {
    const first = await loadLanguage("typescript");
    const second = await loadLanguage("typescript");
    expect(second).toBe(first);
  });

  test("initialization is reported once and lists loaded languages", async () => {
    await loadLanguage("javascript");
    const diagnostics = runtimeDiagnostics();
    expect(diagnostics.initialized).toBe(true);
    expect(diagnostics.loadedLanguages).toContain("typescript");
    expect(diagnostics.loadedLanguages).toContain("javascript");
  });

  test("corrupt grammar bytes fail as PARSE_FAILED", async () => {
    const error = await loadLanguageFromBytes(new Uint8Array([0, 1, 2, 3]), "corrupt").catch(
      (unknown: unknown) => unknown,
    );
    expect(error).toBeInstanceOf(ReviewerError);
    expect((error as ReviewerError).code).toBe("PARSE_FAILED");
  });

  test("query timeout halts a slow query without throwing", async () => {
    const language = await loadLanguage("typescript");
    const parser = createParser(language);
    try {
      const tree = parser.parse("export function f0(): number { return 0; }\n".repeat(20000));
      if (tree === null) throw new Error("expected a tree for the timeout fixture");
      try {
        const full = queryMatches(language, "(function_declaration) @fn", tree.rootNode, {
          timeoutMicros: 30_000_000,
        });
        expect(full.length).toBe(20000);
        const halted = queryMatches(language, "(function_declaration) @fn", tree.rootNode, {
          timeoutMicros: 1,
        });
        expect(halted.length).toBeLessThan(full.length);
      } finally {
        tree.delete();
      }
    } finally {
      parser.delete();
    }
  });

  test("concurrent parses do not share mutable parser state", async () => {
    const budget = new RunBudget({ maxRunMs: 120000, maxTotalParseMs: 30000 });
    const results = await Promise.all(
      LANGUAGES.map((language) => {
        const sample = SAMPLES[language] as { source: string; needle: string };
        return parseSource({
          source: sample.source,
          language,
          filePath: `src/sample-${language}.ts`,
          perFileMs: 2000,
          runBudget: budget,
        });
      }),
    );
    for (const [index, result] of results.entries()) {
      const language = LANGUAGES[index] as SupportedLanguage;
      const sample = SAMPLES[language] as { source: string; needle: string };
      expect(result.cancelled).toBe(false);
      if (result.tree === null) throw new Error(`expected a tree for ${language}`);
      try {
        expect(result.tree.rootNode.type).toBe("program");
        expect(result.tree.rootNode.toString()).toContain(sample.needle);
      } finally {
        result.tree.delete();
      }
    }
  });
});
