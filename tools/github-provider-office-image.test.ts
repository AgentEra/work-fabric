import { describe, expect, it } from "vitest";

import { githubProviderProcessPresent } from "../deploy/office/github-provider-healthcheck.js";

describe("optional GitHub Provider office image", () => {
  it("requires the standalone GitHub Provider process", () => {
    const baseCommands = [
      "node packages/service-node/src/main.ts",
      "node examples/feishu-capability-provider/src/main.ts",
      "node examples/agently-agent-runtime/src/main.ts",
    ];
    const githubCommand = "node examples/github-capability-provider/src/main.ts";

    expect(githubProviderProcessPresent(baseCommands)).toBe(false);
    expect(githubProviderProcessPresent([...baseCommands, githubCommand])).toBe(true);
    expect(githubProviderProcessPresent([
      "observer examples/github-capability-provider/src/main.ts extra",
    ])).toBe(true);
  });
});
