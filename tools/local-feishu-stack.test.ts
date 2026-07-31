import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { loadAgentRuntimeConfiguration } from "@work-fabric/agent-runtime-host";
import { loadNodeConfiguration } from "../packages/service-node/src/configuration-loader.js";
import { loadFeishuProviderConfiguration } from "../examples/feishu-capability-provider/src/configuration.js";
import { prepareLocalFeishuEnvironment } from "./local-feishu-common.js";
import {
  LocalFeishuStackSupervisor,
  type LocalChildProcess,
} from "./local-feishu-stack.js";
import { LOCAL_FEISHU_CITIZEN_IDS } from "./local-feishu-status.js";

function child(pid: number): LocalChildProcess {
  const process = new EventEmitter() as LocalChildProcess & EventEmitter;
  Object.assign(process, {
    pid,
    kill: vi.fn(() => true),
  });
  return process;
}

describe("LocalFeishuStackSupervisor", () => {
  it("checks every independently registered Feishu Provider facet", () => {
    expect(LOCAL_FEISHU_CITIZEN_IDS).toEqual({
      message: "citizen-feishu-message",
      document: "citizen-feishu-document",
      calendar: "citizen-feishu-calendar",
      context: "citizen-feishu-context",
    });
  });

  it("materializes one bundle that all three application loaders accept", async () => {
    const directory = await mkdtemp(join(tmpdir(), "work-fabric-local-bundle-"));
    try {
      const envFile = join(directory, "local.env");
      const resolvedConfig = join(directory, "resolved.yaml");
      await writeFile(envFile, [
        `WORK_FABRIC_CURSOR_SECRET=${"c".repeat(32)}`,
        `WORK_FABRIC_FEISHU_CURSOR_SECRET=${"h".repeat(32)}`,
        `WORK_FABRIC_ADMIN_TOKEN=${"a".repeat(32)}`,
        `WORK_FABRIC_ADMISSION_FINGERPRINT_KEY=${"f".repeat(32)}`,
        `WORK_FABRIC_ADMISSION_GRANT_KEY=${"g".repeat(32)}`,
        "FEISHU_APP_ID=app-id",
        "FEISHU_APP_SECRET=app-secret",
        `FEISHU_CONNECTOR_ACCESS_TOKEN=${"x".repeat(32)}`,
        `INTAKE_AGENT_ACCESS_TOKEN=${"i".repeat(32)}`,
        `FEISHU_PROVIDER_ACCESS_TOKEN=${"p".repeat(32)}`,
        "AGENTLY_MODEL_API_KEY=model-key",
        "FEISHU_EXTERNAL_TENANT_ID=tenant-external",
        "FEISHU_BOT_OPEN_ID=bot-open-id",
        "WORK_FABRIC_ALLOW_UNSAFE_DOCUMENT_ACCESS=true",
        "WORK_FABRIC_CONFIG_APPLICATION=legacy-service",
        "WORK_FABRIC_AGENT_RUNTIME_CONFIG=/legacy/agent-runtime.yaml",
        "WORK_FABRIC_AGENT_RUNTIME_CONFIG_APPLICATION=legacy-agent",
        "WORK_FABRIC_FEISHU_PROVIDER_CONFIG=/legacy/feishu-provider.yaml",
        "WORK_FABRIC_FEISHU_PROVIDER_CONFIG_APPLICATION=legacy-provider",
      ].join("\n"));
      const environment = await prepareLocalFeishuEnvironment({
        WORK_FABRIC_ENV_FILE: envFile,
        WORK_FABRIC_CONFIG: resolve(
          "examples/config/local-feishu-assistant.bundle.yaml",
        ),
        WORK_FABRIC_RESOLVED_CONFIG: resolvedConfig,
      });
      const [service, agent, provider] = await Promise.all([
        loadNodeConfiguration(environment),
        loadAgentRuntimeConfiguration({ environment }),
        loadFeishuProviderConfiguration({ environment }),
      ]);
      expect(service.service.tenant_id).toBe("tenant-local");
      expect(agent.role.role_id).toBe("daily-assistant");
      expect(provider.provider).not.toHaveProperty("shared_folder");
      expect(provider.service.document_access.mode).toBe(
        "development_app_identity",
      );
      expect(environment.WORK_FABRIC_CONFIG_APPLICATION).toBe("work-fabric");
      expect(environment.WORK_FABRIC_AGENT_RUNTIME_CONFIG).toBe(
        resolvedConfig,
      );
      expect(
        environment.WORK_FABRIC_AGENT_RUNTIME_CONFIG_APPLICATION,
      ).toBe("daily-assistant");
      expect(environment.WORK_FABRIC_FEISHU_PROVIDER_CONFIG).toBe(
        resolvedConfig,
      );
      expect(
        environment.WORK_FABRIC_FEISHU_PROVIDER_CONFIG_APPLICATION,
      ).toBe("feishu-provider");
      expect(await readFile(resolvedConfig, "utf8")).not.toContain(
        "tenant-external\n",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("starts Service, provisions, then starts Provider and Agent", async () => {
    const calls: string[] = [];
    const children = [child(101), child(102), child(103)];
    const supervisor = new LocalFeishuStackSupervisor({
      spawn: (name, environment) => {
        calls.push(
          `spawn:${name}:${
            environment.WORK_FABRIC_FEISHU_ENDPOINT_REGISTRATION_VERSION
              ?? "unset"
          }`,
        );
        return children.shift()!;
      },
      wait_for_service: async () => { calls.push("ready:service"); },
      provision: async () => {
        calls.push("provision");
        return { feishu_endpoint_registration_version: 2 };
      },
      write_pid_state: async (state) => {
        calls.push(`pids:${state.children.map((item) => item.name).join(",")}`);
      },
      remove_pid_state: async () => { calls.push("pids:remove"); },
      log: () => undefined,
    });
    await supervisor.start({});
    expect(calls).toEqual([
      "spawn:service:unset",
      "ready:service",
      "provision",
      "spawn:feishu-provider:2",
      "spawn:daily-assistant:unset",
      "pids:service,feishu-provider,daily-assistant",
    ]);
  });

  it("shuts down children in reverse order and removes PID state", async () => {
    const calls: string[] = [];
    const children = [child(201), child(202), child(203)];
    for (const item of children) {
      const original = item.kill;
      item.kill = vi.fn(() => {
        calls.push(`kill:${item.pid}`);
        queueMicrotask(() => item.emit("exit", 0, null));
        return original.call(item);
      });
    }
    const supervisor = new LocalFeishuStackSupervisor({
      spawn: () => children.shift()!,
      wait_for_service: async () => undefined,
      provision: async () => ({
        feishu_endpoint_registration_version: 1,
      }),
      write_pid_state: async () => undefined,
      remove_pid_state: async () => { calls.push("pids:remove"); },
      log: () => undefined,
    });
    await supervisor.start({});
    await supervisor.close();
    expect(calls).toEqual([
      "kill:203",
      "kill:202",
      "kill:201",
      "pids:remove",
    ]);
  });

  it("cleans up a partial stack when readiness fails", async () => {
    const service = child(301);
    service.kill = vi.fn(() => {
      queueMicrotask(() => service.emit("exit", 0, null));
      return true;
    });
    const supervisor = new LocalFeishuStackSupervisor({
      spawn: () => service,
      wait_for_service: async () => { throw new Error("service timeout"); },
      provision: async () => ({
        feishu_endpoint_registration_version: 1,
      }),
      write_pid_state: async () => undefined,
      remove_pid_state: async () => undefined,
      log: () => undefined,
    });
    await expect(supervisor.start({})).rejects.toThrow("service timeout");
    expect(service.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
