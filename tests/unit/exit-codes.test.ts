import { describe, expect, test } from "bun:test";
import { exitCodeForError } from "../../src/cli/exit-codes.ts";
import { ReviewerError } from "../../src/core/errors.ts";

describe("exitCodeForError", () => {
  test("maps config errors to 2", () => {
    expect(exitCodeForError(new ReviewerError({ code: "CONFIG_INVALID", message: "bad" }))).toBe(2);
    expect(exitCodeForError(new ReviewerError({ code: "CONFIG_UNSUPPORTED_VERSION", message: "v2" }))).toBe(2);
  });

  test("maps runtime errors to 1", () => {
    for (const code of ["GIT_FAILED", "INTERNAL", "NOT_IMPLEMENTED", "PROVIDER_FAILED"] as const) {
      expect(exitCodeForError(new ReviewerError({ code, message: code }))).toBe(1);
    }
  });

  test("maps unknown failures to 1", () => {
    expect(exitCodeForError(new Error("boom"))).toBe(1);
    expect(exitCodeForError("boom")).toBe(1);
  });

  test("maps CLI parse errors to 2", () => {
    const parseError = Object.assign(new Error("unknown option"), { code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" });
    expect(exitCodeForError(parseError)).toBe(2);
  });
});
