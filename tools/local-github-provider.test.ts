import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createGitHubAppOctokit,
  type GitHubAppOctokitOptions,
  type OctokitRequestClient,
} from "@work-fabric/adapter-github-octokit";

import { EnvironmentGitHubCredentialProvider } from "../examples/github-capability-provider/src/credentials.js";

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
  it("loads a one-line base64 PEM from the configured local env file into the Octokit factory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "work-fabric-github-base64-pem-"));
    try {
      const envFile = join(directory, "github.env");
      const enabledConfig = join(directory, "github-enabled.yaml");
      const privateKey = generateKeyPairSync("rsa", { modulusLength: 2_048 }).privateKey.export({
        type: "pkcs8",
        format: "pem",
      }).toString();
      await writeFile(enabledConfig, (await readFile(
        resolve("examples/config/local-feishu-assistant.bundle.yaml"),
        "utf8",
      )).replace("enabled: false", "enabled: true"));
      await writeFile(envFile, [
        "GITHUB_APP_ID=123",
        "GITHUB_APP_INSTALLATION_ID=456",
        `GITHUB_APP_PRIVATE_KEY=base64:${Buffer.from(privateKey, "utf8").toString("base64")}`,
        "GITHUB_PROVIDER_ACCESS_TOKEN=provider-token",
        `WORK_FABRIC_GITHUB_CURSOR_SECRET=${"g".repeat(32)}`,
        `WORK_FABRIC_ADMIN_TOKEN=${"a".repeat(32)}`,
      ].join("\n"));
      await chmod(envFile, 0o600);

      const environment = await prepareLocalGitHubProviderEnvironment({
        WORK_FABRIC_ENV_FILE: envFile,
        WORK_FABRIC_CONFIG: enabledConfig,
        WORK_FABRIC_RESOLVED_CONFIG: join(directory, "resolved.yaml"),
      });
      const credentials = await new EnvironmentGitHubCredentialProvider({
        credential_ref: "github-primary",
        app_id_environment: "GITHUB_APP_ID",
        installation_id_environment: "GITHUB_APP_INSTALLATION_ID",
        private_key_environment: "GITHUB_APP_PRIVATE_KEY",
        environment,
      }).load();
      const observed: GitHubAppOctokitOptions[] = [];

      expect(() => createGitHubAppOctokit(credentials, (options) => {
        observed.push(options);
        return { request: async () => ({ data: {}, headers: {} }) } as unknown as OctokitRequestClient;
      })).not.toThrow();
      expect(observed[0]?.auth.privateKey).toBe(privateKey);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    "PATH",
    "NODE_OPTIONS",
    "WORK_FABRIC_CURSOR_SECRET",
    "INTAKE_AGENT_ACCESS_TOKEN",
    "WORK_FABRIC_GITHUB_PROVIDER_CONFIG",
    "custom_GITHUB_APP_ID",
  ])("rejects a non-owned dynamic Provider secret name: %s", async (secretName) => {
    const directory = await mkdtemp(join(tmpdir(), "work-fabric-github-secret-name-"));
    try {
      const envFile = join(directory, "github.env");
      const enabledConfig = join(directory, "github-enabled.yaml");
      const bundle = (await readFile(
        resolve("examples/config/local-feishu-assistant.bundle.yaml"),
        "utf8",
      ))
        .replace("enabled: false", "enabled: true")
        .replace("app_id_environment: GITHUB_APP_ID", `app_id_environment: ${secretName}`);
      await writeFile(enabledConfig, bundle);
      await writeFile(envFile, [
        "GITHUB_APP_ID=123",
        "GITHUB_APP_INSTALLATION_ID=456",
        "GITHUB_APP_PRIVATE_KEY=private-key",
        "GITHUB_PROVIDER_ACCESS_TOKEN=provider-token",
        `WORK_FABRIC_GITHUB_CURSOR_SECRET=${"g".repeat(32)}`,
        `WORK_FABRIC_ADMIN_TOKEN=${"a".repeat(32)}`,
        `${secretName}=collision-value`,
      ].join("\n"));
      await chmod(envFile, 0o600);

      await expect(prepareLocalGitHubProviderEnvironment({
        WORK_FABRIC_ENV_FILE: envFile,
        WORK_FABRIC_CONFIG: enabledConfig,
        WORK_FABRIC_RESOLVED_CONFIG: join(directory, "resolved.yaml"),
        PATH: process.env.PATH,
        NODE_OPTIONS: "--inspect",
        WORK_FABRIC_CURSOR_SECRET: "core-secret",
        INTAKE_AGENT_ACCESS_TOKEN: "intake-secret",
      })).rejects.toThrow(/GitHub Provider-owned|invalid/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects duplicate dynamic Provider secret names", async () => {
    const directory = await mkdtemp(join(tmpdir(), "work-fabric-github-duplicate-secret-"));
    try {
      const envFile = join(directory, "github.env");
      const enabledConfig = join(directory, "github-enabled.yaml");
      const bundle = (await readFile(
        resolve("examples/config/local-feishu-assistant.bundle.yaml"),
        "utf8",
      ))
        .replace("enabled: false", "enabled: true")
        .replace(
          "installation_id_environment: GITHUB_APP_INSTALLATION_ID",
          "installation_id_environment: GITHUB_APP_ID",
        );
      await writeFile(enabledConfig, bundle);
      await writeFile(envFile, [
        "GITHUB_APP_ID=123",
        "GITHUB_APP_PRIVATE_KEY=private-key",
        "GITHUB_PROVIDER_ACCESS_TOKEN=provider-token",
        `WORK_FABRIC_GITHUB_CURSOR_SECRET=${"g".repeat(32)}`,
        `WORK_FABRIC_ADMIN_TOKEN=${"a".repeat(32)}`,
      ].join("\n"));
      await chmod(envFile, 0o600);

      await expect(prepareLocalGitHubProviderEnvironment({
        WORK_FABRIC_ENV_FILE: envFile,
        WORK_FABRIC_CONFIG: enabledConfig,
        WORK_FABRIC_RESOLVED_CONFIG: join(directory, "resolved.yaml"),
      })).rejects.toThrow(/distinct|duplicate/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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

  it("provisions with the complete prepared environment but starts with a minimal dynamic Provider environment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "work-fabric-github-child-env-"));
    try {
      const envFile = join(directory, "github.env");
      const enabledConfig = join(directory, "github-enabled.yaml");
      const resolvedConfig = join(directory, "resolved.yaml");
      const bundle = (await readFile(
        resolve("examples/config/local-feishu-assistant.bundle.yaml"),
        "utf8",
      ))
        .replace("enabled: false", "enabled: true")
        .replaceAll("GITHUB_APP_ID", "CUSTOM_GITHUB_APP_ID")
        .replaceAll("GITHUB_APP_INSTALLATION_ID", "CUSTOM_GITHUB_INSTALLATION_ID")
        .replaceAll("GITHUB_APP_PRIVATE_KEY", "CUSTOM_GITHUB_PRIVATE_KEY")
        .replaceAll("GITHUB_PROVIDER_ACCESS_TOKEN", "CUSTOM_GITHUB_FABRIC_TOKEN")
        .replaceAll("WORK_FABRIC_GITHUB_CURSOR_SECRET", "CUSTOM_GITHUB_CURSOR_SECRET");
      await writeFile(enabledConfig, bundle);
      await writeFile(envFile, [
        "CUSTOM_GITHUB_APP_ID=123",
        "CUSTOM_GITHUB_INSTALLATION_ID=456",
        "CUSTOM_GITHUB_PRIVATE_KEY=private-key",
        "CUSTOM_GITHUB_FABRIC_TOKEN=provider-token",
        `CUSTOM_GITHUB_CURSOR_SECRET=${"g".repeat(32)}`,
        `WORK_FABRIC_ADMIN_TOKEN=${"a".repeat(32)}`,
        "FEISHU_APP_SECRET=must-not-reach-provider",
        "AGENTLY_MODEL_API_KEY=must-not-reach-provider",
        "UNRELATED_SECRET=must-not-reach-provider",
      ].join("\n"));
      await chmod(envFile, 0o600);

      let provisionedEnvironment: Readonly<Record<string, string>> | undefined;
      let startedEnvironment: Readonly<Record<string, string>> | undefined;
      await runLocalGitHubProvider({
        WORK_FABRIC_ENV_FILE: envFile,
        WORK_FABRIC_CONFIG: enabledConfig,
        WORK_FABRIC_RESOLVED_CONFIG: resolvedConfig,
        Path: process.env.PATH,
        SystemRoot: "C:\\Windows",
        HOME: process.env.HOME,
        NODE_OPTIONS: "--inspect=127.0.0.1:0",
        node_use_env_proxy: "1",
        HTTP_PROXY: "http://proxy.example.test:8080",
        http_proxy: "http://legacy-proxy.example.test:8080",
      }, {
        prepare: prepareLocalGitHubProviderEnvironment,
        provision: async (environment) => { provisionedEnvironment = environment; },
        start: async (environment) => { startedEnvironment = environment; },
      });

      expect(provisionedEnvironment).toMatchObject({
        WORK_FABRIC_ADMIN_TOKEN: "a".repeat(32),
        WORK_FABRIC_ENV_FILE: envFile,
        FEISHU_APP_SECRET: "must-not-reach-provider",
      });
      expect(startedEnvironment).toMatchObject({
        CUSTOM_GITHUB_APP_ID: "123",
        CUSTOM_GITHUB_INSTALLATION_ID: "456",
        CUSTOM_GITHUB_PRIVATE_KEY: "private-key",
        CUSTOM_GITHUB_FABRIC_TOKEN: "provider-token",
        CUSTOM_GITHUB_CURSOR_SECRET: "g".repeat(32),
        WORK_FABRIC_GITHUB_PROVIDER_CONFIG: resolvedConfig,
        WORK_FABRIC_GITHUB_PROVIDER_CONFIG_APPLICATION: "github-provider",
        Path: process.env.PATH,
        SystemRoot: "C:\\Windows",
        node_use_env_proxy: "1",
        HTTP_PROXY: "http://proxy.example.test:8080",
        http_proxy: "http://legacy-proxy.example.test:8080",
      });
      expect(startedEnvironment).not.toHaveProperty("WORK_FABRIC_ADMIN_TOKEN");
      expect(startedEnvironment).not.toHaveProperty("WORK_FABRIC_ENV_FILE");
      expect(startedEnvironment).not.toHaveProperty("FEISHU_APP_SECRET");
      expect(startedEnvironment).not.toHaveProperty("AGENTLY_MODEL_API_KEY");
      expect(startedEnvironment).not.toHaveProperty("UNRELATED_SECRET");
      expect(startedEnvironment).not.toHaveProperty("NODE_OPTIONS");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
