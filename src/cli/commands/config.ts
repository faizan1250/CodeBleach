import { loadConfig } from "../../config/load.ts";
import type { Logger } from "../../core/logger.ts";
import { exitCodeForError } from "../exit-codes.ts";

export async function runConfigValidate(repoDir: string, logger: Logger): Promise<number> {
  const result = await loadConfig(repoDir);
  if (!result.ok) {
    logger.error("config invalid", { code: result.error.code });
    console.error(`config invalid: ${result.error.message}`);
    return exitCodeForError(result.error);
  }
  console.log(
    result.value.source === "file"
      ? `config valid: ${result.value.path}`
      : "no config file found; using defaults",
  );
  return 0;
}

export async function runConfigPrint(repoDir: string, logger: Logger): Promise<number> {
  const result = await loadConfig(repoDir);
  if (!result.ok) {
    logger.error("config invalid", { code: result.error.code });
    console.error(`config invalid: ${result.error.message}`);
    return exitCodeForError(result.error);
  }
  console.log(JSON.stringify(result.value.config, null, 2));
  return 0;
}
