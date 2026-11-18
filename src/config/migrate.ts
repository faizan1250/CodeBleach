import { ReviewerError } from "../core/errors.ts";
import { CONFIG_VERSION } from "./defaults.ts";

/** Validate the YAML root and select the v1 migration path. Throws ReviewerError. */
export function migrate(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ReviewerError({
      code: "CONFIG_INVALID",
      message: "config root must be a mapping object",
    });
  }
  const record = raw as Record<string, unknown>;
  const version = record["version"] ?? CONFIG_VERSION;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new ReviewerError({
      code: "CONFIG_INVALID",
      message: `config version must be an integer, got ${JSON.stringify(version) ?? "null"}`,
    });
  }
  if (version === CONFIG_VERSION) return record;
  if (version > CONFIG_VERSION) {
    throw new ReviewerError({
      code: "CONFIG_UNSUPPORTED_VERSION",
      message: `unsupported config version ${version}; this reviewer supports v${CONFIG_VERSION}`,
    });
  }
  throw new ReviewerError({
    code: "CONFIG_INVALID",
    message: `unsupported config version ${version}`,
  });
}
