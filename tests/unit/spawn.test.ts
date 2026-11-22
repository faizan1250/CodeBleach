import { describe, expect, test } from "bun:test";
import { ReviewerError } from "../../src/core/errors.ts";
import {
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_STDOUT_BYTES,
  DEFAULT_SPAWN_TIMEOUT_MS,
  runProcess,
  type ProcessFailureDetails,
} from "../../src/utils/spawn.ts";

const BUN = process.execPath;

function failureOf(error: unknown): { code: string; details: ProcessFailureDetails | undefined } {
  expect(error).toBeInstanceOf(ReviewerError);
  const reviewer = error as ReviewerError;
  const details =
    reviewer.cause !== undefined && typeof reviewer.cause === "object" && reviewer.cause !== null
      ? (reviewer.cause as ProcessFailureDetails)
      : undefined;
  return { code: reviewer.code, details };
}

describe("runProcess argv", () => {
  test("passes values with spaces and metacharacters as single args", async () => {
    const args = ["a b", "$HOME", "--flag=x y", "semi;colon", "`backtick`", 'quote"q'];
    const result = await runProcess({
      cmd: [BUN, "-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...args],
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual(args);
  });

  test("captures stdout and stderr separately", async () => {
    const result = await runProcess({
      cmd: [BUN, "-e", "process.stdout.write('out');process.stderr.write('err');"],
    });
    expect(new TextDecoder().decode(result.stdout)).toBe("out");
    expect(new TextDecoder().decode(result.stderr)).toBe("err");
  });
});

describe("runProcess failures", () => {
  test("reports non-zero exit as GIT_FAILED with a bounded stderr excerpt", async () => {
    const bigStderr = "e".repeat(5000);
    const error = await runProcess({
      cmd: [BUN, "-e", `process.stderr.write(${JSON.stringify(bigStderr)});process.exit(3);`],
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).not.toBeNull();
    const { code, details } = failureOf(error);
    expect(code).toBe("GIT_FAILED");
    expect((error as Error).message).toMatch(/exit(ed)? with code 3/);
    expect((error as Error).message.length).toBeLessThan(bigStderr.length);
    expect(details?.reason).toBe("exit");
  });

  test("fails a missing executable as GIT_FAILED with cause", async () => {
    const error = await runProcess({ cmd: ["codebleach-no-such-binary-xyz"] }).then(
      () => null,
      (caught: unknown) => caught,
    );
    const { code } = failureOf(error);
    expect(code).toBe("GIT_FAILED");
    expect((error as ReviewerError).cause).toBeDefined();
  });

  test("times out and reaps a slow child", async () => {
    const start = Date.now();
    const error = await runProcess({
      cmd: [BUN, "-e", "await new Promise((r) => setTimeout(r, 30000));"],
      timeoutMs: 200,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    const { code, details } = failureOf(error);
    expect(code).toBe("GIT_FAILED");
    expect((error as Error).message).toMatch(/timed out/);
    expect(details?.reason).toBe("timeout");
    expect(Date.now() - start).toBeLessThan(10000);
  });

  test("aborts on AbortSignal", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const error = await runProcess({
      cmd: [BUN, "-e", "await new Promise((r) => setTimeout(r, 30000));"],
      timeoutMs: 20000,
      signal: controller.signal,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    const { code, details } = failureOf(error);
    expect(code).toBe("GIT_FAILED");
    expect((error as Error).message).toMatch(/abort/i);
    expect(details?.reason).toBe("abort");
  });

  test("pre-aborted signal rejects without spawning", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await runProcess({
      cmd: [BUN, "-e", "process.stdout.write('must never run');"],
      signal: controller.signal,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    const { code, details } = failureOf(error);
    expect(code).toBe("GIT_FAILED");
    expect(details?.reason).toBe("abort");
  });

  test("abort kills and reaps the child promptly", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runProcess({
      cmd: [BUN, "-e", "await new Promise((r) => setTimeout(r, 30000));"],
      timeoutMs: 20000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const error = await pending.then(
      () => null,
      (caught: unknown) => caught,
    );
    // Settling quickly proves the child was killed and reaped: runProcess
    // awaits the pump and proc.exited before rejecting, so a lingering child
    // would hold this open for the full 30s sleep.
    expect(Date.now() - started).toBeLessThan(10000);
    const { code, details } = failureOf(error);
    expect(code).toBe("GIT_FAILED");
    expect(details?.reason).toBe("abort");
  });

  test("rejects an empty cmd as INTERNAL", async () => {
    const error = await runProcess({ cmd: [] }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ReviewerError);
    expect((error as ReviewerError).code).toBe("INTERNAL");
  });
});

describe("runProcess output caps", () => {
  test("flags stdout overflow and never buffers beyond the cap", async () => {
    const error = await runProcess({
      cmd: [BUN, "-e", "const c='x'.repeat(65536);for(let i=0;i<64;i++)process.stdout.write(c);"],
      maxStdoutBytes: 1024,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    const { code, details } = failureOf(error);
    expect(code).toBe("GIT_FAILED");
    expect((error as Error).message).toMatch(/output limit|exceed/i);
    expect(details?.reason).toBe("output-limit");
    expect(details?.stream).toBe("stdout");
    expect(details?.bufferedBytes).toBeLessThanOrEqual(1024);
    expect(details?.observedBytes).toBeGreaterThan(1024);
  });

  test("flags stderr overflow", async () => {
    const error = await runProcess({
      cmd: [BUN, "-e", "const c='e'.repeat(65536);for(let i=0;i<64;i++)process.stderr.write(c);"],
      maxStderrBytes: 512,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    const { code, details } = failureOf(error);
    expect(code).toBe("GIT_FAILED");
    expect((error as Error).message).toMatch(/output limit|exceed/i);
    expect(details?.reason).toBe("output-limit");
    expect(details?.stream).toBe("stderr");
    expect(details?.bufferedBytes).toBeLessThanOrEqual(512);
  });
});

describe("runProcess environment", () => {
  test("scrubs git redirection vars and sets GIT_OPTIONAL_LOCKS=0", async () => {
    const vars = [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_COMMON_DIR",
    ] as const;
    const saved = new Map<string, string | undefined>();
    for (const name of vars) {
      saved.set(name, process.env[name]);
      process.env[name] = "/tmp/evil";
    }
    try {
      const script = `process.stdout.write(JSON.stringify({${vars.map((v) => `${v}:process.env.${v} ?? null`).join(",")},GIT_OPTIONAL_LOCKS:process.env.GIT_OPTIONAL_LOCKS ?? null}))`;
      const result = await runProcess({ cmd: [BUN, "-e", script] });
      expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({
        GIT_DIR: null,
        GIT_WORK_TREE: null,
        GIT_INDEX_FILE: null,
        GIT_OBJECT_DIRECTORY: null,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: null,
        GIT_COMMON_DIR: null,
        GIT_OPTIONAL_LOCKS: "0",
      });
    } finally {
      for (const name of vars) {
        const prior = saved.get(name);
        if (prior === undefined) delete process.env[name];
        else process.env[name] = prior;
      }
    }
  });
});

describe("runProcess defaults", () => {
  test("pins the spec timeout and cap constants", () => {
    expect(DEFAULT_SPAWN_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_MAX_STDOUT_BYTES).toBe(26 * 1024 * 1024);
    expect(DEFAULT_MAX_STDERR_BYTES).toBe(1 * 1024 * 1024);
  });
});
