import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { loadAgentRuntimeConfiguration } from "@work-fabric/agent-runtime-host";

const guide = new URL("../../../docs/guides/agently-agent-runtime.md", import.meta.url);
const runtimeYaml = new URL("../../config/agent-runtime-agently.yaml", import.meta.url);

describe("Agently Runtime operator guide", () => {
  it("documents the supported absolute environment contract and separate process startup", async () => {
    const source = await readFile(guide, "utf8");

    expect(source).toContain('export WORK_FABRIC_CONFIG="$REPOSITORY_ROOT/examples/config/service-feishu-long-connection.yaml"');
    expect(source).toContain('export WORK_FABRIC_AGENT_RUNTIME_CONFIG="$REPOSITORY_ROOT/examples/config/agent-runtime-agently.yaml"');
    expect(source).toContain("### Terminal 1 — Service");
    expect(source).toContain("### Terminal 2 — Runtime");
    expect(source).not.toContain("--config");
    expect(source).not.toContain("WF_BASE_URL=");
    expect(source).not.toContain("WF_ACCESS_TOKEN=");
    for (const name of [
      "WORK_FABRIC_AGENT_RUNTIME_CONFIG",
      "INTAKE_AGENT_ACCESS_TOKEN",
      "AGENTLY_MODEL_API_KEY",
    ]) expect(source).toContain(name);
  });

  it("documents exactly the environment placeholders consumed by the Runtime YAML loader", async () => {
    const [source, yaml] = await Promise.all([readFile(guide, "utf8"), readFile(runtimeYaml, "utf8")]);
    expect(yaml).toContain("${INTAKE_AGENT_ACCESS_TOKEN}");
    expect(yaml).toContain("${AGENTLY_MODEL_API_KEY}");
    const loaded = await loadAgentRuntimeConfiguration({
      WORK_FABRIC_AGENT_RUNTIME_CONFIG: runtimeYaml.pathname,
      INTAKE_AGENT_ACCESS_TOKEN: "runtime-contract-token",
      AGENTLY_MODEL_API_KEY: "model-contract-token",
    });

    expect(loaded.service.work_fabric.access_token).toBe("runtime-contract-token");
    expect(loaded.driver.config.provider.api_key).toBe("model-contract-token");
    expect(source).toContain("INTAKE_AGENT_ACCESS_TOKEN");
    expect(source).toContain("AGENTLY_MODEL_API_KEY");
  });

  it("describes the Console Operations Delivery view without claiming unavailable raw cursor details", async () => {
    const source = await readFile(guide, "utf8");

    expect(source).toContain("Console **Operations → Deliveries**");
    expect(source).toContain("does **not** expose raw subscription cursors or Delivery/Status/Result payload bodies");
  });
});
