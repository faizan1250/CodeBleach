import { ReviewerError } from "../core/errors.ts";
import { runProcess } from "../utils/spawn.ts";

export function gitFailed(message: string, cause?: unknown): ReviewerError {
  return cause === undefined
    ? new ReviewerError({ code: "GIT_FAILED", message })
    : new ReviewerError({ code: "GIT_FAILED", message, cause });
}

export function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

// Pinned on both diff invocations so user/repo Git config cannot change output.
// Explicit flags override diff.algorithm, diff.interHunkContext,
// diff.renames, and diff.indentHeuristic alike (ADR 0008/0009).
// GREEN keeps the same pins for raw, numstat, and patch alike so file
// ordering and rename detection agree across metadata and patch.
export const PINNED_DIFF_FLAGS: readonly string[] = [
  "--diff-algorithm=myers",
  "--inter-hunk-context=0",
  "--find-renames=50%",
  "--no-indent-heuristic",
];

export async function gitDiffBytes(
  repoRoot: string,
  args: readonly string[],
  what: string,
  maxStdoutBytes?: number,
): Promise<Uint8Array> {
  try {
    return (
      await runProcess({
        cmd: ["git", "diff", ...args],
        cwd: repoRoot,
        ...(maxStdoutBytes === undefined ? {} : { maxStdoutBytes }),
      })
    ).stdout;
  } catch (cause) {
    if (cause instanceof ReviewerError && cause.code === "INTERNAL") throw cause;
    throw gitFailed(`${what} failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause);
  }
}
