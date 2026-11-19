import { describe, expect, test } from "bun:test";
import {
  callerReason,
  dedupeCallerSites,
  enclosingCaller,
  findTargetDeclaration,
  snippetAround,
  sortCallerSites,
  targetPublicNames,
} from "../../src/context/callers.ts";
import type { CallerBinding, CallerSite } from "../../src/context/callers.ts";
import { getAdapter } from "../../src/context/language.ts";
import type { CallReference, Definition, TypeDefinition } from "../../src/context/language.ts";
import { parseSource } from "../../src/context/parser.ts";
import type { ChangedSymbol } from "../../src/types/diff.ts";

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

function typeDef(name: string, startLine = 1): TypeDefinition {
  return {
    name,
    typeKind: "interface",
    range: { startLine, endLine: startLine + 2, startIndex: 0, endIndex: 30 },
    text: `interface ${name} {}`,
    exported: true,
    exportKind: "named",
  };
}

function callAt(startIndex: number, endIndex: number, extra: Partial<CallReference> = {}): CallReference {
  return {
    callee: "helper()",
    root: "helper",
    member: null,
    isNew: false,
    containing: "run",
    range: { startLine: 1, endLine: 1, startIndex, endIndex },
    ...extra,
  };
}

function site(
  path: string,
  caller: string | null,
  callerStartLine = 1,
  callStartIndex = 0,
  extra: Partial<CallerSite> = {},
): CallerSite {
  return {
    path,
    caller,
    callerKind: caller === null ? "module" : "function",
    callerStartLine,
    callerEndLine: callerStartLine + 2,
    callerText: `${caller ?? "<module>"} {}`,
    callRange: { startLine: callerStartLine, endLine: callerStartLine, startIndex: callStartIndex, endIndex: callStartIndex + 5 },
    reason: "same-file direct call",
    ...extra,
  };
}

function symbolFor(name: string, kind: ChangedSymbol["kind"], startLine: number, container?: string): ChangedSymbol {
  return {
    name,
    kind,
    startLine,
    endLine: startLine + 2,
    changedLines: [startLine],
    ...(container === undefined ? {} : { container }),
  };
}

async function partsFor(source: string): Promise<{
  definitions: Definition[];
  types: TypeDefinition[];
  localExports: Map<string, string>;
}> {
  const parsed = await parseSource({ source, language: "typescript", filePath: "src/unit.ts", perFileMs: 5000 });
  if (parsed.tree === null) throw new Error("expected a tree");
  try {
    const adapter = getAdapter("typescript");
    const localExports = new Map<string, string>();
    for (const ref of adapter.extractExports(parsed.tree, parsed.source)) {
      if (ref.sourceSpecifier === null && ref.exportedName !== null && ref.localName !== null) {
        localExports.set(ref.exportedName, ref.localName);
      }
    }
    return {
      definitions: adapter.extractDefinitions(parsed.tree, parsed.source),
      types: adapter.extractTypes(parsed.tree, parsed.source),
      localExports,
    };
  } finally {
    parsed.tree.delete();
  }
}

describe("targetPublicNames", () => {
  test("named export exposes its own name", async () => {
    const parts = await partsFor("export function greet(): string {\n  return \"hi\";\n}\n");
    const declaration = parts.definitions.find((entry) => entry.name === "greet");
    if (declaration === undefined) throw new Error("expected a greet definition");
    expect(targetPublicNames(parts.localExports, declaration)).toEqual(["greet"]);
  });

  test("default export exposes the default name", async () => {
    const parts = await partsFor("export default function helper(): number {\n  return 1;\n}\n");
    const declaration = parts.definitions.find((entry) => entry.name === "helper");
    if (declaration === undefined) throw new Error("expected a helper definition");
    expect(targetPublicNames(parts.localExports, declaration)).toEqual(["default"]);
  });

  test("aliased export exposes the public name", async () => {
    const parts = await partsFor("function helper(): number {\n  return 1;\n}\nexport { helper as util };\n");
    const declaration = parts.definitions.find((entry) => entry.name === "helper");
    if (declaration === undefined) throw new Error("expected a helper definition");
    expect(targetPublicNames(parts.localExports, declaration)).toEqual(["util"]);
  });

  test("non-exported declaration exposes nothing", async () => {
    const parts = await partsFor("function hidden(): void {}\nexport function shown(): void {}\n");
    const declaration = parts.definitions.find((entry) => entry.name === "hidden");
    if (declaration === undefined) throw new Error("expected a hidden definition");
    expect(targetPublicNames(parts.localExports, declaration)).toEqual([]);
  });
});

describe("findTargetDeclaration", () => {
  test("matches methods by container", () => {
    const found = findTargetDeclaration(
      [def("run", "method", "Service", 5), def("run", "function", undefined, 1)],
      [],
      symbolFor("run", "method", 5, "Service"),
    );
    expect(found).toMatchObject({ kind: "method", name: "run", container: "Service" });
  });

  test("disambiguates overloads by start line", () => {
    const first = def("run", "function", undefined, 1);
    const second = def("run", "function", undefined, 9);
    expect(findTargetDeclaration([first, second], [], symbolFor("run", "function", 9))).toBe(second);
  });

  test("finds type declarations by name", () => {
    const found = findTargetDeclaration([], [typeDef("Options")], symbolFor("Options", "type", 1));
    expect(found).toMatchObject({ name: "Options" });
  });

  test("returns null for module symbols and misses", () => {
    expect(findTargetDeclaration([def("run")], [], symbolFor("run", "module", 1))).toBeNull();
    expect(findTargetDeclaration([def("run")], [], symbolFor("gone", "function", 1))).toBeNull();
  });
});

describe("enclosingCaller", () => {
  test("picks the most specific containing definition", () => {
    const outer = { ...def("outer", "function", undefined, 1), fullRange: { startLine: 1, endLine: 10, startIndex: 0, endIndex: 200 } };
    const inner = { ...def("inner", "function", "outer", 3), fullRange: { startLine: 3, endLine: 6, startIndex: 50, endIndex: 120 } };
    expect(enclosingCaller([outer, inner], callAt(60, 70))).toBe(inner);
  });

  test("returns null outside every definition", () => {
    expect(enclosingCaller([def("run", "function", undefined, 5)], callAt(500, 510))).toBeNull();
  });
});

describe("callerReason", () => {
  const binding = (extra: Partial<CallerBinding>): CallerBinding => ({
    kind: "named",
    modulePath: "src/a.ts",
    viaBarrel: false,
    alias: false,
    ...extra,
  });

  test("labels same-file and direct imports", () => {
    expect(callerReason(null)).toBe("same-file direct call");
    expect(callerReason(binding({}))).toBe("named import call");
    expect(callerReason(binding({ alias: true }))).toBe("named import alias call");
    expect(callerReason(binding({ kind: "default" }))).toBe("default import call");
    expect(callerReason(binding({ kind: "namespace" }))).toBe("namespace import call");
  });

  test("labels barrel re-exports", () => {
    expect(callerReason(binding({ viaBarrel: true }))).toBe("barrel re-export call");
    expect(callerReason(binding({ viaBarrel: true, alias: true }))).toBe("barrel re-export alias call");
    expect(callerReason(binding({ kind: "namespace", viaBarrel: true }))).toBe("barrel namespace call");
  });
});

describe("dedupeCallerSites", () => {
  test("collapses repeat calls from one caller keeping the first", () => {
    const first = site("src/a.ts", "run", 4, 10);
    const second = site("src/a.ts", "run", 4, 60);
    expect(dedupeCallerSites([first, second])).toEqual([first]);
  });

  test("keeps distinct callers and module-scope callers once per file", () => {
    const sites = [
      site("src/a.ts", "run", 4, 10),
      site("src/a.ts", "drive", 9, 20),
      site("src/a.ts", null, 1, 5),
      site("src/a.ts", null, 20, 90),
    ];
    const deduped = dedupeCallerSites(sites);
    expect(deduped).toHaveLength(3);
    expect(deduped.map((entry) => entry.caller)).toEqual(["run", "drive", null]);
  });
});

describe("sortCallerSites", () => {
  test("orders by path, caller line, and caller name", () => {
    const remote = site("src/z.ts", "zebra", 3);
    const second = site("src/a.ts", "b", 9);
    const first = site("src/a.ts", "a", 1);
    expect(sortCallerSites([remote, second, first]).map((entry) => entry.caller)).toEqual(["a", "b", "zebra"]);
  });
});

describe("snippetAround", () => {
  test("includes bounded context and clamps to file edges", () => {
    const source = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    const middle = snippetAround(source, 15, 15, 2);
    expect(middle).toMatchObject({ startLine: 13, endLine: 17 });
    expect(middle.text.split("\n")).toHaveLength(5);
    const start = snippetAround(source, 1, 1, 10);
    expect(start.startLine).toBe(1);
    expect(start.text.split("\n")[0]).toBe("line 1");
  });
});
