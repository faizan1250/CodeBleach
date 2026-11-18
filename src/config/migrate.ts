import { ReviewerError } from "../core/errors.ts";
import { CONFIG_VERSION } from "./defaults.ts";

/** One version-to-version step: upgrades a v`n` config toward v`n + 1`. */
export type Migration = (config: Record<string, unknown>) => Record<string, unknown>;

/** Version chain: `MIGRATIONS[n]` upgrades v`n` toward v`n + 1`. Stays v1-only. */
export const MIGRATIONS: Record<number, Migration> = {
  1: (config) => config,
};

/** Validate the YAML root and apply the registered version chain. Throws ReviewerError. */
export function migrate(raw: unknown, registry: Record<number, Migration> = MIGRATIONS): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ReviewerError({
      code: "CONFIG_INVALID",
      message: "config root must be a mapping object",
    });
  }
  const record = raw as Record<string, unknown>;
  // Missing version means v1.
  const version = record["version"] ?? CONFIG_VERSION;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new ReviewerError({
      code: "CONFIG_INVALID",
      message: `config version must be an integer, got ${JSON.stringify(version) ?? "null"}`,
    });
  }
  if (version > CONFIG_VERSION) {
    throw new ReviewerError({
      code: "CONFIG_UNSUPPORTED_VERSION",
      message: `unsupported config version ${version}; this reviewer supports v${CONFIG_VERSION}`,
    });
  }
  let current = version;
  let working = record;
  while (current < CONFIG_VERSION) {
    const step = registry[current];
    if (step === undefined) {
      throw new ReviewerError({
        code: "CONFIG_INVALID",
        message: `unsupported config version ${current}`,
      });
    }
    working = step(working);
    current += 1;
  }
  const final = registry[current];
  if (final === undefined) {
    throw new ReviewerError({
      code: "CONFIG_INVALID",
      message: `no migration registered for config version ${current}`,
    });
  }
  return final(working);
}
