import { Language, Parser } from "web-tree-sitter";
import runtimeWasmPath from "web-tree-sitter/tree-sitter.wasm" with { type: "file" };
import typescriptWasmPath from "@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm" with {
  type: "file",
};
import tsxWasmPath from "@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm" with { type: "file" };
import javascriptWasmPath from "@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm" with {
  type: "file",
};

export interface SpikeGrammarResult {
  language: "typescript" | "tsx" | "javascript";
  abiVersion: number;
  rootType: string;
  hasError: boolean;
  sexpr: string;
}

export interface SpikeResult {
  languageVersion: number;
  minCompatibleVersion: number;
  grammars: SpikeGrammarResult[];
}

const SAMPLES = [
  {
    language: "typescript",
    wasmPath: typescriptWasmPath,
    source: 'export function greet(name: string): string { return "hi " + name; }',
    needle: "function_declaration",
  },
  {
    language: "tsx",
    wasmPath: tsxWasmPath,
    source: "export function App(): JSX.Element { return <div>hi</div>; }",
    needle: "jsx_element",
  },
  {
    language: "javascript",
    wasmPath: javascriptWasmPath,
    source: "function add(a, b) { return a + b; }",
    needle: "function_declaration",
  },
] as const;

export async function runTreeSitterSpike(): Promise<SpikeResult> {
  const runtimeBytes = new Uint8Array(await Bun.file(runtimeWasmPath).bytes());
  await Parser.init({ wasmBinary: runtimeBytes.buffer as ArrayBuffer });
  const { LANGUAGE_VERSION, MIN_COMPATIBLE_VERSION } = await import("web-tree-sitter");
  if (typeof LANGUAGE_VERSION !== "number" || typeof MIN_COMPATIBLE_VERSION !== "number") {
    throw new Error("tree-sitter runtime version constants unavailable after init");
  }

  const grammars: SpikeGrammarResult[] = [];
  for (const sample of SAMPLES) {
    const wasmBytes = await Bun.file(sample.wasmPath).bytes();
    const language = await Language.load(wasmBytes);
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(sample.source);
    if (tree === null) {
      throw new Error(`${sample.language} parse returned null`);
    }
    const sexpr = tree.rootNode.toString();
    if (!sexpr.includes(sample.needle)) {
      throw new Error(`${sample.language} missing expected node ${sample.needle}`);
    }
    grammars.push({
      language: sample.language,
      abiVersion: language.abiVersion,
      rootType: tree.rootNode.type,
      hasError: tree.rootNode.hasError,
      sexpr,
    });
    tree.delete();
    parser.delete();
  }
  return { languageVersion: LANGUAGE_VERSION, minCompatibleVersion: MIN_COMPATIBLE_VERSION, grammars };
}

if (import.meta.main) {
  const result = await runTreeSitterSpike();
  console.log(JSON.stringify({ ok: true, ...result, grammars: result.grammars.map((g) => ({ ...g, sexpr: g.sexpr.slice(0, 120) })) }));
}
