import { describe, expect, test } from "bun:test";
import type { Node } from "web-tree-sitter";
import {
  dedupeCalleeTargets,
  findDefinitionNode,
  matchLocalCall,
  resolveExportedMember,
  sortCalleeTargets,
} from "../../src/context/calls.ts";
import type {
  CalleeTarget,
  LoadedModule,
  MemberResolutionContext,
} from "../../src/context/calls.ts";
import { getAdapter } from "../../src/context/language.ts";
import type { CallReference, Definition, ExportReference, TypeDefinition } from "../../src/context/language.ts";
import { parseSource } from "../../src/context/parser.ts";
import type { SupportedLanguage } from "../../src/context/runtime.ts";

function def(
  name: string,
  kind: Definition["kind"] = "function",
  container?: string,
  startLine = 1,
): Definition {
  return {
    name,
    kind,
    ...(container === undefined ? {} : { container }),
    declarationRange: { startLine, endLine: startLine, startIndex: 0, endIndex: 10 },
    fullRange: { startLine, endLine: startLine + 2, startIndex: 0, endIndex: 30 },
    signatureText: `${name}()`,
    fullText: `${name}() {}`,
    exported: true,
    exportKind: "named",
    identityKey: `${kind}:${container ?? ""}:${name}`,
  };
}

function callRef(
  root: string | null,
  member: string | null = null,
  extra: Partial<CallReference> = {},
): CallReference {
  return {
    callee: `${root ?? "expr"}()`,
    root,
    member,
    isNew: false,
    containing: "run",
    range: { startLine: 1, endLine: 1, startIndex: 0, endIndex: 5 },
    ...extra,
  };
}

function target(
  name: string,
  path: string,
  startLine = 1,
  extra: Partial<CalleeTarget> = {},
): CalleeTarget {
  return {
    name,
    kind: "function",
    path,
    startLine,
    endLine: startLine + 2,
    signatureText: `${name}()`,
    text: `${name}() {}`,
    recursive: false,
    reason: "local direct call",
    callRange: { startLine: 1, endLine: 1, startIndex: 0, endIndex: 5 },
    ...extra,
  };
}

describe("call extraction normalization", () => {
  test("ignores string and comment mentions", async () => {
    const source = 'const label = "parseUser()";\n// fetchData();\n/* syncAll(); */\n';
    const parsed = await parseSource({ source, language: "typescript", filePath: "src/unit.ts", perFileMs: 5000 });
    try {
      if (parsed.tree === null) throw new Error("expected a tree");
      expect(getAdapter("typescript").extractCalls(parsed.tree.rootNode, parsed.source)).toEqual([]);
    } finally {
      parsed.tree?.delete();
    }
  });

  test("normalizes direct, member, constructor, and nested calls in order", async () => {
    const source =
      "export function helper(): void {}\n" +
      "export function run(): void {\n" +
      "  parseUser();\n" +
      "  client.fetch();\n" +
      "  new Client();\n" +
      "  const nested = () => {\n" +
      "    helper();\n" +
      "  };\n" +
      "  nested();\n" +
      "}\n";
    const parsed = await parseSource({ source, language: "typescript", filePath: "src/unit.ts", perFileMs: 5000 });
    try {
      if (parsed.tree === null) throw new Error("expected a tree");
      const adapter = getAdapter("typescript");
      const run = adapter.extractDefinitions(parsed.tree, parsed.source).find((entry) => entry.name === "run");
      if (run === undefined) throw new Error("expected a run definition");
      const node = findDefinitionNode(parsed.tree.rootNode, run);
      if (node === null) throw new Error("expected a run node");
      const calls = adapter.extractCalls(node, parsed.source);
      expect(calls.map((entry) => entry.root)).toEqual(["parseUser", "client", "Client", "helper", "nested"]);
      expect(calls.map((entry) => entry.member)).toEqual([null, "fetch", null, null, null]);
      expect(calls.map((entry) => entry.isNew)).toEqual([false, false, true, false, false]);
      expect(calls.map((entry) => entry.containing)).toEqual(["run", "run", "run", "nested", "run"]);
    } finally {
      parsed.tree?.delete();
    }
  });

  test("flags computed callees with a null root", async () => {
    const source = "export function run(): void {\n  getFn()();\n}\n";
    const parsed = await parseSource({ source, language: "typescript", filePath: "src/unit.ts", perFileMs: 5000 });
    try {
      if (parsed.tree === null) throw new Error("expected a tree");
      const calls = getAdapter("typescript").extractCalls(parsed.tree.rootNode, parsed.source);
      expect(calls.some((entry) => entry.root === null)).toBe(true);
    } finally {
      parsed.tree?.delete();
    }
  });
});

describe("findDefinitionNode", () => {
  test("locates the declaration by exact index span", async () => {
    const source = "export function a(): void {}\nexport function b(): void {}\n";
    const parsed = await parseSource({ source, language: "typescript", filePath: "src/unit.ts", perFileMs: 5000 });
    try {
      if (parsed.tree === null) throw new Error("expected a tree");
      const definitions = getAdapter("typescript").extractDefinitions(parsed.tree, parsed.source);
      const b = definitions.find((entry) => entry.name === "b");
      if (b === undefined) throw new Error("expected a b definition");
      const node: Node | null = findDefinitionNode(parsed.tree.rootNode, b);
      expect(node?.text).toBe("function b(): void {}");
    } finally {
      parsed.tree?.delete();
    }
  });

  test("returns null when no node matches the span", async () => {
    const source = "export function a(): void {}\n";
    const parsed = await parseSource({ source, language: "typescript", filePath: "src/unit.ts", perFileMs: 5000 });
    try {
      if (parsed.tree === null) throw new Error("expected a tree");
      const phantom = def("ghost", "function", undefined, 99);
      expect(findDefinitionNode(parsed.tree.rootNode, phantom)).toBeNull();
    } finally {
      parsed.tree?.delete();
    }
  });
});

describe("matchLocalCall", () => {
  test("matches direct calls to same-name local definitions", () => {
    const match = matchLocalCall(callRef("helper"), [def("helper"), def("other")], {
      name: "run",
      kind: "function",
    });
    expect(match).toEqual({ status: "found", definitions: [def("helper")] });
  });

  test("defers unknown direct names to import resolution", () => {
    const match = matchLocalCall(callRef("missing"), [def("helper")], { name: "run", kind: "function" });
    expect(match).toEqual({ status: "defer" });
  });

  test("ignores method definitions for bare calls", () => {
    const match = matchLocalCall(callRef("helper"), [def("helper", "method", "Service")], {
      name: "run",
      kind: "function",
    });
    expect(match).toEqual({ status: "defer" });
  });

  test("prefers non-method definitions for bare calls with same-name methods", () => {
    const fn = def("helper", "function", undefined, 1);
    const match = matchLocalCall(callRef("helper"), [def("helper", "method", "Service"), fn], {
      name: "run",
      kind: "function",
    });
    expect(match).toEqual({ status: "found", definitions: [fn] });
  });

  test("maps this-calls to container methods", () => {
    const match = matchLocalCall(callRef("this", "helper"), [def("helper", "method", "Service")], {
      name: "run",
      kind: "method",
      container: "Service",
    });
    expect(match.status).toBe("found");
  });

  test("rejects this-calls outside a class scope as ambiguous", () => {
    const match = matchLocalCall(callRef("this", "helper"), [def("helper", "method", "Service")], {
      name: "run",
      kind: "function",
    });
    expect(match).toEqual({ status: "ambiguous" });
  });

  test("reports missing container methods as unresolved", () => {
    const match = matchLocalCall(callRef("this", "gone"), [def("helper", "method", "Service")], {
      name: "run",
      kind: "method",
      container: "Service",
    });
    expect(match).toEqual({ status: "unresolved" });
  });

  test("maps class-qualified calls to static methods", () => {
    const match = matchLocalCall(callRef("Config", "load"), [def("load", "method", "Config")], {
      name: "run",
      kind: "function",
    });
    expect(match.status).toBe("found");
  });

  test("defers unmapped member calls for namespace handling", () => {
    const match = matchLocalCall(callRef("client", "fetch"), [def("helper")], {
      name: "run",
      kind: "function",
    });
    expect(match).toEqual({ status: "defer" });
  });

  test("marks computed callees as dynamic", () => {
    const match = matchLocalCall(callRef(null), [def("helper")], { name: "run", kind: "function" });
    expect(match).toEqual({ status: "dynamic" });
  });
});

describe("dedupeCalleeTargets", () => {
  test("keeps the first call site per target identity", () => {
    const first = target("helper", "src/a.ts");
    const second = target("helper", "src/a.ts", 1, {
      callRange: { startLine: 9, endLine: 9, startIndex: 90, endIndex: 99 },
    });
    expect(dedupeCalleeTargets([first, second])).toEqual([first]);
  });

  test("collapses overloads sharing path, kind, container, and name", () => {
    const first = target("helper", "src/a.ts", 1);
    const overload = target("helper", "src/a.ts", 5);
    expect(dedupeCalleeTargets([first, overload])).toEqual([first]);
  });

  test("keeps same-name targets from different files", () => {
    const local = target("helper", "src/a.ts");
    const remote = target("helper", "src/b.ts");
    expect(dedupeCalleeTargets([local, remote])).toEqual([local, remote]);
  });
});

describe("sortCalleeTargets", () => {
  test("orders local-first, then path, start line, and name", () => {
    const remote = target("zebra", "src/z.ts", 3);
    const localB = target("b", "src/a.ts", 9);
    const localA = target("a", "src/a.ts", 1);
    expect(sortCalleeTargets([remote, localB, localA], "src/a.ts")).toEqual([localA, localB, remote]);
  });
});

function exportRef(
  exportedName: string | null,
  localName: string | null,
  sourceSpecifier: string | null,
  kind: ExportReference["kind"],
): ExportReference {
  return { exportedName, localName, sourceSpecifier, kind, range: { startLine: 1, endLine: 1 } };
}

function moduleOf(
  path: string,
  definitions: Definition[] = [],
  types: TypeDefinition[] = [],
  reExports: ExportReference[] = [],
  localExports: Array<[string, string]> = [],
): LoadedModule {
  return { path, definitions, types, localExports: new Map(localExports), reExports };
}

function stubContext(
  modules: Record<string, LoadedModule>,
  probes: Record<string, string> = {},
  cancelled: readonly string[] = [],
): MemberResolutionContext {
  return {
    load: async (path) => {
      if (cancelled.includes(path)) return "cancelled";
      return modules[path] ?? null;
    },
    probe: async (base) => probes[base] ?? null,
  };
}

describe("resolveExportedMember", () => {
  test("resolves directly exported members", async () => {
    const context = stubContext({ "src/utils.ts": moduleOf("src/utils.ts", [def("normalize")]) });
    const outcome = await resolveExportedMember("src/utils.ts", "normalize", context);
    expect(outcome).toMatchObject({ status: "found", targetPath: "src/utils.ts", reexported: false });
  });

  test("follows named re-export hops", async () => {
    const context = stubContext(
      {
        "src/barrel.ts": moduleOf("src/barrel.ts", [], [], [exportRef("normalize", "normalize", "./real", "named")]),
        "src/real.ts": moduleOf("src/real.ts", [def("normalize")]),
      },
      { "src/real": "src/real.ts" },
    );
    const outcome = await resolveExportedMember("src/barrel.ts", "normalize", context);
    expect(outcome).toMatchObject({ status: "found", targetPath: "src/real.ts", reexported: true });
  });

  test("resolves unambiguous star re-exports", async () => {
    const context = stubContext(
      {
        "src/barrel.ts": moduleOf("src/barrel.ts", [], [], [exportRef(null, null, "./real", "star")]),
        "src/real.ts": moduleOf("src/real.ts", [def("normalize")]),
      },
      { "src/real": "src/real.ts" },
    );
    const outcome = await resolveExportedMember("src/barrel.ts", "normalize", context);
    expect(outcome).toMatchObject({ status: "found", targetPath: "src/real.ts" });
  });

  test("reports ambiguous star re-exports without guessing", async () => {
    const context = stubContext(
      {
        "src/barrel.ts": moduleOf("src/barrel.ts", [], [], [
          exportRef(null, null, "./left", "star"),
          exportRef(null, null, "./right", "star"),
        ]),
        "src/left.ts": moduleOf("src/left.ts", [def("clash")]),
        "src/right.ts": moduleOf("src/right.ts", [def("clash")]),
      },
      { "src/left": "src/left.ts", "src/right": "src/right.ts" },
    );
    const outcome = await resolveExportedMember("src/barrel.ts", "clash", context);
    expect(outcome).toEqual({ status: "ambiguous" });
  });

  test("reports missing members and terminates cycles", async () => {
    const context = stubContext(
      {
        "src/a.ts": moduleOf("src/a.ts", [], [], [exportRef("x", "x", "./b", "named")]),
        "src/b.ts": moduleOf("src/b.ts", [], [], [exportRef("x", "x", "./a", "named")]),
      },
      { "src/a": "src/a.ts", "src/b": "src/b.ts" },
    );
    expect(await resolveExportedMember("src/a.ts", "absent", context)).toEqual({ status: "missing" });
    expect(await resolveExportedMember("src/a.ts", "x", context)).toEqual({ status: "missing" });
  });

  test("stops re-export chains past the depth limit", async () => {
    const modules: Record<string, LoadedModule> = {};
    const probes: Record<string, string> = {};
    const links = 10;
    for (let index = 0; index <= links; index += 1) {
      const path = `src/l${index}.ts`;
      probes[`src/l${index}`] = path;
    }
    for (let index = 0; index < links; index += 1) {
      modules[`src/l${index}.ts`] = moduleOf(`src/l${index}.ts`, [], [], [
        exportRef("x", "x", `./l${index + 1}`, "named"),
      ]);
    }
    modules[`src/l${links}.ts`] = moduleOf(`src/l${links}.ts`, [def("x")]);
    const context = stubContext(modules, probes);
    expect(await resolveExportedMember("src/l0.ts", "x", context)).toEqual({ status: "depth-exceeded" });
  });

  test("propagates parse cancellation", async () => {
    const context = stubContext({}, {}, ["src/big.ts"]);
    expect(await resolveExportedMember("src/big.ts", "x", context)).toEqual({ status: "cancelled" });
  });
});
