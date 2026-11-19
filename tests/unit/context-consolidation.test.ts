import { describe, expect, test } from "bun:test";
import { getAdapter } from "../../src/context/language.ts";
import { parseSource } from "../../src/context/parser.ts";
import type { Definition } from "../../src/context/language.ts";
import type { SupportedLanguage } from "../../src/context/runtime.ts";
import { matchLocalCall, targetIdentity } from "../../src/context/calls.ts";
import type { Definition as CallDef } from "../../src/context/language.ts";
import {
  callerReason,
  findTargetDeclaration,
  snippetAround,
} from "../../src/context/callers.ts";
import {
  candidatePaths,
  importReason,
  isRelativeSpecifier,
  pickTarget,
  resolveRelativePath,
} from "../../src/context/imports.ts";
import type { TreeEntry } from "../../src/context/snapshot.ts";
import { SnapshotReader, parseGrepZ } from "../../src/context/snapshot.ts";
import { mapFileSymbols, selectAnchorLine } from "../../src/context/symbols.ts";
import type { ChangedFile } from "../../src/types/diff.ts";

function blobEntry(path: string, mode = "100644"): TreeEntry {
  return { mode, type: "blob", oid: "a".repeat(40), path };
}

async function definitionsFor(source: string, language: SupportedLanguage = "typescript"): Promise<Definition[]> {
  const result = await parseSource({ source, language, filePath: "src/unit.ts", perFileMs: 5000 });
  try {
    if (result.tree === null) throw new Error("expected a tree");
    return getAdapter(language).extractDefinitions(result.tree, result.source);
  } finally {
    result.tree?.delete();
  }
}

function fileWith(hunks: ChangedFile["hunks"], commentableLines: number[]): ChangedFile {
  return {
    path: "src/unit.ts",
    oldPath: null,
    status: "modified",
    language: "typescript",
    hunks,
    commentableLines,
    symbols: [],
  };
}

function dummyReader(): SnapshotReader {
  return new SnapshotReader({ repoRoot: ".", headSha: "a".repeat(40), mergeBase: "b".repeat(40) });
}

describe("import specifier edge cases", () => {
  test("dot and dot-dot count as relative", () => {
    expect(isRelativeSpecifier(".")).toBe(true);
    expect(isRelativeSpecifier("..")).toBe(true);
  });

  test("nul bytes never resolve inside the repo", () => {
    expect(resolveRelativePath("src/app.ts", "./a\0b")).toBeNull();
    expect(resolveRelativePath("src/app.ts", "../\0")).toBeNull();
  });

  test("side-effect and default re-export labels", () => {
    expect(importReason("side-effect", false)).toBe("relative side-effect import");
    expect(importReason("default", true)).toBe("relative default re-export");
  });

  test("found target wins over an earlier non-source candidate", () => {
    const index = new Map([
      ["src/util", blobEntry("src/util", "120000")],
      ["src/util.ts", blobEntry("src/util.ts")],
    ]);
    expect(pickTarget(["src/util", "src/util.ts"], index)).toEqual({ status: "found", path: "src/util.ts" });
  });
});

describe("symbol mapping fallbacks", () => {
  test("cancelled head parse falls back to module", async () => {
    const defs = await definitionsFor("export function f(): number {\n  return 1;\n}\n");
    const file = fileWith(
      [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 3,
          lines: [{ kind: "add", oldLine: null, newLine: 2, position: 1, text: "  return 1;" }],
        },
      ],
      [2],
    );
    const symbols = mapFileSymbols({
      file,
      headDefinitions: defs,
      headLineCount: 3,
      baseDefinitions: [],
      headCancelled: true,
    });
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: "<module>", kind: "module", changedLines: [2] });
  });

  test("string-only line creates no declaration symbol", async () => {
    const head = 'const s = "function fake() {}";\nfunction real(): void {}\n';
    const defs = await definitionsFor(head);
    expect(defs.map((d) => d.name)).toEqual(["real"]);
    const file = fileWith(
      [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          lines: [
            { kind: "add", oldLine: null, newLine: 1, position: 1, text: 'const s = "function fake() {}";' },
            { kind: "ctx", oldLine: 1, newLine: 2, position: 2, text: "function real(): void {}" },
          ],
        },
      ],
      [1],
    );
    const symbols = mapFileSymbols({ file, headDefinitions: defs, headLineCount: 2, baseDefinitions: [] });
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: "<module>", kind: "module", changedLines: [1] });
  });

  test("anchor selection without deletions stays undefined", () => {
    const file = fileWith(
      [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          lines: [
            { kind: "ctx", oldLine: 1, newLine: 1, position: 1, text: "a" },
            { kind: "ctx", oldLine: 2, newLine: 2, position: 2, text: "b" },
          ],
        },
      ],
      [1, 2],
    );
    expect(selectAnchorLine(file, [], 1, 2)).toBeUndefined();
  });
});

describe("call matching edge cases", () => {
  test("super outside a class scope is ambiguous", () => {
    const match = matchLocalCall(
      {
        callee: "super.m()",
        root: "super",
        member: "m",
        isNew: false,
        containing: null,
        range: { startLine: 1, endLine: 1, startIndex: 0, endIndex: 9 },
      },
      [],
      { name: "<module>", kind: "module" },
    );
    expect(match.status).toBe("ambiguous");
  });

  test("target identity separates paths and stays stable", () => {
    const target = (path: string): CallDef => ({
      name: "f",
      kind: "function",
      declarationRange: { startLine: 1, endLine: 1, startIndex: 0, endIndex: 10 },
      fullRange: { startLine: 1, endLine: 2, startIndex: 0, endIndex: 20 },
      signatureText: "f()",
      fullText: "f() {}",
      exported: true,
      exportKind: "named",
      identityKey: "function::f",
    });
    expect(targetIdentity("src/a.ts", target("src/a.ts"))).toBe(targetIdentity("src/a.ts", target("src/a.ts")));
    expect(targetIdentity("src/a.ts", target("src/a.ts"))).not.toBe(targetIdentity("src/b.ts", target("src/b.ts")));
  });
});

describe("caller helper edge cases", () => {
  test("default import through a barrel keeps the default label", () => {
    expect(callerReason({ kind: "default", modulePath: "src/b.ts", viaBarrel: true, alias: false })).toBe(
      "default import call",
    );
  });

  test("zero and negative context clamp to the call lines", () => {
    const source = ["one", "two", "three"].join("\n");
    expect(snippetAround(source, 2, 2, 0)).toMatchObject({ startLine: 2, endLine: 2, text: "two" });
    expect(snippetAround(source, 2, 2, -5)).toMatchObject({ startLine: 2, endLine: 2, text: "two" });
  });

  test("type symbol without type entries resolves to null", () => {
    expect(
      findTargetDeclaration([], [], { name: "Opts", kind: "type", startLine: 1, endLine: 3, changedLines: [2] }),
    ).toBeNull();
  });
});

describe("snapshot input validation", () => {
  test("empty grep pattern is rejected without spawning git", async () => {
    await expect(dummyReader().grepHead("")).rejects.toMatchObject({ code: "INTERNAL" });
  });

  test("non-positive grep maxCount is rejected without spawning git", async () => {
    await expect(dummyReader().grepHead("helper", { maxCount: 0 })).rejects.toMatchObject({ code: "INTERNAL" });
  });

  test("malformed blob oid is rejected without spawning git", async () => {
    await expect(dummyReader().readBlobText("short")).rejects.toMatchObject({ code: "INTERNAL" });
  });

  test("empty grep output parses to no matches", () => {
    expect(parseGrepZ(new Uint8Array(0), "abc:")).toEqual([]);
  });
});

describe("test file scoring", () => {
  test("spec suffix and test dirs outrank plain sources", () => {
    const adapter = getAdapter("typescript");
    expect(adapter.getTestFileScore("src/util.spec.js")).toBe(1);
    expect(adapter.getTestFileScore("tests/util.ts")).toBe(0.6);
    expect(adapter.getTestFileScore("src/util.ts")).toBe(0);
  });
});
