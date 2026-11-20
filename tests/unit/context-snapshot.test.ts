import { describe, expect, test } from "bun:test";
import { ReviewerError } from "../../src/core/errors.ts";
import { RunBudget } from "../../src/context/limits.ts";
import {
  SnapshotReader,
  isRegularBlob,
  parseBatchCheckLine,
  parseBatchContent,
  parseGrepZ,
  parseLsTreeZ,
} from "../../src/context/snapshot.ts";

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const HEAD_SHA = "c".repeat(40);
const BASE_SHA = "d".repeat(40);

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function entry(mode: string, type: string, oid: string, path: string): Uint8Array {
  return encode(`${mode} ${type} ${oid}\t${path}\0`);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function codeOf(error: unknown): string {
  expect(error).toBeInstanceOf(ReviewerError);
  return (error as ReviewerError).code;
}

describe("parse ls-tree -z index", () => {
  test("parses regular entries", () => {
    const bytes = concat([entry("100644", "blob", OID_A, "src/a.ts"), entry("100755", "blob", OID_B, "bin/run.sh")]);
    const index = parseLsTreeZ(bytes);
    expect(index.size).toBe(2);
    expect(index.get("src/a.ts")).toEqual({ mode: "100644", type: "blob", oid: OID_A, path: "src/a.ts" });
    expect(index.get("bin/run.sh")).toEqual({ mode: "100755", type: "blob", oid: OID_B, path: "bin/run.sh" });
  });

  test("splits metadata from path at the first tab only", () => {
    const bytes = concat([
      entry("100644", "blob", OID_A, "sub/sp ace.ts"),
      entry("100644", "blob", OID_B, "with\ttab.ts"),
      entry("100644", "blob", OID_A, "with\nnewline.ts"),
    ]);
    const index = parseLsTreeZ(bytes);
    expect(index.size).toBe(3);
    expect(index.get("sub/sp ace.ts")?.oid).toBe(OID_A);
    expect(index.get("with\ttab.ts")?.oid).toBe(OID_B);
    expect(index.get("with\nnewline.ts")?.oid).toBe(OID_A);
  });

  test("empty input yields an empty index", () => {
    expect(parseLsTreeZ(new Uint8Array(0)).size).toBe(0);
  });

  test("record without a tab is PARSE_FAILED", () => {
    try {
      parseLsTreeZ(encode("100644 blob abcdef\n"));
      expect(false).toBe(true);
    } catch (error) {
      expect(codeOf(error)).toBe("PARSE_FAILED");
    }
  });

  test("record with a malformed oid is PARSE_FAILED", () => {
    try {
      parseLsTreeZ(entry("100644", "blob", "not-an-oid", "src/a.ts"));
      expect(false).toBe(true);
    } catch (error) {
      expect(codeOf(error)).toBe("PARSE_FAILED");
    }
  });
});

describe("regular blob detection", () => {
  test("accepts file modes and rejects symlinks, gitlinks, and trees", () => {
    expect(isRegularBlob({ mode: "100644", type: "blob", oid: OID_A, path: "a.ts" })).toBe(true);
    expect(isRegularBlob({ mode: "100755", type: "blob", oid: OID_A, path: "a.sh" })).toBe(true);
    expect(isRegularBlob({ mode: "120000", type: "blob", oid: OID_A, path: "link" })).toBe(false);
    expect(isRegularBlob({ mode: "160000", type: "commit", oid: OID_A, path: "vendor/dep" })).toBe(false);
    expect(isRegularBlob({ mode: "040000", type: "tree", oid: OID_A, path: "sub" })).toBe(false);
  });
});

describe("parse grep -z matches", () => {
  test("parses path, line, and text records", () => {
    const prefix = `${HEAD_SHA}:`;
    const raw = `${prefix}src/a.ts\x001\x00first match\n${prefix}sub/sp ace.ts\x002\x00second match\n`;
    const matches = parseGrepZ(encode(raw), `${HEAD_SHA}:`);
    expect(matches).toEqual([
      { path: "src/a.ts", line: 1, text: "first match" },
      { path: "sub/sp ace.ts", line: 2, text: "second match" },
    ]);
  });

  test("tolerates newlines inside paths and text at end of buffer", () => {
    const raw = `${HEAD_SHA}:we\nird.ts\x007\x00code here`;
    const matches = parseGrepZ(encode(raw), `${HEAD_SHA}:`);
    expect(matches).toEqual([{ path: "we\nird.ts", line: 7, text: "code here" }]);
  });

  test("record without the tree prefix is PARSE_FAILED", () => {
    try {
      parseGrepZ(encode("other.ts\x001\x00hit\n"), `${HEAD_SHA}:`);
      expect(false).toBe(true);
    } catch (error) {
      expect(codeOf(error)).toBe("PARSE_FAILED");
    }
  });

  test("record with a non-numeric line is PARSE_FAILED", () => {
    try {
      parseGrepZ(encode(`${HEAD_SHA}:a.ts\0xx\0hit\n`), `${HEAD_SHA}:`);
      expect(false).toBe(true);
    } catch (error) {
      expect(codeOf(error)).toBe("PARSE_FAILED");
    }
  });
});

describe("batch check line parsing", () => {
  test("parses blob size lines", () => {
    expect(parseBatchCheckLine(`${OID_A} blob 12`)).toEqual({ oid: OID_A, type: "blob", size: 12 });
  });

  test("parses missing lines", () => {
    expect(parseBatchCheckLine(`${OID_A} missing`)).toEqual({ oid: OID_A, type: "missing", size: null });
  });

  test("lowercases oids", () => {
    expect(parseBatchCheckLine(`${OID_A.toUpperCase()} blob 1`).oid).toBe(OID_A);
  });

  test("short lines are GIT_FAILED", () => {
    try {
      parseBatchCheckLine("garbage");
      expect(false).toBe(true);
    } catch (error) {
      expect(codeOf(error)).toBe("GIT_FAILED");
    }
  });

  test("malformed oids are GIT_FAILED", () => {
    try {
      parseBatchCheckLine("not-an-oid blob 3");
      expect(false).toBe(true);
    } catch (error) {
      expect(codeOf(error)).toBe("GIT_FAILED");
    }
  });

  test("non-numeric sizes are GIT_FAILED", () => {
    try {
      parseBatchCheckLine(`${OID_A} blob many`);
      expect(false).toBe(true);
    } catch (error) {
      expect(codeOf(error)).toBe("GIT_FAILED");
    }
  });
});

function batchFrame(oid: string, content: Uint8Array): Uint8Array {
  const header = encode(`${oid} blob ${content.length}\n`);
  const frame = new Uint8Array(header.length + content.length + 1);
  frame.set(header, 0);
  frame.set(content, header.length);
  frame[header.length + content.length] = 10;
  return frame;
}

describe("batch content parsing", () => {
  test("parses one blob frame", () => {
    const frames = parseBatchContent(batchFrame(OID_A, encode("hello\n")), [OID_A]);
    const frame = frames.get(OID_A);
    expect(frame?.status).toBe("blob");
    if (frame?.status !== "blob") return;
    expect(decode(frame.bytes)).toBe("hello\n");
  });

  test("binary content with NUL and LF stays in sync", () => {
    const content = new Uint8Array([0x61, 0x00, 0x0a, 0xff, 0x61]);
    const buffer = concat([batchFrame(OID_A, content), batchFrame(OID_B, encode("second"))]);
    const frames = parseBatchContent(buffer, [OID_A, OID_B]);
    const first = frames.get(OID_A);
    const second = frames.get(OID_B);
    if (first?.status !== "blob" || second?.status !== "blob") {
      expect(false).toBe(true);
      return;
    }
    expect([...first.bytes]).toEqual([0x61, 0x00, 0x0a, 0xff, 0x61]);
    expect(decode(second.bytes)).toBe("second");
  });

  test("empty blob parses", () => {
    const frames = parseBatchContent(batchFrame(OID_A, new Uint8Array(0)), [OID_A]);
    expect(frames.get(OID_A)).toMatchObject({ status: "blob", size: 0 });
  });

  test("missing frame parses", () => {
    const frames = parseBatchContent(encode(`${OID_A} missing\n`), [OID_A]);
    expect(frames.get(OID_A)).toEqual({ oid: OID_A, status: "missing" });
  });

  test("oid mismatch is GIT_FAILED", () => {
    try {
      parseBatchContent(batchFrame(OID_B, encode("x")), [OID_A]);
      expect(false).toBe(true);
    } catch (error) {
      expect(codeOf(error)).toBe("GIT_FAILED");
    }
  });

  test("non-blob type is GIT_FAILED", () => {
    const header = encode(`${OID_A} tree 4\n`);
    const buffer = concat([header, encode("abcd"), encode("\n")]);
    try {
      parseBatchContent(buffer, [OID_A]);
      expect(false).toBe(true);
    } catch (error) {
      expect(codeOf(error)).toBe("GIT_FAILED");
    }
  });

  test("truncated content is GIT_FAILED", () => {
    const full = batchFrame(OID_A, encode("hello"));
    try {
      parseBatchContent(full.subarray(0, full.length - 2), [OID_A]);
      expect(false).toBe(true);
    } catch (error) {
      expect(codeOf(error)).toBe("GIT_FAILED");
    }
  });

  test("truncated header is GIT_FAILED", () => {
    try {
      parseBatchContent(encode(`${OID_A} blob`), [OID_A]);
      expect(false).toBe(true);
    } catch (error) {
      expect(codeOf(error)).toBe("GIT_FAILED");
    }
  });

  test("trailing bytes are GIT_FAILED", () => {
    try {
      parseBatchContent(concat([batchFrame(OID_A, encode("x")), encode("trailing")]), [OID_A]);
      expect(false).toBe(true);
    } catch (error) {
      expect(codeOf(error)).toBe("GIT_FAILED");
    }
  });

  function decode(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
  }
});

describe("snapshot reader construction", () => {
  test("rejects an empty repo root", () => {
    try {
      new SnapshotReader({ repoRoot: "", headSha: HEAD_SHA, mergeBase: BASE_SHA });
      expect(false).toBe(true);
    } catch (error) {
      expect(codeOf(error)).toBe("INTERNAL");
    }
  });

  test("rejects malformed commit shas", () => {
    try {
      new SnapshotReader({ repoRoot: "/repo", headSha: "short", mergeBase: BASE_SHA });
      expect(false).toBe(true);
    } catch (error) {
      expect(codeOf(error)).toBe("INTERNAL");
    }
  });

  test("rejects non-positive blob caps", () => {
    try {
      new SnapshotReader({ repoRoot: "/repo", headSha: HEAD_SHA, mergeBase: BASE_SHA, maxBlobBytes: 0 });
      expect(false).toBe(true);
    } catch (error) {
      expect(codeOf(error)).toBe("INTERNAL");
    }
  });

  test("expired run budget rejects reads with GIT_FAILED", async () => {
    let now = 1000;
    const budget = new RunBudget({ maxRunMs: 100, maxTotalParseMs: 100 }, { now: () => now });
    now = 2000;
    const reader = new SnapshotReader({ repoRoot: "/repo", headSha: HEAD_SHA, mergeBase: BASE_SHA, runBudget: budget });
    try {
      await reader.listHeadFiles();
      expect(false).toBe(true);
    } catch (error) {
      expect(codeOf(error)).toBe("GIT_FAILED");
    }
  });
});
