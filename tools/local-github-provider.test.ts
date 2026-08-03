import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadNodeConfiguration } from "../packages/service-node/src/configuration-loader.js";
import { prepareLocalFeishuEnvironment } from "./local-feishu-common.js";
import {
  prepareLocalGitHubProviderEnvironment,
  runLocalGitHubProvider,
} from "./local-github-provider.js";

async function feishuOnlyInput(): Promise<{
  readonly directory: string;
  readonly input: Readonly<Record<string, string>>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "work-fabric-feishu-only-"));
  const envFile = join(directory, "feishu.env");
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
  ].join("\n"));
  return {
    directory,
    input: {
      WORK_FABRIC_ENV_FILE: envFile,
      WORK_FABRIC_CONFIG: resolve("examples/config/local-feishu-assistant.bundle.yaml"),
      WORK_FABRIC_RESOLVED_CONFIG: join(directory, "resolved.yaml"),
    },
  };
}

describe("optional local GitHub Provider", () => {
  it("keeps the unified bundle GitHub Provider authority grant system-typed", async () => {
    const fixture = await feishuOnlyInput();
    try {
      const environment = await prepareLocalFeishuEnvironment(fixture.input);
      const loaded = await loadNodeConfiguration(environment);
      expect(loaded.agent_runtime_authority?.grants?.["github-provider"])
        .toMatchObject({ actor_type: "system" });
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("does not require GitHub credentials for the existing Feishu stack", async () => {
    const fixture = await feishuOnlyInput();
    try {
      const environment = await prepareLocalFeishuEnvironment(fixture.input);

      await expect(loadNodeConfiguration(environment)).resolves.toMatchObject({
        service: { tenant_id: "tenant-local" },
      });

      expect(environment.WORK_FABRIC_GITHUB_PROVIDER_CONFIG_APPLICATION).toBe(
        "github-provider",
      );
      expect(environment.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
      const configPath = environment.WORK_FABRIC_CONFIG;
      expect(configPath).toBeDefined();
      const config = await readFile(configPath!, "utf8");
      expect(config).toContain("${WORK_FABRIC_DISABLED_GITHUB_PROVIDER_TOKEN}");
      const disabledToken = environment.WORK_FABRIC_DISABLED_GITHUB_PROVIDER_TOKEN;
      expect(disabledToken).toBeDefined();
      expect(disabledToken).not.toBe(environment.WORK_FABRIC_ADMIN_TOKEN);
      const loaded = await loadNodeConfiguration(environment);
      const tokens = loaded.service.identities.map(
        (identity) => identity.authentication_evidence.bearer_token,
      );
      expect(new Set(tokens).size).toBe(tokens.length);
      expect(tokens).toContain(disabledToken);
      const nextEnvironment = await prepareLocalFeishuEnvironment(fixture.input);
      expect(nextEnvironment.WORK_FABRIC_DISABLED_GITHUB_PROVIDER_TOKEN).not.toBe(
        disabledToken,
      );
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("prepares enabled GitHub without any Feishu variables", async () => {
    const directory = await mkdtemp(join(tmpdir(), "work-fabric-github-only-"));
    try {
      const envFile = join(directory, "github.env");
      const enabledConfig = join(directory, "github-enabled.yaml");
      await writeFile(enabledConfig, (await readFile(
        resolve("examples/config/local-feishu-assistant.bundle.yaml"),
        "utf8",
      )).replace("enabled: false", "enabled: true"));
      await writeFile(envFile, [
        `WORK_FABRIC_ADMIN_TOKEN=${"a".repeat(32)}`,
        "GITHUB_APP_ID=app-id",
        "GITHUB_APP_INSTALLATION_ID=installation-id",
        "GITHUB_APP_PRIVATE_KEY=private-key",
        "GITHUB_PROVIDER_ACCESS_TOKEN=provider-token",
        `WORK_FABRIC_GITHUB_CURSOR_SECRET=${"g".repeat(32)}`,
      ].join("\n"));

      await expect(prepareLocalGitHubProviderEnvironment({
        WORK_FABRIC_ENV_FILE: envFile,
        WORK_FABRIC_CONFIG: enabledConfig,
        WORK_FABRIC_RESOLVED_CONFIG: join(directory, "resolved.yaml"),
      })).resolves.toMatchObject({
        WORK_FABRIC_GITHUB_PROVIDER_CONFIG_APPLICATION: "github-provider",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires its own access token when GitHub is enabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "work-fabric-github-token-"));
    try {
      const envFile = join(directory, "github.env");
      const enabledConfig = join(directory, "github-enabled.yaml");
      await writeFile(enabledConfig, (await readFile(
        resolve("examples/config/local-feishu-assistant.bundle.yaml"),
        "utf8",
      )).replace("enabled: false", "enabled: true"));
      await writeFile(envFile, [
        "GITHUB_APP_ID=app-id",
        "GITHUB_APP_INSTALLATION_ID=installation-id",
        "GITHUB_APP_PRIVATE_KEY=private-key",
        `WORK_FABRIC_GITHUB_CURSOR_SECRET=${"g".repeat(32)}`,
      ].join("\n"));

      await expect(prepareLocalGitHubProviderEnvironment({
        WORK_FABRIC_ENV_FILE: envFile,
        WORK_FABRIC_CONFIG: enabledConfig,
        WORK_FABRIC_RESOLVED_CONFIG: join(directory, "resolved.yaml"),
      })).rejects.toThrow(/GITHUB_PROVIDER_ACCESS_TOKEN/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires the administrative token before the local provision-and-start flow", async () => {
    const directory = await mkdtemp(join(tmpdir(), "work-fabric-github-admin-token-"));
    try {
      const envFile = join(directory, "github.env");
      const enabledConfig = join(directory, "github-enabled.yaml");
      await writeFile(enabledConfig, (await readFile(
        resolve("examples/config/local-feishu-assistant.bundle.yaml"),
        "utf8",
      )).replace("enabled: false", "enabled: true"));
      await writeFile(envFile, [
        "GITHUB_APP_ID=123",
        "GITHUB_APP_INSTALLATION_ID=456",
        "GITHUB_APP_PRIVATE_KEY=private-key",
        "GITHUB_PROVIDER_ACCESS_TOKEN=provider-token",
        `WORK_FABRIC_GITHUB_CURSOR_SECRET=${"g".repeat(32)}`,
      ].join("\n"));

      await expect(prepareLocalGitHubProviderEnvironment({
        WORK_FABRIC_ENV_FILE: envFile,
        WORK_FABRIC_CONFIG: enabledConfig,
        WORK_FABRIC_RESOLVED_CONFIG: join(directory, "resolved.yaml"),
      })).rejects.toThrow(/WORK_FABRIC_ADMIN_TOKEN/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("provisions and starts only the GitHub Provider", async () => {
    const calls: string[] = [];
    let startedEnvironment: Readonly<Record<string, string>> | undefined;
    await runLocalGitHubProvider({}, {
      prepare: async () => ({
        WORK_FABRIC_CONFIG: "github.yaml",
        WORK_FABRIC_ADMIN_TOKEN: "admin-secret",
      }),
      provision: async () => { calls.push("provision:github"); },
      start: async (environment) => {
        calls.push("start:github");
        startedEnvironment = environment;
      },
    });

    expect(calls).toEqual(["provision:github", "start:github"]);
    expect(calls.join(" ")).not.toContain("feishu");
    expect(startedEnvironment).toEqual({ WORK_FABRIC_CONFIG: "github.yaml" });
  });
});
