import { redact, sanitizePayload } from "../utils/redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(input: { level: LogLevel; runId: string; secrets?: string[] }): Logger {
  const secrets = input.secrets ?? [];
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[input.level]) return;
    const fieldsOut = fields === undefined ? {} : (sanitizePayload(fields, secrets) as Record<string, unknown>);
    const line = JSON.stringify({
      ...fieldsOut,
      ts: new Date().toISOString(),
      level,
      runId: input.runId,
      msg: redact(msg, secrets),
    });
    process.stderr.write(`${line}\n`);
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}
