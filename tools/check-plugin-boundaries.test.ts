import { describe, expect, it } from "vitest";
import { checkPluginBoundaries } from "./check-plugin-boundaries.js";

describe("configuration and collaboration-channel boundaries", () => {
  it("keeps configuration and plugins outside Core and excludes Agent-brain responsibilities", async () => {
    await expect(checkPluginBoundaries()).resolves.toMatchObject({
      isolated_imports: 0,
      responsibility_violations: 0,
    });
  });
});
