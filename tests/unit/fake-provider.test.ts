import { describe, expect, test } from "bun:test";
import { FakeProvider } from "../../src/providers/fake.ts";

describe("FakeProvider", () => {
  test("consumes first matching step in order", async () => {
    const provider = new FakeProvider([
      { match: (req) => req.system === "a", respond: "first" },
      { respond: "fallback" },
    ]);
    await expect(provider.complete({ system: "b", user: "u" })).resolves.toMatchObject({
      text: "fallback",
    });
    await expect(provider.complete({ system: "a", user: "u" })).resolves.toMatchObject({
      text: "first",
    });
  });

  test("records every call", async () => {
    const provider = new FakeProvider([{ respond: "ok" }, { respond: "ok2" }]);
    await provider.complete({ system: "s1", user: "u1" });
    await provider.complete({ system: "s2", user: "u2" });
    expect(provider.calls.map((call) => call.system)).toEqual(["s1", "s2"]);
  });

  test("serializes object responses to text without validating", async () => {
    const provider = new FakeProvider([{ respond: { findings: [1, 2] } }]);
    const response = await provider.complete({ system: "s", user: "u" });
    expect(response.text).toBe('{"findings":[1,2]}');
    expect(response.model).toBe("fake-model");
  });

  test("throws scripted errors", async () => {
    const provider = new FakeProvider([{ respond: new Error("downstream blew up") }]);
    await expect(provider.complete({ system: "s", user: "u" })).rejects.toThrow("downstream blew up");
  });

  test("unmatched scripts fail loudly", async () => {
    const provider = new FakeProvider([{ match: () => false, respond: "never" }]);
    await expect(provider.complete({ system: "s", user: "u" })).rejects.toThrow("no scripted step matched");
  });
});
