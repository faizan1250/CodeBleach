import { describe, expect, test } from "bun:test";
import { ReviewerError } from "../../src/core/errors.ts";
import type { TreeEntry } from "../../src/context/snapshot.ts";
import { isGitAbort, isGitTimeout } from "../../src/context/snapshot.ts";
import { runProcess } from "../../src/utils/spawn.ts";
import {
  DEFAULT_VALIDATION_SNAPSHOT_MAX_ENTRIES,
  FakeValidationSnapshotReader,
  GitValidationSnapshotReader,
  validateSnapshotPath,
} from "../../src/validate/snapshot.ts";
import type { ValidationSnapshotSource, ValidationSourceReadOptions } from "../../src/validate/snapshot.ts";

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
    cause: { reason: "timeout", timeoutMs: 30000 },
  });
}

function abortError(): ReviewerError {
  return new ReviewerError({
    code: "GIT_FAILED",
    message: 'command "git" was aborted',
    cause: { reason: "abort" },
  });
}

function perFileLimitError(oid: string = OID_A): ReviewerError {
  return new ReviewerError({
    code: "GIT_FAILED",
    message: `blob ${oid.toLowerCase()} is 999 bytes, above the 10-byte per-blob snapshot cap`,
    cause: { kind: "per-file-limit", oid: oid.toLowerCase(), sizeBytes: 999, limitBytes: 10 },
  });
}

function cumulativeLimitError(oid: string = OID_A): ReviewerError {
  return new ReviewerError({
    code: "GIT_FAILED",
    message: "snapshot total 12 bytes would exceed the 10-byte run cap",
    cause: { kind: "cumulative-limit", oid: oid.toLowerCase(), sizeBytes: 12, limitBytes: 10 },
  });
}

function untypedCapError(): ReviewerError {
  return new ReviewerError({ code: "GIT_FAILED", message: "snapshot blob hit the legacy per-file cap" });
}

function untypedMissingError(oid: string = OID_A): ReviewerError {
  return new ReviewerError({ code: "GIT_FAILED", message: `blob ${oid.toLowerCase()} is missing` });
}

function untypedTimeoutError(): ReviewerError {
  return new ReviewerError({ code: "GIT_FAILED", message: 'command "git" timed out after 30000ms' });
}

function malformedIndexError(): ReviewerError {
  return new ReviewerError({ code: "PARSE_FAILED", message: "ls-tree record has no metadata/path tab separator" });
}

function protocolBlobError(oid: string = OID_A): ReviewerError {
  return new ReviewerError({ code: "GIT_FAILED", message: `unexpected batch header for "${oid.toLowerCase()}"` });
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
  /** Every signal the reader forwarded, in call order. */
  receivedSignals: (AbortSignal | undefined)[] = [];
  /** When true, the read waits for the forwarded signal to abort, then fails as aborted. */
  hangIndex = false;
  hangBlob = false;

  async listHeadFiles(options?: ValidationSourceReadOptions | undefined): Promise<Map<string, TreeEntry>> {
    this.gitCalls += 1;
    this.indexReads.push("head");
    this.receivedSignals.push(options?.signal);
    await this.gate("index", options?.signal);
    if (this.indexError !== null) throw this.indexError;
    return new Map(this.headFiles);
  }

  async listBaseFiles(options?: ValidationSourceReadOptions | undefined): Promise<Map<string, TreeEntry>> {
    this.gitCalls += 1;
    this.indexReads.push("base");
    this.receivedSignals.push(options?.signal);
    await this.gate("index", options?.signal);
    if (this.indexError !== null) throw this.indexError;
    return new Map(this.baseFiles);
  }

  async readBlobText(oid: string, options?: ValidationSourceReadOptions | undefined): Promise<string> {
    this.gitCalls += 1;
    this.blobReads.push(oid.toLowerCase());
    this.receivedSignals.push(options?.signal);
    await this.gate("blob", options?.signal);
    const hit = this.blobs.get(oid.toLowerCase());
    if (hit === undefined) {
      throw new ReviewerError({
        code: "GIT_FAILED",
        message: `blob ${oid.toLowerCase()} is missing`,
        cause: { kind: "missing", oid: oid.toLowerCase() },
      });
    }
    if (hit instanceof ReviewerError) throw hit;
    return hit;
  }

  private async gate(kind: "index" | "blob", signal: AbortSignal | undefined): Promise<void> {
    const hanging = kind === "index" ? this.hangIndex : this.hangBlob;
    if (!hanging) return;
    if (signal === undefined) throw new Error(`ScriptSource ${kind} hang requires a forwarded signal`);
    if (signal.aborted) throw abortError();
    await new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
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

  test("forwards the same signal to index and blob source reads", async () => {
    const source = sourceWithFile("src/a.ts", "ok\n");
    const reader = readerFor(source);
    const controller = new AbortController();
    const result = await reader.readHead("src/a.ts", { signal: controller.signal });
    expect(result.status).toBe("ok");
    expect(source.receivedSignals).toHaveLength(2);
    expect(source.receivedSignals[0]).toBe(controller.signal);
    expect(source.receivedSignals[1]).toBe(controller.signal);
  });

  test("forwards the same signal to base-side reads", async () => {
    const source = new ScriptSource();
    source.baseFiles.set("src/a.ts", blobEntry(OID_A, "src/a.ts"));
    source.blobs.set(OID_A, "ok\n");
    const reader = readerFor(source);
    const controller = new AbortController();
    const result = await reader.readBase("src/a.ts", { signal: controller.signal });
    expect(result.status).toBe("ok");
    expect(source.receivedSignals).toHaveLength(2);
    expect(source.receivedSignals[0]).toBe(controller.signal);
    expect(source.receivedSignals[1]).toBe(controller.signal);
  });

  test("abort during the index read is an aborted outcome", async () => {
    const source = sourceWithFile("src/a.ts", "ok\n");
    source.hangIndex = true;
    const reader = readerFor(source);
    const controller = new AbortController();
    const pending = reader.readHead("src/a.ts", { signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.status).toBe("aborted");
    expect(source.blobReads).toHaveLength(0);
  });

  test("abort during the blob read is an aborted outcome", async () => {
    const source = sourceWithFile("src/a.ts", "ok\n");
    source.hangBlob = true;
    const reader = readerFor(source);
    const controller = new AbortController();
    const pending = reader.readHead("src/a.ts", { signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.status).toBe("aborted");
  });

  test("aborted reads cache nothing, so retry after cancel succeeds", async () => {
    const source = sourceWithFile("src/a.ts", "ok\n");
    source.hangBlob = true;
    const reader = readerFor(source);
    const controller = new AbortController();
    const pending = reader.readHead("src/a.ts", { signal: controller.signal });
    controller.abort();
    expect((await pending).status).toBe("aborted");
    expect(reader.stats().entries).toBe(0);
    source.hangBlob = false;
    expect(await reader.readHead("src/a.ts")).toEqual({ status: "ok", text: "ok\n", bytes: 3 });
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

  test("real subprocess timeout is a timeout outcome", async () => {
    const failure = await runProcess({
      cmd: [process.execPath, "-e", "await new Promise((r) => setTimeout(r, 30000));"],
      timeoutMs: 200,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(failure).toBeInstanceOf(ReviewerError);
    const source = new ScriptSource();
    source.headFiles.set("src/a.ts", blobEntry(OID_A, "src/a.ts"));
    source.blobs.set(OID_A, failure as ReviewerError);
    const reader = readerFor(source);
    expect((await reader.readHead("src/a.ts")).status).toBe("timeout");
  });

  test("timeout wording without a timeout cause propagates", async () => {
    const source = new ScriptSource();
    source.headFiles.set("src/a.ts", blobEntry(OID_A, "src/a.ts"));
    source.blobs.set(OID_A, untypedTimeoutError());
    const reader = readerFor(source);
    await expect(reader.readHead("src/a.ts")).rejects.toThrow(ReviewerError);
  });

  test("blob abort is an aborted outcome, not a throw", async () => {
    const source = new ScriptSource();
    source.headFiles.set("src/a.ts", blobEntry(OID_A, "src/a.ts"));
    source.blobs.set(OID_A, abortError());
    const reader = readerFor(source);
    expect((await reader.readHead("src/a.ts")).status).toBe("aborted");
  });

  test("index abort is an aborted outcome, not a throw", async () => {
    const source = new ScriptSource();
    source.indexError = abortError();
    const reader = readerFor(source);
    expect((await reader.readHead("src/a.ts")).status).toBe("aborted");
  });

  test("abort stays distinct from timeout and output-limit causes", async () => {
    expect(isGitAbort(abortError())).toBe(true);
    expect(isGitAbort(timeoutError())).toBe(false);
    expect(isGitTimeout(abortError())).toBe(false);
    const outputLimit = new ReviewerError({
      code: "GIT_FAILED",
      message: "output cap hit",
      cause: { reason: "output-limit", stream: "stdout", limitBytes: 8, observedBytes: 16, bufferedBytes: 8 },
    });
    expect(isGitAbort(outputLimit)).toBe(false);
    expect(isGitTimeout(outputLimit)).toBe(false);
    const source = sourceWithFile("src/a.ts", "ok\n");
    const reader = readerFor(source);
    const controller = new AbortController();
    controller.abort();
    expect((await reader.readHead("src/a.ts", { signal: controller.signal })).status).toBe("aborted");
    expect((await reader.readHead("src/a.ts")).status).toBe("ok");
  });

  test("typed per-file limit is size_limit", async () => {
    const source = new ScriptSource();
    source.headFiles.set("src/a.ts", blobEntry(OID_A, "src/a.ts"));
    source.blobs.set(OID_A, perFileLimitError());
    const reader = readerFor(source);
    expect((await reader.readHead("src/a.ts")).status).toBe("size_limit");
  });

  test("typed cumulative limit is size_limit", async () => {
    const source = new ScriptSource();
    source.headFiles.set("src/a.ts", blobEntry(OID_A, "src/a.ts"));
    source.blobs.set(OID_A, cumulativeLimitError());
    const reader = readerFor(source);
    expect((await reader.readHead("src/a.ts")).status).toBe("size_limit");
  });

  test("untyped cap wording propagates instead of becoming size_limit", async () => {
    const source = new ScriptSource();
    source.headFiles.set("src/a.ts", blobEntry(OID_A, "src/a.ts"));
    source.blobs.set(OID_A, untypedCapError());
    const reader = readerFor(source);
    await expect(reader.readHead("src/a.ts")).rejects.toThrow(ReviewerError);
  });

  test("untyped is-missing wording propagates instead of becoming not_found", async () => {
    const source = new ScriptSource();
    source.headFiles.set("src/a.ts", blobEntry(OID_A, "src/a.ts"));
    source.blobs.set(OID_A, untypedMissingError());
    const reader = readerFor(source);
    await expect(reader.readHead("src/a.ts")).rejects.toThrow(ReviewerError);
  });

  test("raw output-limit propagates instead of becoming size_limit", async () => {
    const failure = await runProcess({
      cmd: [process.execPath, "-e", "const c='x'.repeat(65536);for(let i=0;i<64;i++)process.stdout.write(c);"],
      maxStdoutBytes: 1024,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(failure).toBeInstanceOf(ReviewerError);
    expect((failure as ReviewerError).cause).toEqual(expect.objectContaining({ reason: "output-limit" }));
    const source = new ScriptSource();
    source.headFiles.set("src/a.ts", blobEntry(OID_A, "src/a.ts"));
    source.blobs.set(OID_A, failure as ReviewerError);
    const reader = readerFor(source);
    await expect(reader.readHead("src/a.ts")).rejects.toThrow(ReviewerError);
  });

  test("index timeout is a timeout outcome, not a throw", async () => {
    const source = new ScriptSource();
    source.indexError = timeoutError();
    const reader = readerFor(source);
    const result = await reader.readHead("src/a.ts");
    expect(result.status).toBe("timeout");
  });

  test("typed missing blob behind a present index entry is not_found", async () => {
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

  test("malformed index output propagates instead of becoming a status", async () => {
    const source = new ScriptSource();
    source.indexError = malformedIndexError();
    const reader = readerFor(source);
    await expect(reader.readHead("src/a.ts")).rejects.toThrow(ReviewerError);
  });

  test("malformed blob protocol output propagates instead of becoming a status", async () => {
    const source = new ScriptSource();
    source.headFiles.set("src/a.ts", blobEntry(OID_A, "src/a.ts"));
    source.blobs.set(OID_A, protocolBlobError());
    const reader = readerFor(source);
    await expect(reader.readHead("src/a.ts")).rejects.toThrow(ReviewerError);
  });
});

describe("fake validation snapshot reader", () => {
  test("resolves non-canonical paths like the real reader", async () => {
    const reader = new FakeValidationSnapshotReader({
      headSha: HEAD,
      mergeBase: BASE,
      script: { head: { "src/a.ts": { status: "ok", text: "ok\n", bytes: 3 } } },
    });
    const result = await reader.readHead("./src/a.ts");
    expect(result.status).toBe("ok");
    expect(reader.reads).toEqual([{ side: "head", path: "./src/a.ts" }]);
  });

  test("unscripted paths still throw loudly", async () => {
    const reader = new FakeValidationSnapshotReader({ headSha: HEAD, mergeBase: BASE });
    expect(() => reader.readHead("src/missing.ts")).toThrow();
  });

  test("pre-aborted signal returns aborted without touching the script", async () => {
    const reader = new FakeValidationSnapshotReader({
      headSha: HEAD,
      mergeBase: BASE,
      script: { head: { "src/a.ts": { status: "ok", text: "ok\n", bytes: 3 } } },
    });
    const controller = new AbortController();
    controller.abort();
    const result = await reader.readHead("src/a.ts", { signal: controller.signal });
    expect(result.status).toBe("aborted");
    expect(reader.reads).toHaveLength(0);
  });
});
