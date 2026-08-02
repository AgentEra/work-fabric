import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { prepareLocalDebugEnvironment } from "./local-debug-common.js";

describe("local Debug Channel environment", () => {
  it("loads one explicit env file and resolves the exact bundle path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wf-debug-env-"));
    const envPath = join(directory, "debug.env");
    const configPath = join(directory, "debug.yaml");
    await writeFile(configPath, "api_version: workfabric.config-bundle/v1\n");
    await writeFile(envPath, [
      "WORK_FABRIC_CURSOR_SECRET=" + "x".repeat(32),
      "WORK_FABRIC_ADMIN_TOKEN=admin",
      "WORK_FABRIC_DEBUG_TOKEN=debug",
      "INTAKE_AGENT_ACCESS_TOKEN=agent",
      "AGENTLY_MODEL_API_KEY=model",
      "",
    ].join("\n"));
    try {
      const environment = await prepareLocalDebugEnvironment({
        WORK_FABRIC_ENV_FILE: envPath,
        WORK_FABRIC_CONFIG: configPath,
      });
      expect(environment.WORK_FABRIC_CONFIG).toBe(configPath);
      expect(environment.WORK_FABRIC_AGENT_RUNTIME_CONFIG).toBe(configPath);
      expect(environment.WORK_FABRIC_DEBUG_TOKEN).toBe("debug");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports missing names without disclosing loaded values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wf-debug-env-"));
    const envPath = join(directory, "debug.env");
    await writeFile(envPath, "WORK_FABRIC_DEBUG_TOKEN=sensitive-value\n");
    try {
      await expect(prepareLocalDebugEnvironment({
        WORK_FABRIC_ENV_FILE: envPath,
      })).rejects.toThrow("WORK_FABRIC_CURSOR_SECRET");
      await expect(prepareLocalDebugEnvironment({
        WORK_FABRIC_ENV_FILE: envPath,
      })).rejects.not.toThrow("sensitive-value");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("ignores a Feishu stack config inherited from the shared env file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wf-debug-env-"));
    const envPath = join(directory, "shared.env");
    await writeFile(envPath, [
      "WORK_FABRIC_CURSOR_SECRET=" + "x".repeat(32),
      "WORK_FABRIC_ADMIN_TOKEN=admin",
      "WORK_FABRIC_DEBUG_TOKEN=debug",
      "INTAKE_AGENT_ACCESS_TOKEN=agent",
      "AGENTLY_MODEL_API_KEY=model",
      "WORK_FABRIC_CONFIG=/tmp/real-feishu-stack.yaml",
      "",
    ].join("\n"));
    try {
      const environment = await prepareLocalDebugEnvironment({
        WORK_FABRIC_ENV_FILE: envPath,
      });
      expect(environment.WORK_FABRIC_CONFIG).toBe(
        join(process.cwd(), "examples/config/local-debug-assistant.bundle.yaml"),
      );
      expect(environment.WORK_FABRIC_CONFIG).not.toContain("feishu-stack");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
