import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { runtimeCommandKey } from "../src/index.js";

describe("runtimeCommandKey", () => {
  it("is stable, command-scoped, and contains no input identifiers", () => {
    const expected = createHash("sha256")
      .update(JSON.stringify(["runtime-1", "handoff-1", "accept", 1]))
      .digest("hex");

    expect(runtimeCommandKey("runtime-1", "handoff-1", "accept", 1))
      .toBe(`agent-runtime:accept:${expected}`);
    expect(runtimeCommandKey("runtime-1", "handoff-1", "accept", 1))
      .not.toContain("handoff-1");
    expect(runtimeCommandKey("runtime-1", "handoff-1", "result", 1))
      .not.toBe(`agent-runtime:accept:${expected}`);
  });
});
