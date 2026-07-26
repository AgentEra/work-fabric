import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { agentlySecretPaths, validateAgentlyRuntimeDriverConfig } from "../src/index.js";

const base = {
  python: { executable: "./test/fixtures/fake-worker.mjs", module: "work_fabric_agently_runtime" },
  workspace_root: "./var/workspaces",
  execution_timeout_seconds: 60,
  cancellation_grace_seconds: 2,
  provider: { type: "OpenAICompatible", base_url: "https://model.example.test/v1", model: "test-model", api_key: "resolved-test-key" },
};

describe("validateAgentlyRuntimeDriverConfig", () => {
  it("resolves executable and workspace paths at startup", () => {
    const config = validateAgentlyRuntimeDriverConfig(base, "agent-runtime.agently", { config_directory: process.cwd() });
    expect(config.python.executable).toBe(resolve("test/fixtures/fake-worker.mjs"));
    expect(config.workspace_root).toBe(resolve("var/workspaces"));
    expect(config.python.module).toBe("work_fabric_agently_runtime");
  });

  it.each([
    ["a shell lookup executable", { python: { ...base.python, executable: "python" } }],
    ["a different worker module", { python: { ...base.python, module: "other" } }],
    ["an insecure production model URL", { provider: { ...base.provider, base_url: "http://model.example.test" } }],
    ["an empty resolved API key", { provider: { ...base.provider, api_key: "" } }],
    ["an excessive timeout", { execution_timeout_seconds: 86_401 }],
    ["an excessive cancellation grace", { cancellation_grace_seconds: 61 }],
  ])("rejects %s", (_name, change) => {
    expect(() => validateAgentlyRuntimeDriverConfig({ ...base, ...change }, "agent-runtime.agently", { config_directory: process.cwd() })).toThrow();
  });

  it("permits an HTTP development endpoint only when development mode is explicit", () => {
    const config = validateAgentlyRuntimeDriverConfig({ ...base, development_mode: true, provider: { ...base.provider, base_url: "http://127.0.0.1:8080/v1" } }, "agent-runtime.agently", { config_directory: process.cwd() });
    expect(config.provider.base_url).toBe("http://127.0.0.1:8080/v1");
  });

  it("declares only the resolved provider API key as a secret", () => {
    expect(agentlySecretPaths()).toEqual(["provider.api_key"]);
  });
});
