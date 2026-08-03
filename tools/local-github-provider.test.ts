import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadNodeConfiguration } from "../packages/service-node/src/configuration-loader.js";
import { prepareLocalFeishuEnvironment } from "./local-feishu-common.js";
import { prepareLocalGitHubProviderEnvironment } from "./local-github-provider.js";

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
      expect(await readFile(configPath!, "utf8")).not.toContain(
        "${GITHUB_PROVIDER_ACCESS_TOKEN}",
      );
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("does not require Feishu application credentials before checking GitHub activation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "work-fabric-github-only-"));
    try {
      const envFile = join(directory, "github.env");
      await writeFile(envFile, [
        "FEISHU_EXTERNAL_TENANT_ID=tenant-external",
        "FEISHU_BOT_OPEN_ID=bot-open-id",
        "GITHUB_APP_ID=app-id",
        "GITHUB_APP_INSTALLATION_ID=installation-id",
        "GITHUB_APP_PRIVATE_KEY=private-key",
        "GITHUB_PROVIDER_ACCESS_TOKEN=provider-token",
        `WORK_FABRIC_GITHUB_CURSOR_SECRET=${"g".repeat(32)}`,
      ].join("\n"));

      await expect(prepareLocalGitHubProviderEnvironment({
        WORK_FABRIC_ENV_FILE: envFile,
        WORK_FABRIC_CONFIG: resolve("examples/config/local-feishu-assistant.bundle.yaml"),
        WORK_FABRIC_RESOLVED_CONFIG: join(directory, "resolved.yaml"),
      })).rejects.toThrow(/plugins\.instances/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
