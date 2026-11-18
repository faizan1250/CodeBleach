import { ReviewerError } from "../../core/errors.ts";

export async function readVersion(): Promise<string> {
  const pkg = (await Bun.file(new URL("../../../package.json", import.meta.url)).json()) as {
    version?: unknown;
  };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new ReviewerError({ code: "INTERNAL", message: "package.json has no usable version" });
  }
  return pkg.version;
}

export async function runVersion(): Promise<number> {
  console.log(await readVersion());
  return 0;
}
