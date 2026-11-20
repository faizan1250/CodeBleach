import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ReviewerError } from "../../src/core/errors.ts";
import { FakeProvider } from "../../src/providers/fake.ts";
import { completeJson } from "../../src/providers/json.ts";

const Schema = z.strictObject({ findings: z.array(z.string()) });
const request = { system: "review", user: "find bugs" };

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewerError);
    return (error as ReviewerError).code;
  }
  throw new Error("expected ReviewerError");
}

describe("completeJson", () => {
  test("valid json succeeds on first call", async () => {
    const provider = new FakeProvider([{ respond: '{"findings":[]}' }]);
    await expect(completeJson(provider, request, Schema)).resolves.toEqual({ findings: [] });
    expect(provider.calls).toHaveLength(1);
  });

  test("fully fenced json succeeds", async () => {
    const provider = new FakeProvider([{ respond: '```json\n{"findings":["x"]}\n```' }]);
    await expect(completeJson(provider, request, Schema)).resolves.toEqual({ findings: ["x"] });
  });

  test("invalid json triggers exactly one repair", async () => {
    const provider = new FakeProvider([{ respond: "not json" }, { respond: '{"findings":[]}' }]);
    await expect(completeJson(provider, request, Schema)).resolves.toEqual({ findings: [] });
    expect(provider.calls).toHaveLength(2);
    const repairCall = provider.calls[1];
    expect(repairCall?.user).toContain("not json");
    expect(repairCall?.user).toContain("not valid JSON");
  });

  test("schema-invalid json triggers repair with validation error", async () => {
    const provider = new FakeProvider([{ respond: '{"findings":"oops"}' }, { respond: '{"findings":[]}' }]);
    await expect(completeJson(provider, request, Schema)).resolves.toEqual({ findings: [] });
    const repairCall = provider.calls[1];
    expect(repairCall?.user).toContain('{"findings":"oops"}');
    expect(repairCall?.user).toContain("findings");
  });

  test("second failure yields PROVIDER_BAD_OUTPUT", async () => {
    const provider = new FakeProvider([{ respond: "garbage" }, { respond: "still garbage" }]);
    await expect(codeOf(completeJson(provider, request, Schema))).resolves.toBe("PROVIDER_BAD_OUTPUT");
    expect(provider.calls).toHaveLength(2);
  });

  test("provider errors propagate unchanged", async () => {
    const failure = new Error("socket hangup");
    const provider = new FakeProvider([{ respond: failure }]);
    await expect(completeJson(provider, request, Schema)).rejects.toBe(failure);
    expect(provider.calls).toHaveLength(1);
  });

  test("truncates an oversized invalid response in the repair request", async () => {
    const tail = "TAIL-MARKER-9f3c";
    const provider = new FakeProvider([{ respond: `${"x".repeat(20000)}${tail}` }, { respond: '{"findings":[]}' }]);
    await expect(completeJson(provider, request, Schema)).resolves.toEqual({ findings: [] });
    expect(provider.calls).toHaveLength(2);
    const repairUser = provider.calls[1]?.user ?? "";
    expect(repairUser).toContain("x".repeat(100));
    expect(repairUser).not.toContain(tail);
    expect(repairUser.length).toBeLessThan(10000);
  });

  test("truncates oversized validation errors in the repair request", async () => {
    const invalid = Array.from({ length: 300 }, () => ({ findings: "oops" }));
    const provider = new FakeProvider([
      { respond: JSON.stringify({ findings: invalid }) },
      { respond: '{"findings":[]}' },
    ]);
    await expect(completeJson(provider, request, Schema)).resolves.toEqual({ findings: [] });
    expect(provider.calls).toHaveLength(2);
    expect((provider.calls[1]?.user ?? "").length).toBeLessThan(10000);
  });
});
