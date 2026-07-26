import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const guide = new URL("../../../docs/guides/agently-agent-runtime.md", import.meta.url);

describe("Agently Runtime operator guide", () => {
  it("documents the supported absolute environment contract and separate process startup", async () => {
    const source = await readFile(guide, "utf8");

    expect(source).toContain('export WORK_FABRIC_CONFIG="$REPOSITORY_ROOT/examples/config/service-feishu-long-connection.yaml"');
    expect(source).toContain('export WORK_FABRIC_AGENT_RUNTIME_CONFIG="$REPOSITORY_ROOT/examples/config/agent-runtime-agently.yaml"');
    expect(source).toContain("### Terminal 1 — Service");
    expect(source).toContain("### Terminal 2 — Runtime");
    expect(source).not.toContain("--config");
  });

  it("describes the Console Operations Delivery view without claiming unavailable raw cursor details", async () => {
    const source = await readFile(guide, "utf8");

    expect(source).toContain("Console **Operations → Deliveries**");
    expect(source).toContain("does **not** expose raw subscription cursors or Delivery/Status/Result payload bodies");
  });
});
