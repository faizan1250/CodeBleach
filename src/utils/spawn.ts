import { ReviewerError } from "../core/errors.ts";

// Defaults pinned by implementation-phase2.md §5.2.
export const DEFAULT_SPAWN_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_STDOUT_BYTES = 26 * 1024 * 1024;
export const DEFAULT_MAX_STDERR_BYTES = 1 * 1024 * 1024;

// Upper bound on stderr text embedded in error messages; full output is never logged.
const STDERR_EXCERPT_CHARS = 1000;

// Ambient Git redirection variables must not leak into the child (spec §5.2).
const SCRUBBED_GIT_VARS: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
];

export type ProcessFailureReason = "spawn" | "timeout" | "exit" | "output-limit" | "abort";

// Carried as ReviewerError.cause so callers can distinguish overflow (byte-count
// ground truth) from a signal/exit the kill produced.
export interface ProcessFailureDetails {
  reason: ProcessFailureReason;
  stream?: "stdout" | "stderr";
  limitBytes?: number;
  observedBytes?: number;
  bufferedBytes?: number;
  exitCode?: number;
  timeoutMs?: number;
}

export interface RunProcessOptions {
  cmd: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export interface RunProcessResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

function internal(message: string): ReviewerError {
  return new ReviewerError({ code: "INTERNAL", message });
}

function failed(message: string, details: ProcessFailureDetails): ReviewerError {
  return new ReviewerError({ code: "GIT_FAILED", message, cause: details });
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function childEnv(extra: Record<string, string | undefined> | undefined): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of SCRUBBED_GIT_VARS) delete env[name];
  env["GIT_OPTIONAL_LOCKS"] = "0";
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  return env;
}

function excerpt(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return text.length > STDERR_EXCERPT_CHARS ? `${text.slice(0, STDERR_EXCERPT_CHARS)}…` : text;
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// Bounded argv helper around Bun.spawn. Never uses a shell; argv passes verbatim.
export async function runProcess(options: RunProcessOptions): Promise<RunProcessResult> {
  const argv = options.cmd;
  if (argv.length === 0) throw internal("runProcess requires a non-empty cmd array");
  const program = argv[0];
  if (program === undefined || program.length === 0) {
    throw internal("runProcess requires a non-empty executable in cmd[0]");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw internal("runProcess requires timeoutMs to be a positive finite number");
  }
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  for (const [name, cap] of [
    ["maxStdoutBytes", maxStdoutBytes],
    ["maxStderrBytes", maxStderrBytes],
  ] as const) {
    if (!Number.isFinite(cap) || cap < 1) {
      throw internal(`runProcess requires ${name} to be a finite number >= 1`);
    }
  }
  if (options.signal?.aborted === true) {
    throw failed(`command "${program}" was aborted before spawn`, { reason: "abort" });
  }
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...argv], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: childEnv(options.env),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
  } catch (cause) {
    throw new ReviewerError({
      code: "GIT_FAILED",
      message: `failed to spawn "${program}": ${messageOf(cause)}`,
      cause,
    });
  }

  const kill = (): void => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already exited; reap below reports the real outcome.
    }
  };

  let timedOut = false;
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    kill();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);

  // First stream to exceed its cap wins; byte counts are ground truth even
  // though the subsequent kill surfaces as a signal/non-zero exit.
  let overflowStream: "stdout" | "stderr" | null = null;
  let overflowObserved = 0;
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  let stdoutTotal = 0;
  let stderrTotal = 0;

  const pump = async (
    stream: ReadableStream<Uint8Array> | null,
    streamName: "stdout" | "stderr",
    cap: number,
  ): Promise<void> => {
    if (stream === null) return;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        const next = (streamName === "stdout" ? stdoutTotal : stderrTotal) + value.byteLength;
        if (next > cap) {
          if (overflowStream === null) {
            overflowStream = streamName;
            overflowObserved = next;
          }
          kill();
          await reader.cancel().catch(() => {});
          return;
        }
        if (streamName === "stdout") {
          stdoutChunks.push(value);
          stdoutTotal = next;
        } else {
          stderrChunks.push(value);
          stderrTotal = next;
        }
      }
    } finally {
      reader.releaseLock();
    }
  };

  try {
    await Promise.all([
      pump(proc.stdout as ReadableStream<Uint8Array> | null, "stdout", maxStdoutBytes),
      pump(proc.stderr as ReadableStream<Uint8Array> | null, "stderr", maxStderrBytes),
    ]);
    const exitCode = await proc.exited;

    if (overflowStream !== null) {
      const cap = overflowStream === "stdout" ? maxStdoutBytes : maxStderrBytes;
      const buffered = overflowStream === "stdout" ? stdoutTotal : stderrTotal;
      throw failed(`command "${program}" exceeded ${overflowStream} output limit of ${cap} bytes`, {
        reason: "output-limit",
        stream: overflowStream,
        limitBytes: cap,
        observedBytes: overflowObserved,
        bufferedBytes: buffered,
      });
    }
    if (timedOut) {
      throw failed(`command "${program}" timed out after ${timeoutMs}ms`, {
        reason: "timeout",
        timeoutMs,
      });
    }
    if (aborted) {
      throw failed(`command "${program}" was aborted`, { reason: "abort" });
    }
    if (exitCode !== 0) {
      const tail = excerpt(concat(stderrChunks, stderrTotal));
      throw failed(
        tail.length === 0
          ? `command "${program}" exited with code ${exitCode}`
          : `command "${program}" exited with code ${exitCode}: ${tail}`,
        { reason: "exit", exitCode },
      );
    }
    return {
      exitCode,
      stdout: concat(stdoutChunks, stdoutTotal),
      stderr: concat(stderrChunks, stderrTotal),
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
