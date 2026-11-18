import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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
  try {
    const repoStat = await stat(repoRoot);
    if (!repoStat.isDirectory()) {
      return err(invalid(repoRoot, "repo directory is not a directory"));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return err(invalid(repoRoot, "repo directory does not exist"));
    }
    return err(invalid(repoRoot, "cannot access repo directory", error));
  }
  const configPath = join(repoRoot, ".reviewer.yml");

  try {
    await lstat(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return ok({ config: ConfigFileSchema.parse({}), source: "defaults" });
    }
    return err(invalid(configPath, "cannot read config file", error));
  }

  let repoReal: string;
  try {
    repoReal = await realpath(repoRoot);
  } catch (error) {
    return err(invalid(configPath, "cannot resolve config path", error));
  }

  let configReal: string;
  try {
    configReal = await realpath(configPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return err(invalid(configPath, "config file is a dangling symlink"));
    }
    if (code === "ELOOP") {
      return err(invalid(configPath, "config file contains a symlink loop"));
    }
    return err(invalid(configPath, "cannot resolve config path", error));
  }

  const rel = relative(repoReal, configReal);
  const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (!inside) {
    return err(invalid(configPath, "config file must remain inside the repository root"));
  }

  try {
    const configStat = await stat(configReal);
    if (!configStat.isFile()) {
      return err(invalid(configPath, "config file is not a regular file"));
    }
  } catch (error) {
    return err(invalid(configPath, "cannot read config file", error));
  }

  let text: string;
  try {
    text = await readFile(configReal, "utf8");
  } catch (error) {
    return err(invalid(configPath, "cannot read config file", error));
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
