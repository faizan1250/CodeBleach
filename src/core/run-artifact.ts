import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedConfig } from "../config/schema.ts";
import { sanitizePayload } from "../utils/redact.ts";
import type {
  ContextBuildDiagnostics,
  DiffResult,
  Finding,
  PublishResult,
  ReviewUnit,
  ValidatedFinding,
} from "../types/index.ts";
import type { ConfigSource, StageResult } from "./contracts.ts";

export const RUN_ARTIFACT_SCHEMA_VERSION = 1;

export interface SerializedError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface RunArtifact {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  completedAt: string;
  baseSha: string;
  headSha: string;
  configSource: ConfigSource;
  status: "running" | "completed" | "failed";
  stages: StageResult[];
  config: ResolvedConfig | null;
  diff: DiffResult | null;
  units: ReviewUnit[];
  contextStatus: "complete" | "partial" | null;
  contextDiagnostics: ContextBuildDiagnostics | null;
  findings: Finding[];
  validated: ValidatedFinding[];
  publishResult: PublishResult | null;
  error?: SerializedError | undefined;
}

/** Atomically write pretty-printed, recursively redacted JSON to `<outDir>/run.json`. */
export async function writeArtifact(
  outDir: string,
  artifact: RunArtifact,
  secrets: string[] = [],
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const redacted = sanitizePayload(artifact, secrets) as RunArtifact;
  const path = join(outDir, "run.json");
  const temp = join(outDir, `run.json.tmp.${process.pid}`);
  await writeFile(temp, `${JSON.stringify(redacted, null, 2)}\n`, "utf8");
  await rename(temp, path);
}
