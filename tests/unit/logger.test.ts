import { afterEach, describe, expect, test } from "bun:test";
import { createLogger } from "../../src/core/logger.ts";

let captured = "";
const originalWrite = process.stderr.write.bind(process.stderr);

function captureStderr(): void {
  captured = "";
  process.stderr.write = ((chunk: unknown) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;
}

afterEach(() => {
  process.stderr.write = originalWrite;
});

describe("logger", () => {
  test("emits valid JSONL to stderr with run id", () => {
    captureStderr();
    const logger = createLogger({ level: "debug", runId: "run-1" });
    logger.info("hello", { nested: { count: 2 }, tags: ["a"] });
    const line = JSON.parse(captured.trim());
    expect(line.level).toBe("info");
    expect(line.runId).toBe("run-1");
    expect(line.msg).toBe("hello");
    expect(line.nested).toEqual({ count: 2 });
    expect(typeof line.ts).toBe("string");
  });

  test("filters below configured level", () => {
    captureStderr();
    const logger = createLogger({ level: "warn", runId: "run-1" });
    logger.debug("quiet");
    logger.info("quiet");
    logger.warn("loud");
    const lines = captured.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "").msg).toBe("loud");
  });

  test("redacts secrets from message and fields", () => {
    captureStderr();
    const logger = createLogger({ level: "debug", runId: "run-1", secrets: ["s3cr3t-value"] });
    logger.info("using s3cr3t-value now", { token: "s3cr3t-value", deep: { password: "plain" } });
    expect(captured).not.toContain("s3cr3t-value");
    expect(captured).toContain("[REDACTED]");
  });

  test("serializes errors without leaking shape", () => {
    captureStderr();
    const logger = createLogger({ level: "debug", runId: "run-1" });
    logger.error("failed", { err: new Error("ghp_abcDEF123") });
    const line = JSON.parse(captured.trim());
    expect(line.err.name).toBe("Error");
    expect(line.err.message).not.toContain("ghp_abcDEF123");
  });

  test("reserved keys win over user fields", () => {
    captureStderr();
    const logger = createLogger({ level: "debug", runId: "run-1" });
    logger.info("real", { runId: "spoofed", ts: "spoofed-ts", level: "spoofed", msg: "spoofed" });
    const line = JSON.parse(captured.trim()) as Record<string, unknown>;
    expect(line["runId"]).toBe("run-1");
    expect(line["level"]).toBe("info");
    expect(line["msg"]).toBe("real");
    expect(line["ts"]).not.toBe("spoofed-ts");
  });
});
