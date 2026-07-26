import { describe, expect, it } from "vitest";

import { workspacePath } from "../src/index.js";

describe("workspacePath", () => {
  it("uses separate identifier digests below the configured root", () => {
    const path = workspacePath("/runtime/workspaces", "tenant/private", "handoff/private");
    expect(path).toMatch(/^\/runtime\/workspaces\/[a-f0-9]{64}\/[a-f0-9]{64}$/);
    expect(path).not.toContain("tenant/private");
    expect(path).not.toContain("handoff/private");
  });
});
