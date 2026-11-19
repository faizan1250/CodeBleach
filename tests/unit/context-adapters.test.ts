import { describe, expect, test } from "bun:test";
import type { Node, Tree } from "web-tree-sitter";
import { getAdapter, supportedLanguages } from "../../src/context/language.ts";
import { parseSource } from "../../src/context/parser.ts";
import type { SupportedLanguage } from "../../src/context/runtime.ts";

async function withTree<T>(
  source: string,
  fn: (tree: Tree, normalized: string) => T,
  language: SupportedLanguage = "typescript",
): Promise<T> {
  const result = await parseSource({ source, language, filePath: "src/unit.ts", perFileMs: 5000 });
  try {
    if (result.tree === null) throw new Error("expected a tree");
    expect(result.errorCount).toBe(0);
    return fn(result.tree, result.source);
  } finally {
    result.tree?.delete();
  }
}

function findAll(root: Node, type: string): Node[] {
  const out: Node[] = [];
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    if (node.type === type) out.push(node);
    for (let index = node.namedChildCount - 1; index >= 0; index -= 1) {
      const child = node.namedChild(index);
      if (child !== null) stack.push(child);
    }
  }
  return out;
}

describe("adapter registry", () => {
  test("exposes one adapter per supported language", () => {
    expect([...supportedLanguages].sort()).toEqual(["javascript", "tsx", "typescript"]);
    for (const language of supportedLanguages) {
      const adapter = getAdapter(language);
      expect(adapter.language).toBe(language);
      expect(getAdapter(language)).toBe(adapter);
    }
  });

  test("declares extensions and grammar ids", () => {
    expect(getAdapter("typescript").extensions).toContain(".ts");
    expect(getAdapter("typescript").grammarId).toBe("tree-sitter-typescript");
    expect(getAdapter("tsx").extensions).toEqual([".tsx"]);
    expect(getAdapter("tsx").grammarId).toBe("tree-sitter-tsx");
    expect(getAdapter("javascript").extensions).toContain(".js");
    expect(getAdapter("javascript").grammarId).toBe("tree-sitter-javascript");
  });
});

describe("extract definitions", () => {
  test("top-level functions keep exact names and ranges", async () => {
    await withTree(
      "export function greet(name: string): string {\n  return name;\n}\nfunction hidden(): void {}\n",
      (tree, source) => {
        const defs = getAdapter("typescript").extractDefinitions(tree, source);
        expect(defs.map((d) => d.name)).toEqual(["greet", "hidden"]);
        const greet = defs[0];
        if (greet === undefined) throw new Error("missing greet");
        expect(greet.kind).toBe("function");
        expect(greet.container).toBeUndefined();
        expect(greet.exported).toBe(true);
        expect(greet.exportKind).toBe("named");
        expect(greet.fullRange).toMatchObject({ startLine: 1, endLine: 3 });
        expect(greet.declarationRange).toMatchObject({ startLine: 1, endLine: 1 });
        expect(greet.signatureText).toContain("greet(name: string)");
        expect(greet.fullText).toContain("return name;");
        const hidden = defs[1];
        if (hidden === undefined) throw new Error("missing hidden");
        expect(hidden.exported).toBe(false);
        expect(hidden.exportKind).toBe("none");
        expect(hidden.fullRange).toMatchObject({ startLine: 4, endLine: 4 });
      },
    );
  });

  test("default exports use default export kind", async () => {
    await withTree(
      "export default function main(): void {}\nexport function named(): void {}\n",
      (tree, source) => {
        const defs = getAdapter("typescript").extractDefinitions(tree, source);
        expect(defs.map((d) => [d.name, d.exportKind])).toEqual([
          ["main", "default"],
          ["named", "named"],
        ]);
      },
    );
  });

  test("anonymous default function falls back to default name", async () => {
    await withTree("export default function (): void {}\n", (tree, source) => {
      const defs = getAdapter("typescript").extractDefinitions(tree, source);
      expect(defs).toHaveLength(1);
      expect(defs[0]?.name).toBe("default");
      expect(defs[0]?.exportKind).toBe("default");
    });
  });

  test("classes expose methods with class container", async () => {
    await withTree(
      "export abstract class Animal {\n  constructor(private name: string) {}\n  async sound(): Promise<void> {}\n  get legs(): number { return 4; }\n}\n",
      (tree, source) => {
        const defs = getAdapter("typescript").extractDefinitions(tree, source);
        expect(defs.map((d) => [d.name, d.kind, d.container ?? null])).toEqual([
          ["Animal", "class", null],
          ["constructor", "method", "Animal"],
          ["sound", "method", "Animal"],
          ["legs", "method", "Animal"],
        ]);
        expect(defs[0]?.exported).toBe(true);
        expect(defs[1]?.fullRange).toMatchObject({ startLine: 2, endLine: 2 });
      },
    );
  });

  test("nested functions record container chains", async () => {
    await withTree(
      "function outer(): void {\n  function inner(): number {\n    return 1;\n  }\n  const arrow = (): void => {\n    function deep(): void {}\n  };\n}\n",
      (tree, source) => {
        const defs = getAdapter("typescript").extractDefinitions(tree, source);
        expect(defs.map((d) => [d.name, d.container ?? null])).toEqual([
          ["outer", null],
          ["inner", "outer"],
          ["arrow", "outer"],
          ["deep", "outer.arrow"],
        ]);
      },
    );
  });

  test("variable-assigned functions skip plain and destructured values", async () => {
    await withTree(
      "export const arrow = async (x: number): Promise<number> => x;\nconst plain = 42;\nconst { a, b } = source;\nvar fn = function named(): void {};\n",
      (tree, source) => {
        const defs = getAdapter("typescript").extractDefinitions(tree, source);
        expect(defs.map((d) => [d.name, d.kind])).toEqual([
          ["arrow", "function"],
          ["fn", "function"],
        ]);
        expect(defs[0]?.exported).toBe(true);
      },
    );
  });

  test("object methods use the holding variable as container", async () => {
    await withTree(
      "const api = {\n  fetch(id: string): string {\n    return id;\n  },\n  version: 1,\n};\n",
      (tree, source) => {
        const defs = getAdapter("typescript").extractDefinitions(tree, source);
        expect(defs.map((d) => [d.name, d.kind, d.container ?? null])).toEqual([
          ["fetch", "method", "api"],
        ]);
        expect(defs[0]?.fullRange).toMatchObject({ startLine: 2, endLine: 4 });
      },
    );
  });

  test("interfaces aliases and enums are type definitions", async () => {
    await withTree(
      "export interface User {\n  id: string;\n}\nexport type Alias = string | number;\nenum Color { Red }\n",
      (tree, source) => {
        const defs = getAdapter("typescript").extractDefinitions(tree, source);
        expect(defs.map((d) => [d.name, d.kind, d.exported])).toEqual([
          ["User", "type", true],
          ["Alias", "type", true],
          ["Color", "type", false],
        ]);
        expect(defs[0]?.fullRange).toMatchObject({ startLine: 1, endLine: 3 });
      },
    );
  });

  test("overload signatures and ambient declarations are skipped", async () => {
    await withTree(
      "function f(a: string): void;\nfunction f(a: number): void {}\ndeclare function g(): void;\n",
      (tree, source) => {
        const defs = getAdapter("typescript").extractDefinitions(tree, source);
        expect(defs).toHaveLength(1);
        expect(defs[0]?.name).toBe("f");
        expect(defs[0]?.fullRange).toMatchObject({ startLine: 2, endLine: 2 });
      },
    );
  });

  test("namespace members record the namespace container", async () => {
    await withTree('namespace N {\n  export function g(): void {}\n}\n', (tree, source) => {
      const defs = getAdapter("typescript").extractDefinitions(tree, source);
      expect(defs.map((d) => [d.name, d.container ?? null])).toEqual([["g", "N"]]);
    });
  });

  test("comments and strings create no definitions", async () => {
    await withTree(
      '// function fake(): void {}\nconst text = "function alsoFake() {}";\n/* class Nope {} */\nfunction real(): void {}\n',
      (tree, source) => {
        const defs = getAdapter("typescript").extractDefinitions(tree, source);
        expect(defs.map((d) => d.name)).toEqual(["real"]);
      },
    );
  });

  test("duplicate names get stable occurrence keys", async () => {
    const source = "function dup(): void {}\nfunction dup(): void {}\n";
    const first = await withTree(source, (tree, normalized) =>
      getAdapter("typescript").extractDefinitions(tree, normalized),
    );
    const second = await withTree(source, (tree, normalized) =>
      getAdapter("typescript").extractDefinitions(tree, normalized),
    );
    expect(first.map((d) => d.identityKey)).toEqual(["function::dup", "function::dup#2"]);
    expect(second.map((d) => d.identityKey)).toEqual(first.map((d) => d.identityKey));
  });
});

describe("extract imports", () => {
  test("covers all relative import forms", async () => {
    await withTree(
      'import def from "./mod";\nimport { original as local, other } from "./other";\nimport * as ns from "./ns";\nimport "./side-effect";\nimport type { T } from "./types";\nimport { type Inline, value } from "./inline";\n',
      (tree, source) => {
        const imports = getAdapter("typescript").extractImports(tree, source);
        expect(imports).toEqual([
          { sourceSpecifier: "./mod", kind: "default", localName: "def", importedName: "default", range: { startLine: 1, endLine: 1 } },
          { sourceSpecifier: "./other", kind: "named", localName: "local", importedName: "original", range: { startLine: 2, endLine: 2 } },
          { sourceSpecifier: "./other", kind: "named", localName: "other", importedName: "other", range: { startLine: 2, endLine: 2 } },
          { sourceSpecifier: "./ns", kind: "namespace", localName: "ns", importedName: null, range: { startLine: 3, endLine: 3 } },
          { sourceSpecifier: "./side-effect", kind: "side-effect", localName: null, importedName: null, range: { startLine: 4, endLine: 4 } },
          { sourceSpecifier: "./types", kind: "type-only", localName: "T", importedName: "T", range: { startLine: 5, endLine: 5 } },
          { sourceSpecifier: "./inline", kind: "type-only", localName: "Inline", importedName: "Inline", range: { startLine: 6, endLine: 6 } },
          { sourceSpecifier: "./inline", kind: "named", localName: "value", importedName: "value", range: { startLine: 6, endLine: 6 } },
        ]);
      },
    );
  });
});

describe("extract exports", () => {
  test("covers local default and re-export forms", async () => {
    await withTree(
      'const local = 1;\nexport { local };\nexport { local as renamed };\nexport { a } from "./m";\nexport * from "./star";\nexport * as ns from "./ns";\nexport default 42;\n',
      (tree, source) => {
        const exports = getAdapter("typescript").extractExports(tree, source);
        expect(exports).toEqual([
          { exportedName: "local", localName: "local", sourceSpecifier: null, kind: "named", range: { startLine: 2, endLine: 2 } },
          { exportedName: "renamed", localName: "local", sourceSpecifier: null, kind: "named", range: { startLine: 3, endLine: 3 } },
          { exportedName: "a", localName: "a", sourceSpecifier: "./m", kind: "named", range: { startLine: 4, endLine: 4 } },
          { exportedName: null, localName: null, sourceSpecifier: "./star", kind: "star", range: { startLine: 5, endLine: 5 } },
          { exportedName: "ns", localName: null, sourceSpecifier: "./ns", kind: "namespace", range: { startLine: 6, endLine: 6 } },
          { exportedName: "default", localName: null, sourceSpecifier: null, kind: "default", range: { startLine: 7, endLine: 7 } },
        ]);
      },
    );
  });
});

describe("extract calls", () => {
  test("finds direct member and constructor calls with innermost container", async () => {
    await withTree(
      'import { helper } from "./h";\nfunction caller(): void {\n  helper(1);\n  api.fetch("x");\n  new Client();\n  const nested = (): void => {\n    helper(2);\n  };\n}\n// helper(3);\nconst s = "helper(4)";\n',
      (tree, source) => {
        const callers = findAll(tree.rootNode, "function_declaration");
        expect(callers).toHaveLength(1);
        const calls = getAdapter("typescript").extractCalls(callers[0] as Node, source);
        expect(calls.map((c) => [c.callee, c.root, c.member, c.isNew, c.containing])).toEqual([
          ["helper(1)", "helper", null, false, "caller"],
          ['api.fetch("x")', "api", "fetch", false, "caller"],
          ["new Client()", "Client", null, true, "caller"],
          ["helper(2)", "helper", null, false, "nested"],
        ]);
        expect(calls[0]?.range).toMatchObject({ startLine: 3, endLine: 3 });
      },
    );
  });

  test("chained calls stay conservative with null root", async () => {
    await withTree("function f(): void { foo()(); }\n", (tree, source) => {
      const callers = findAll(tree.rootNode, "function_declaration");
      const calls = getAdapter("typescript").extractCalls(callers[0] as Node, source);
      expect(calls.map((c) => [c.root, c.member])).toEqual([
        [null, null],
        ["foo", null],
      ]);
    });
  });
});

describe("extract types", () => {
  test("maps type declarations with exported flags", async () => {
    await withTree(
      "export interface User {\n  id: string;\n}\nexport type Alias = string | number;\nenum Color { Red }\n",
      (tree, source) => {
        const types = getAdapter("typescript").extractTypes(tree, source);
        expect(types.map((t) => [t.name, t.typeKind, t.exported])).toEqual([
          ["User", "interface", true],
          ["Alias", "type-alias", true],
          ["Color", "enum", false],
        ]);
        expect(types[0]?.range).toMatchObject({ startLine: 1, endLine: 3 });
        expect(types[0]?.text).toContain("interface User");
      },
    );
  });
});

describe("extract call sites", () => {
  test("matches direct member and alias names with caller attribution", async () => {
    await withTree(
      'import { target } from "./t";\nimport { target as alias } from "./t2";\nfunction a(): void { target(); }\nfunction b(): void { alias(); }\nfunction c(): void { obj.target(); }\ntarget();\n',
      (tree, source) => {
        const sites = getAdapter("typescript").extractCallSites(tree, source, {
          name: "target",
          aliases: ["alias"],
        });
        expect(sites.map((s) => [s.caller, s.callee])).toEqual([
          ["a", "target()"],
          ["b", "alias()"],
          ["c", "obj.target()"],
          [null, "target()"],
        ]);
      },
    );
  });
});

describe("test file score and symbol names", () => {  test("ranks test paths above source paths", () => {
    const adapter = getAdapter("typescript");
    expect(adapter.getTestFileScore("src/greet.test.ts")).toBe(1);
    expect(adapter.getTestFileScore("src/greet.spec.tsx")).toBe(1);
    expect(adapter.getTestFileScore("__tests__/greet.ts")).toBeGreaterThan(0);
    expect(adapter.getTestFileScore("src/test-helper.ts")).toBeGreaterThan(0);
    expect(adapter.getTestFileScore("src/greet.ts")).toBe(0);
    expect(adapter.getTestFileScore("src/greet.test.ts")).toBeGreaterThan(
      adapter.getTestFileScore("__tests__/greet.ts"),
    );
  });

  test("returns declared names or null", async () => {
    await withTree(
      "function named(): void {}\nconst v = 1;\nconst { d } = source;\n",
      (tree, source) => {
        const adapter = getAdapter("typescript");
        const fn = findAll(tree.rootNode, "function_declaration")[0];
        expect(fn && adapter.getSymbolName(fn, source)).toBe("named");
        const declarators = findAll(tree.rootNode, "variable_declarator");
        expect(declarators).toHaveLength(2);
        expect(adapter.getSymbolName(declarators[0] as Node, source)).toBe("v");
        expect(adapter.getSymbolName(declarators[1] as Node, source)).toBeNull();
        const params = findAll(tree.rootNode, "formal_parameters");
        expect(params.length).toBeGreaterThan(0);
        expect(adapter.getSymbolName(params[0] as Node, source)).toBeNull();
        expect(adapter.getSymbolName(tree.rootNode, source)).toBeNull();
      },
    );
  });
});

describe("tsx adapter", () => {
  test("parses components and hooks without jsx interference", async () => {
    await withTree(
      'import { useState } from "react";\nexport function Card({ title }: { title: string }): unknown {\n  const [open, setOpen] = useState(false);\n  return <div className="card">{title}</div>;\n}\n',
      (tree, source) => {
        const adapter = getAdapter("tsx");
        const defs = adapter.extractDefinitions(tree, source);
        expect(defs.map((d) => [d.name, d.kind])).toEqual([["Card", "function"]]);
        const cards = findAll(tree.rootNode, "function_declaration");
        const calls = adapter.extractCalls(cards[0] as Node, source);
        expect(calls.map((c) => c.root)).toEqual(["useState"]);
      },
      "tsx",
    );
  });
});

describe("javascript adapter", () => {
  test("mirrors function class and arrow extraction", async () => {
    await withTree(
      'function f(a) { return a; }\nclass C { m() { helper(); } }\nconst arrow = (x) => x;\nconst { b } = require("./b");\nmodule.exports = { f };\n',
      (tree, source) => {
        const adapter = getAdapter("javascript");
        const defs = adapter.extractDefinitions(tree, source);
        expect(defs.map((d) => [d.name, d.kind, d.container ?? null])).toEqual([
          ["f", "function", null],
          ["C", "class", null],
          ["m", "method", "C"],
          ["arrow", "function", null],
        ]);
        const methods = findAll(tree.rootNode, "method_definition");
        const calls = adapter.extractCalls(methods[0] as Node, source);
        expect(calls.map((c) => c.callee)).toEqual(["helper()"]);
        const roots = adapter.extractCalls(tree.rootNode, source).map((c) => c.root);
        expect(roots).toContain("require");
      },
      "javascript",
    );
  });
});

describe("adapter edge cases", () => {
  test("emoji before declarations keeps names and ranges", async () => {
    await withTree(
      "// hello 👋 world\n// café naïve résumé\nfunction target(): number { return 1; }\n",
      (tree, source) => {
        const defs = getAdapter("typescript").extractDefinitions(tree, source);
        expect(defs).toHaveLength(1);
        expect(defs[0]?.name).toBe("target");
        expect(defs[0]?.fullRange).toMatchObject({ startLine: 3, endLine: 3 });
        expect(defs[0]?.fullText).toBe("function target(): number { return 1; }");
        expect(
          source.slice(defs[0]?.fullRange.startIndex ?? 0, defs[0]?.fullRange.endIndex ?? 0),
        ).toBe("function target(): number { return 1; }");
      },
    );
  });

  test("crlf sources keep 1-based line mapping", async () => {
    await withTree("function a(): void {}\r\nfunction b(): void {}\r\n", (tree, source) => {
      const defs = getAdapter("typescript").extractDefinitions(tree, source);
      expect(defs.map((d) => [d.name, d.fullRange.startLine])).toEqual([
        ["a", 1],
        ["b", 2],
      ]);
    });
  });

  test("method modifiers do not affect names", async () => {
    await withTree(
      "class C {\n  static create(): C { return new C(); }\n  private reset(): void {}\n  get value(): number { return 1; }\n  set value(v: number) {}\n}\n",
      (tree, source) => {
        const defs = getAdapter("typescript").extractDefinitions(tree, source);
        expect(defs.map((d) => [d.name, d.kind, d.container ?? null])).toEqual([
          ["C", "class", null],
          ["create", "method", "C"],
          ["reset", "method", "C"],
          ["value", "method", "C"],
          ["value", "method", "C"],
        ]);
        expect(defs[3]?.identityKey).toBe("method:C:value");
        expect(defs[4]?.identityKey).toBe("method:C:value#2");
      },
    );
  });

  test("generators are functions", async () => {
    await withTree("function* gen(): Generator<number> { yield 1; }\n", (tree, source) => {
      const defs = getAdapter("typescript").extractDefinitions(tree, source);
      expect(defs.map((d) => [d.name, d.kind])).toEqual([["gen", "function"]]);
    });
  });

  test("class expressions use the variable name", async () => {
    await withTree("const C = class { m(): void {} };\n", (tree, source) => {
      const defs = getAdapter("typescript").extractDefinitions(tree, source);
      expect(defs.map((d) => [d.name, d.kind, d.container ?? null])).toEqual([
        ["C", "class", null],
        ["m", "method", "C"],
      ]);
    });
  });

  test("export assignment maps to the default export", async () => {
    await withTree("function foo(): void {}\nexport = foo;\n", (tree, source) => {
      const exports = getAdapter("typescript").extractExports(tree, source);
      expect(exports).toEqual([
        { exportedName: "default", localName: "foo", sourceSpecifier: null, kind: "default", range: { startLine: 2, endLine: 2 } },
      ]);
    });
  });

  test("default-exported classes keep their methods", async () => {
    await withTree("export default class Store { load(): void {} }\n", (tree, source) => {
      const defs = getAdapter("typescript").extractDefinitions(tree, source);
      expect(defs.map((d) => [d.name, d.kind, d.exportKind, d.container ?? null])).toEqual([
        ["Store", "class", "default", null],
        ["load", "method", "none", "Store"],
      ]);
    });
  });

  test("string-named methods keep raw text", async () => {
    await withTree('class C { "quoted"(): void {} }\n', (tree, source) => {
      const defs = getAdapter("typescript").extractDefinitions(tree, source);
      expect(defs.map((d) => d.name)).toEqual(["C", '"quoted"']);
    });
  });

  test("super this and optional chains decompose", async () => {
    await withTree(
      "class D extends B {\n  m(): void {\n    super.m();\n    this.n();\n    fetch(1);\n  }\n}\n",
      (tree, source) => {
        const methods = findAll(tree.rootNode, "method_definition");
        const calls = getAdapter("typescript").extractCalls(methods[0] as Node, source);
        expect(calls.map((c) => [c.root, c.member, c.containing])).toEqual([
          ["super", "m", "m"],
          ["this", "n", "m"],
          ["fetch", null, "m"],
        ]);
      },
    );
  });
});
