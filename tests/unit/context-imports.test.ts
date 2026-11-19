import { describe, expect, test } from "bun:test";
import {
  candidatePaths,
  importReason,
  isRelativeSpecifier,
  pickTarget,
  resolveRelativePath,
} from "../../src/context/imports.ts";
import type { TreeEntry } from "../../src/context/snapshot.ts";

function entry(path: string, mode: TreeEntry["mode"] = "100644"): TreeEntry {
  return { mode, type: "blob", oid: "a".repeat(40), path };
}

describe("isRelativeSpecifier", () => {
  test("accepts dot-slash and dot-dot-slash", () => {
    expect(isRelativeSpecifier("./module")).toBe(true);
    expect(isRelativeSpecifier("../shared/types")).toBe(true);
  });

  test("rejects bare package and absolute specifiers", () => {
    expect(isRelativeSpecifier("react")).toBe(false);
    expect(isRelativeSpecifier("@scope/pkg")).toBe(false);
    expect(isRelativeSpecifier("/abs/path")).toBe(false);
    expect(isRelativeSpecifier("")).toBe(false);
  });
});

describe("resolveRelativePath", () => {
  test("resolves sibling and parent segments", () => {
    expect(resolveRelativePath("src/app.ts", "./util")).toBe("src/util");
    expect(resolveRelativePath("src/deep/app.ts", "../shared/types")).toBe("src/shared/types");
    expect(resolveRelativePath("app.ts", "./util")).toBe("util");
  });

  test("rejects escape above the repository root", () => {
    expect(resolveRelativePath("src/app.ts", "../../evil")).toBeNull();
    expect(resolveRelativePath("app.ts", "../evil")).toBeNull();
  });

  test("normalizes the repository root to an empty base", () => {
    expect(resolveRelativePath("src/app.ts", "..")).toBe("");
    expect(resolveRelativePath("app.ts", ".")).toBe("");
  });
});

describe("candidatePaths", () => {
  test("probes exact path then extensions then index files", () => {
    expect(candidatePaths("src/util")).toEqual([
      "src/util",
      "src/util.ts",
      "src/util.tsx",
      "src/util.js",
      "src/util/index.ts",
      "src/util/index.tsx",
      "src/util/index.js",
    ]);
  });

  test("probes root index files for an empty base", () => {
    expect(candidatePaths("")).toEqual(["index.ts", "index.tsx", "index.js"]);
  });
});

describe("pickTarget", () => {
  test("picks the first regular blob candidate", () => {
    const index = new Map([["src/util.ts", entry("src/util.ts")]]);
    expect(pickTarget(candidatePaths("src/util"), index)).toEqual({ status: "found", path: "src/util.ts" });
  });

  test("prefers exact path over extension probes", () => {
    const index = new Map([
      ["src/util", entry("src/util")],
      ["src/util.ts", entry("src/util.ts")],
    ]);
    expect(pickTarget(candidatePaths("src/util"), index)).toEqual({ status: "found", path: "src/util" });
  });

  test("skips non-regular blobs and reports them", () => {
    const index = new Map([["src/link", entry("src/link", "120000")]]);
    expect(pickTarget(["src/link"], index)).toEqual({ status: "not-source", path: "src/link" });
  });

  test("reports missing candidates", () => {
    expect(pickTarget(candidatePaths("src/missing"), new Map())).toEqual({ status: "not-found" });
  });
});

describe("importReason", () => {
  test("labels kind and re-export hops", () => {
    expect(importReason("named", false)).toBe("relative named import");
    expect(importReason("named", true)).toBe("relative named re-export");
    expect(importReason("default", false)).toBe("relative default import");
    expect(importReason("namespace", false)).toBe("relative namespace import");
    expect(importReason("type-only", false)).toBe("relative type-only import");
  });
});
