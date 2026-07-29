import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("local Debug Channel documentation", () => {
  it("documents the durable operator contract and troubleshooting layers", async () => {
    const guide = await readFile("docs/guides/local-debug-channel.md", "utf8");
    for (const command of [
      "local:debug:start",
      "local:debug:status",
      "local:debug:send",
      "local:debug:stop",
      "local:debug:e2e",
    ]) expect(guide).toContain(command);
    for (const concept of [
      "development_mode",
      "127.0.0.1",
      "text",
      "data",
      "resource",
      "static",
      "admission",
      "SQLite",
      "Transport",
      "Ingress",
      "Handoff",
      "Agent Runtime",
      "Model",
      "Signal",
      "Capture",
    ]) expect(guide).toContain(concept);
  });
});
