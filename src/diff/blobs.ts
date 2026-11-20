import { ReviewerError } from "../core/errors.ts";
import type { ChangedSymbol } from "../types/diff.ts";
import { DEFAULT_MAX_STDOUT_BYTES, runProcess } from "../utils/spawn.ts";
import { decode, gitFailed } from "./git-exec.ts";
import type { ParsedFilePatch } from "./parse.ts";

export async function headBlobContent(
  repoRoot: string,
  headSha: string,
  path: string,
  sizeBytes: number,
): Promise<Uint8Array> {
  try {
    // Bounded by the known blob size. The schema ceiling on max_file_size_kb
    // keeps sizeBytes+1 within the spawn cap, so overflow via size alone is
    // unreachable; anything unexpected still fails safe as GIT_FAILED.
    const result = await runProcess({
      cmd: ["git", "show", `${headSha}:${path}`],
      cwd: repoRoot,
      maxStdoutBytes: Math.min(sizeBytes + 1, DEFAULT_MAX_STDOUT_BYTES),
    });
    return result.stdout;
  } catch (cause) {
    if (cause instanceof ReviewerError && cause.code === "INTERNAL") throw cause;
    throw gitFailed(
      `cannot read head blob for "${path}": ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}

// Head-side blob sizes via `git cat-file --batch-check` (one process, no
// working-tree reads). Input is new blob OIDs from --raw; gitlinks never
// reach here (unsupported-mode filtered first, never sent as blob). Missing
// objects are GIT_FAILED with a fetch hint; non-blob types are returned for
// defensive unsupported-mode handling by the caller.
export async function batchCheckBlobSizes(
  repoRoot: string,
  shas: readonly string[],
): Promise<Map<string, { type: string; size: number }>> {
  if (shas.length === 0) return new Map();
  const unique = [...new Set(shas)];
  let stdout: string;
  try {
    const result = await runProcess({
      cmd: ["git", "cat-file", "--batch-check"],
      cwd: repoRoot,
      stdinData: `${unique.join("\n")}\n`,
    });
    stdout = decode(result.stdout);
  } catch (cause) {
    if (cause instanceof ReviewerError && cause.code === "INTERNAL") throw cause;
    throw gitFailed(
      `cannot batch-check head blob sizes: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
  const map = new Map<string, { type: string; size: number }>();
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const parts = line.split(" ");
    if (parts.length < 2) {
      throw gitFailed(`unexpected batch-check line ${JSON.stringify(line)}`);
    }
    const [sha, kind] = parts as [string, string];
    if (kind === "missing") {
      // Caller maps SHA back to a path for a fetch-hint error.
      map.set(sha, { type: "missing", size: -1 });
      continue;
    }
    if (parts.length !== 3) {
      throw gitFailed(`unexpected batch-check line ${JSON.stringify(line)}`);
    }
    const size = Number(parts[2]);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw gitFailed(`batch-check size for "${sha}" is not a valid byte count`);
    }
    map.set(sha, { type: kind, size });
  }
  return map;
}

// LF count plus one for a final line without a newline; empty blob has no lines.
export function countBlobLines(content: Uint8Array): number {
  let lines = 0;
  for (const byte of content) {
    if (byte === 0x0a) lines += 1;
  }
  if (content.length > 0 && content[content.length - 1] !== 0x0a) lines += 1;
  return lines;
}

// Phase 2 placeholder (ADR 0005): one coarse module symbol per eligible file,
// derived from the head blob line count plus the eligible-only patch.
export function moduleSymbol(headLineCount: number, patch: ParsedFilePatch): ChangedSymbol {
  const seen = new Set<number>();
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add" && line.newLine !== null) seen.add(line.newLine);
    }
  }
  return {
    name: "<module>",
    kind: "module",
    startLine: 1,
    endLine: Math.max(1, headLineCount),
    changedLines: [...seen].sort((a, b) => a - b),
  };
}
