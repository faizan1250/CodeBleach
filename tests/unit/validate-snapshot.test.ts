import { describe, expect, test } from "bun:test";
import { ReviewerError } from "../../src/core/errors.ts";
import type { TreeEntry } from "../../src/context/snapshot.ts";
import {
  DEFAULT_VALIDATION_SNAPSHOT_MAX_ENTRIES,
  GitValidationSnapshotReader,
  validateSnapshotPath,
} from "../../src/validate/snapshot.ts";
import type { ValidationSnapshotSource } from "../../src/validate/snapshot.ts";

const HEAD = "c".repeat(40);
const BASE = "d".repeat(40);
const OTHER = "e".repeat(40);
const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);

function blobEntry(oid: string, path: string): TreeEntry {
  return { mode: "100644", type: "blob", oid, path };
}

function timeoutError(): ReviewerError {
  return new ReviewerError({
    code: "GIT_FAILED",
    message: 'command "git" timed out after 30000ms',
    cause: { reason: "timeout" },
  });
}

function exitError(): ReviewerError {
  return new ReviewerError({
    code: "GIT_FAILED",
    message: 'command "git" exited with code 128',
    cause: { reason: "exit", exitCode: 128 },
  });
}

/** Scripted inner source: no git, every access recorded. */
class ScriptSource implements ValidationSnapshotSource {
  readonly headSha = HEAD;
  readonly mergeBase = BASE;
  headFiles = new Map<string, TreeEntry>();
  baseFiles = new Map<string, TreeEntry>();
  blobs = new Map<string, string | ReviewerError>();
  indexReads: ("head" | "base")[] = [];
  blobReads: string[] = [];
  indexError: ReviewerError | null = null;
  gitCalls = 0;

  async listHeadFiles(): Promise<Map<string, TreeEntry>> {
    this.gitCalls += 1;
    this.indexReads.push("head");
    if (this.indexError !== null) throw this.indexError;
    return new Map(this.headFiles);
  }

  async listBaseFiles(): Promise<Map<string, TreeEntry>> {
    this.gitCalls += 1;
    this.indexReads.push("base");
    if (this.indexError !== null) throw this.indexError;
    return new Map(this.baseFiles);
  }

  async readBlobText(oid: string): Promise<string> {
    this.gitCalls += 1;
    this.blobReads.push(oid.toLowerCase());
    const hit = this.blobs.get(oid.toLowerCase());
    if (hit === undefined) {
      throw new ReviewerError({ code: "GIT_FAILED", message: `blob ${oid.toLowerCase()} is missing` });
    }
    if (hit instanceof ReviewerError) throw hit;
    return hit;
  }

  stats(): { gitCalls: number } {
    return { gitCalls: this.gitCalls };
  }
}

function readerFor(
  source: ScriptSource,
  overrides?: {
    maxFileBytes?: number | undefined;
    maxTotalBytes?: number | undefined;
    maxEntries?: number | undefined;
  },
): GitValidationSnapshotReader {
  return new GitValidationSnapshotReader({
    repoDir: "/repo",
    headSha: HEAD,
    mergeBase: BASE,
    ...(overrides ?? {}),
    source,
  });
}

function sourceWithFile(path: string, text: string, oid: string = OID_A): ScriptSource {
  const source = new ScriptSource();
  source.headFiles.set(path, blobEntry(oid, path));
  source.blobs.set(oid, text);
  return source;
}

describe("validateSnapshotPath", () => {
  test("accepts a clean repo-relative path", () => {
    expect(validateSnapshotPath("src/a.ts")).toEqual({ ok: true, path: "src/a.ts" });
  });

  test("canonicalizes dot and duplicate separators", () => {
    expect(validateSnapshotPath("./src//a.ts")).toEqual({ ok: true, path: "src/a.ts" });
  });

  test.each(["", "   ", "/abs.ts", "C:/win.ts", "../up.ts", "a/../../b.ts", "nul\0byte.ts", "ctrl\x01.ts"])(
    "rejects unsafe path %j",
    (path) => {
      const result = validateSnapshotPath(path);
      expect(result.ok).toBe(false);
    },
  );
});

describe("validation snapshot reader construction", () => {
  test("rejects an empty repoDir without touching git", () => {
    const source = new ScriptSource();
    expect(() => new GitValidationSnapshotReader({ repoDir: "", headSha: HEAD, mergeBase: BASE, source })).toThrow(
      expect.any(ReviewerError) as unknown as Error,
    );
    expect(source.gitCalls).toBe(0);
  });

  test("rejects a malformed head SHA without touching git", () => {
    const source = new ScriptSource();
    expect(
      () => new GitValidationSnapshotReader({ repoDir: "/repo", headSha: "short", mergeBase: BASE, source }),
    ).toThrow(expect.any(ReviewerError) as unknown as Error);
    expect(source.gitCalls).toBe(0);
  });

  test("exposes the pinned SHAs", () => {
    const reader = readerFor(new ScriptSource());
    expect(reader.headSha).toBe(HEAD);
    expect(reader.mergeBase).toBe(BASE);
  });
});

describe("path and SHA policy", () => {
  test("invalid paths never reach the source", async () => {
    const source = sourceWithFile("src/a.ts", "ok\n");
    const reader = readerFor(source);
    for (const bad of ["", "/abs.ts", "../up.ts", "nul\0x.ts"]) {
      const result = await reader.readHead(bad);
      expect(result.status).toBe("invalid_path");
    }
    expect(source.gitCalls).toBe(0);
  });

  test("unallowed commit SHA is sha_mismatch without source calls", async () => {
    const source = sourceWithFile("src/a.ts", "ok\n");
    const reader = readerFor(source);
    const result = await reader.readAt(OTHER, "src/a.ts");
    expect(result.status).toBe("sha_mismatch");
    expect(source.gitCalls).toBe(0);
  });

  test("SHA comparison is case-insensitive", async () => {
    const source = sourceWithFile("src/a.ts", "ok\n");
    const reader = readerFor(source);
    const result = await reader.readAt(HEAD.toUpperCase(), "src/a.ts");
    expect(result.status).toBe("ok");
  });

  test("malformed commit SHA throws instead of returning a status", async () => {
    const source = sourceWithFile("src/a.ts", "ok\n");
    const reader = readerFor(source);
    await expect(reader.readAt("short", "src/a.ts")).rejects.toThrow(ReviewerError);
    expect(source.gitCalls).toBe(0);
  });

  test("aborted signal returns aborted without source calls", async () => {
    const source = sourceWithFile("src/a.ts", "ok\n");
    const reader = readerFor(source);
    const controller = new AbortController();
    controller.abort();
    const result = await reader.readHead("src/a.ts", { signal: controller.signal });
    expect(result.status).toBe("aborted");
    expect(source.gitCalls).toBe(0);
  });

  test("missing path is not_found", async () => {
    const source = new ScriptSource();
    const reader = readerFor(source);
    const result = await reader.readHead("src/gone.ts");
    expect(result.status).toBe("not_found");
    expect(source.blobReads).toHaveLength(0);
  });

  test("symlink and gitlink entries are unsupported, never read as text", async () => {
    const source = new ScriptSource();
    source.headFiles.set("link.ts", { mode: "120000", type: "blob", oid: OID_A, path: "link.ts" });
    source.headFiles.set("vendor/dep", { mode: "160000", type: "commit", oid: OID_B, path: "vendor/dep" });
    const reader = readerFor(source);
    expect((await reader.readHead("link.ts")).status).toBe("unsupported");
    expect((await reader.readHead("vendor/dep")).status).toBe("unsupported");
    expect(source.blobReads).toHaveLength(0);
  });
});

describe("reads and per-run cache", () => {
  test("ok read returns text with byte length", async () => {
    const source = sourceWithFile("src/a.ts", "const v = 1;\n");
    const reader = readerFor(source);
    const result = await reader.readHead("src/a.ts");
    expect(result).toEqual({ status: "ok", text: "const v = 1;\n", bytes: 13 });
  });

  test("cache key includes the commit SHA, not just the path", async () => {
    const source = new ScriptSource();
    source.headFiles.set("src/a.ts", blobEntry(OID_A, "src/a.ts"));
    source.baseFiles.set("src/a.ts", blobEntry(OID_A, "src/a.ts"));
    source.blobs.set(OID_A, "same\n");
    const reader = readerFor(source);
    expect((await reader.readHead("src/a.ts")).status).toBe("ok");
    expect((await reader.readBase("src/a.ts")).status).toBe("ok");
    expect(source.blobReads).toEqual([OID_A, OID_A]);
    expect((await reader.readHead("src/a.ts")).status).toBe("ok");
    expect((await reader.readBase("src/a.ts")).status).toBe("ok");
    expect(source.blobReads).toHaveLength(2);
    expect(reader.stats()).toMatchObject({ reads: 4, cacheHits: 2, entries: 2 });
  });

  test("binary content is binary, never ok, and never cached", async () => {
    const source = sourceWithFile("src/bin.dat", "ab\0cd");
    const reader = readerFor(source);
    expect((await reader.readHead("src/bin.dat")).status).toBe("binary");
    expect((await reader.readHead("src/bin.dat")).status).toBe("binary");
    expect(source.blobReads).toHaveLength(2);
    expect(reader.stats().entries).toBe(0);
  });

  test("per-read maxBytes cap returns size_limit without caching", async () => {
    const source = sourceWithFile("src/a.ts", "0123456789");
    const reader = readerFor(source);
    const result = await reader.readHead("src/a.ts", { maxBytes: 3 });
    expect(result.status).toBe("size_limit");
    expect(reader.stats().entries).toBe(0);
  });

  test("run total-bytes cap stops further caching", async () => {
    const source = new ScriptSource();
    source.headFiles.set("src/one.ts", blobEntry(OID_A, "src/one.ts"));
    source.headFiles.set("src/two.ts", blobEntry(OID_B, "src/two.ts"));
    source.blobs.set(OID_A, "aaa");
    source.blobs.set(OID_B, "bbb");
    const reader = readerFor(source, { maxTotalBytes: 5 });
    expect((await reader.readHead("src/one.ts")).status).toBe("ok");
    expect((await reader.readHead("src/two.ts")).status).toBe("size_limit");
    expect(reader.stats()).toMatchObject({ entries: 1, cachedBytes: 3 });
  });

  test("entry cap keeps serving reads without storing beyond the bound", async () => {
    const source = new ScriptSource();
    source.headFiles.set("src/a.ts", blobEntry(OID_A, "src/a.ts"));
    source.headFiles.set("src/b.ts", blobEntry(OID_B, "src/b.ts"));
    source.blobs.set(OID_A, "a");
    source.blobs.set(OID_B, "b");
    const reader = readerFor(source, { maxEntries: 1 });
    expect((await reader.readHead("src/a.ts")).status).toBe("ok");
    expect((await reader.readHead("src/b.ts")).status).toBe("ok");
    expect(reader.stats().entries).toBe(1);
    expect(DEFAULT_VALIDATION_SNAPSHOT_MAX_ENTRIES).toBeGreaterThan(1);
  });

  test("clear releases cached text", async () => {
    const source = sourceWithFile("src/a.ts", "ok\n");
    const reader = readerFor(source);
    expect((await reader.readHead("src/a.ts")).status).toBe("ok");
    expect(reader.stats().entries).toBe(1);
    reader.clear();
    expect(reader.stats()).toMatchObject({ entries: 0, cachedBytes: 0 });
    expect((await reader.readHead("src/a.ts")).status).toBe("ok");
    expect(source.blobReads).toHaveLength(2);
  });
});

describe("failure mapping", () => {
  test("blob timeout is a timeout outcome, not a throw", async () => {
    const source = new ScriptSource();
    source.headFiles.set("src/a.ts", blobEntry(OID_A, "src/a.ts"));
    source.blobs.set(OID_A, timeoutError());
    const reader = readerFor(source);
    const result = await reader.readHead("src/a.ts");
    expect(result.status).toBe("timeout");
  });

  test("index timeout is a timeout outcome, not a throw", async () => {
    const source = new ScriptSource();
    source.indexError = timeoutError();
    const reader = readerFor(source);
    const result = await reader.readHead("src/a.ts");
    expect(result.status).toBe("timeout");
  });

  test("missing blob behind a present index entry is not_found", async () => {
    const source = new ScriptSource();
    source.headFiles.set("src/a.ts", blobEntry(OID_A, "src/a.ts"));
    const reader = readerFor(source);
    const result = await reader.readHead("src/a.ts");
    expect(result.status).toBe("not_found");
  });

  test("unknown git failure propagates instead of becoming a status", async () => {
    const source = new ScriptSource();
    source.headFiles.set("src/a.ts", blobEntry(OID_A, "src/a.ts"));
    source.blobs.set(OID_A, exitError());
    const reader = readerFor(source);
    await expect(reader.readHead("src/a.ts")).rejects.toThrow(ReviewerError);
  });

  test("index corruption propagates instead of becoming a status", async () => {
    const source = new ScriptSource();
    source.indexError = exitError();
    const reader = readerFor(source);
    await expect(reader.readHead("src/a.ts")).rejects.toThrow(ReviewerError);
  });
});
