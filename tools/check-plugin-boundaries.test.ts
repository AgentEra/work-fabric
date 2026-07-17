import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkPluginBoundaries } from "./check-plugin-boundaries.js";

const temporary: string[] = [];

async function fixture(
  sources: Readonly<Record<string, string>>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "work-fabric-plugin-boundary-"));
  temporary.push(root);
  for (const [repositoryPath, source] of Object.entries(sources)) {
    const target = join(root, repositoryPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source, "utf8");
  }
  return root;
}

const allowedSdkImport = {
  "packages/adapter-feishu-long-connection-node/src/sdk-runtime.ts":
    'import * as lark from "@larksuiteoapi/node-sdk";\nexport { lark };\n',
};

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("configuration and collaboration-channel boundaries", () => {
  it("keeps the real repository free of isolated and execution responsibilities", async () => {
    await expect(checkPluginBoundaries()).resolves.toMatchObject({
      isolated_imports: 0,
      sdk_imports: 1,
      responsibility_violations: 0,
    });
  });

  it("allows the one production SDK import anywhere inside the Node Adapter", async () => {
    await expect(checkPluginBoundaries(await fixture(allowedSdkImport))).resolves.toMatchObject({
      sdk_imports: 1,
      responsibility_violations: 0,
    });
    await expect(checkPluginBoundaries(await fixture({
      "packages/adapter-feishu-long-connection-node/src/renamed-client.ts":
        allowedSdkImport["packages/adapter-feishu-long-connection-node/src/sdk-runtime.ts"],
    }))).resolves.toMatchObject({ sdk_imports: 1 });
  });

  it.each([
    "packages/plugin-channel-feishu/src/sdk-leak.ts",
    "packages/connector-feishu/src/sdk-leak.ts",
    "packages/connector-runtime/src/sdk-leak.ts",
    "packages/exchange-core/src/sdk-leak.ts",
  ])("rejects an SDK import at %s", async (repositoryPath) => {
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      [repositoryPath]: 'import { WSClient } from "@larksuiteoapi/node-sdk";\nexport { WSClient };\n',
    }))).rejects.toThrow(repositoryPath);
  });

  it("requires exactly one production SDK import", async () => {
    await expect(checkPluginBoundaries(await fixture({
      "packages/exchange-core/src/empty.ts": "export {};\n",
    }))).rejects.toThrow(/expected exactly one production Feishu SDK import, found 0/);
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      "packages/adapter-feishu-long-connection-node/src/second-client.ts":
        'import lark from "@larksuiteoapi/node-sdk";\nexport { lark };\n',
    }))).rejects.toThrow(/expected exactly one production Feishu SDK import, found 2/);
  });

  it("scans the Node Adapter for Agent-brain responsibilities", async () => {
    const repositoryPath = "packages/adapter-feishu-long-connection-node/src/agent-brain.ts";
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      [repositoryPath]: "export const responsibility = 'agent brain';\n",
    }))).rejects.toThrow(repositoryPath);
  });

  it.each([
    "packages/protocol-runtime/src/transport.ts",
    "packages/exchange-core/src/transport.ts",
    "packages/adapter-storage-memory/src/transport.ts",
    "packages/connector-runtime/src/transport.ts",
    "packages/transport-http/src/public-types.ts",
    "packages/sdk-typescript/src/protocol-types.ts",
  ])("rejects Feishu transport selection at %s", async (repositoryPath) => {
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      [repositoryPath]: [
        'const selected = input.feishu_transport;',
        'export const enabled = selected === "webhook" || selected === "long_connection";',
        "",
      ].join("\n"),
    }))).rejects.toThrow(repositoryPath);
  });

  it("rejects a Feishu-specific webhook conditional without a long-connection literal", async () => {
    const repositoryPath = "packages/connector-runtime/src/feishu-transport.ts";
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      [repositoryPath]: 'export const selected = input.feishu_transport === "webhook";\n',
    }))).rejects.toThrow(repositoryPath);
  });

  it("preserves generic HTTP webhook delivery behavior", async () => {
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      "packages/exchange-core/src/subscription-delivery.ts":
        'export const push = subscription.delivery_mode === "webhook";\n',
    }))).resolves.toMatchObject({ sdk_imports: 1 });
  });

  it("does not combine unrelated Feishu vocabulary with a generic webhook conditional", async () => {
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      "packages/transport-http/src/routes.ts": [
        "export const feishu = true;",
        `const padding = "${"x".repeat(300)}";`,
        'export const push = subscription.delivery_mode === "webhook";',
        "",
      ].join("\n"),
    }))).resolves.toMatchObject({ sdk_imports: 1 });
  });
});
