import { readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { ReviewerError } from "../core/errors.ts";
import { err, ok, type Result } from "../core/result.ts";
import { migrate } from "./migrate.ts";
import { ConfigFileSchema, type ResolvedConfig } from "./schema.ts";

export interface ConfigLoadResult {
  config: ResolvedConfig;
  source: "file" | "defaults";
  path?: string | undefined;
}

function invalid(path: string, detail: string, cause?: unknown): ReviewerError {
  return new ReviewerError({
    code: "CONFIG_INVALID",
    message: `${path}: ${detail}`,
    ...(cause === undefined ? {} : { cause }),
  });
}

function formatIssues(
  path: string,
  issues: Array<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): ReviewerError {
  const details = issues
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return invalid(path, details);
}

/** Load `.reviewer.yml` from the repo root; missing file resolves to defaults. */
export async function loadConfig(repoDir: string): Promise<Result<ConfigLoadResult, ReviewerError>> {
  const repoRoot = resolve(repoDir);
  const configPath = join(repoRoot, ".reviewer.yml");

  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return ok({ config: ConfigFileSchema.parse({}), source: "defaults" });
    }
    return err(invalid(configPath, "cannot read config file", error));
  }

  let repoReal: string;
  let configReal: string;
  try {
    repoReal = await realpath(repoRoot);
    configReal = await realpath(configPath);
  } catch (error) {
    return err(invalid(configPath, "cannot resolve config path", error));
  }
  if (configReal !== `${repoReal}${sep}.reviewer.yml`) {
    return err(invalid(configPath, "config file must be .reviewer.yml at the repository root"));
  }

  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return err(invalid(configPath, `invalid YAML: ${detail}`, error));
  }

  let versioned: unknown;
  try {
    versioned = migrate(raw);
  } catch (error) {
    if (error instanceof ReviewerError) {
      return err(
        new ReviewerError({
          code: error.code,
          message: `${configPath}: ${error.message}`,
          cause: error.cause,
        }),
      );
    }
    throw error;
  }

  const parsed = ConfigFileSchema.safeParse(versioned);
  if (!parsed.success) {
    return err(formatIssues(configPath, parsed.error.issues));
  }
  return ok({ config: parsed.data, source: "file", path: configPath });
}
