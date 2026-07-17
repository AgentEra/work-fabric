import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkPluginBoundaries,
  isProductionSourcePath,
} from "./check-plugin-boundaries.js";

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

  it("detects a static import whose local alias is the from keyword", async () => {
    const repositoryPath = "packages/connector-runtime/src/sdk-alias.ts";
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      [repositoryPath]:
        'import { WSClient as from } from "@larksuiteoapi/node-sdk";\nvoid from;\n',
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
      [repositoryPath]: "export function agentBrain(): void {}\n",
    }))).rejects.toThrow(repositoryPath);
  });

  it("ignores responsibility phrases in comments and ordinary strings", async () => {
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      "packages/adapter-feishu-long-connection-node/src/notes.ts": [
        "// function agentBrain() {}",
        'export const note = "model inference and target selection";',
        "",
      ].join("\n"),
    }))).resolves.toMatchObject({ responsibility_violations: 0 });
  });

  it.each([
    ["object property", 'export const handlers = { "agentBrain": () => {} };'],
    ["class method", 'export class Adapter { "agentBrain"(): void {} }'],
    ["class property", 'export class Adapter { "agentBrain" = (): void => {}; }'],
    [
      "element access",
      'declare const adapter: Record<string, () => void>; adapter["agentBrain"](); export { adapter };',
    ],
  ])("rejects an executable string-named responsibility %s", async (_name, source) => {
    const repositoryPath =
      "packages/adapter-feishu-long-connection-node/src/string-responsibility.ts";
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      [repositoryPath]: `${source}\n`,
    }))).rejects.toThrow(repositoryPath);
  });

  it("keeps exact responsibility vocabulary inert in ordinary string data", async () => {
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      "packages/adapter-feishu-long-connection-node/src/string-data.ts": [
        'export const labels = ["agentBrain", { label: "agentBrain" }];',
        "",
      ].join("\n"),
    }))).resolves.toMatchObject({ responsibility_violations: 0 });
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

  it("rejects a parenthesized Feishu-specific webhook selector", async () => {
    const repositoryPath = "packages/connector-runtime/src/feishu-transport.ts";
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      [repositoryPath]: 'export const selected = (input.feishu_transport) === "webhook";\n',
    }))).rejects.toThrow(repositoryPath);
  });

  it.each([
    [
      "parenthesized literal",
      'input.feishu_transport === ("webhook");',
    ],
    [
      "as-wrapped operands",
      '(input.feishu_transport as string) === ("webhook" as string);',
    ],
    [
      "reversed non-null selector",
      '"webhook" === (input.feishu_transport!);',
    ],
    [
      "satisfies-wrapped operands",
      '(input.feishu_transport satisfies string) === ("webhook" satisfies string);',
    ],
    [
      "type-asserted operands",
      '<string>input.feishu_transport === <string>"webhook";',
    ],
  ])("rejects %s in a Feishu webhook comparison", async (_name, source) => {
    const repositoryPath = "packages/connector-runtime/src/wrapped-transport.ts";
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      [repositoryPath]: `${source}\n`,
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
        "declare const feishuEnabled: boolean;",
        "declare const subscription: { delivery_mode: string };",
        'export const push = feishuEnabled && subscription.delivery_mode === "webhook";',
        "",
      ].join("\n"),
    }))).resolves.toMatchObject({ sdk_imports: 1 });
  });

  it("ignores transport conditionals in comments and ordinary strings", async () => {
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      "packages/exchange-core/src/notes.ts": [
        '// if (input.feishu_transport === "webhook") select();',
        'export const note = "transport === long_connection or websocket";',
        "",
      ].join("\n"),
    }))).resolves.toMatchObject({ sdk_imports: 1 });
  });

  it.each([
    ["Feishu webhook switch", 'switch (input.feishu_transport) { case "webhook": break; }'],
    ["long-connection comparison", 'input.transport === "long_connection";'],
    ["WebSocket switch", 'switch (input.transport) { case "websocket": break; }'],
  ])("rejects structural %s selection", async (_name, source) => {
    const repositoryPath = "packages/connector-runtime/src/transport.ts";
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      [repositoryPath]: `${source}\n`,
    }))).rejects.toThrow(repositoryPath);
  });

  it("finds a forbidden comparison inside an outer switch body", async () => {
    const repositoryPath = "packages/exchange-core/src/nested-transport.ts";
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      [repositoryPath]: [
        'switch (input.kind) { case "message":',
        '  input.feishu_transport === ("webhook");',
        "  break;",
        "}",
        "",
      ].join("\n"),
    }))).rejects.toThrow(repositoryPath);
  });

  it("finds forbidden cases in a nested switch", async () => {
    const repositoryPath = "packages/exchange-core/src/nested-switch.ts";
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      [repositoryPath]: [
        'switch (input.kind) { case "message":',
        '  switch (input.transport) { case "long_connection": break; }',
        "}",
        "",
      ].join("\n"),
    }))).rejects.toThrow(repositoryPath);
  });

  it("unwraps switch selectors and case literals", async () => {
    const repositoryPath = "packages/exchange-core/src/wrapped-switch.ts";
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      [repositoryPath]:
        'switch ((input.feishu_transport as string)) { case ("webhook" as string): break; }\n',
    }))).rejects.toThrow(repositoryPath);
  });

  it("allows a generic webhook switch despite unrelated Feishu identifiers", async () => {
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      "packages/transport-http/src/switch.ts": [
        "declare const feishuEnabled: boolean;",
        "declare const subscription: { delivery_mode: string };",
        'if (feishuEnabled) {} switch (subscription.delivery_mode) { case "webhook": break; }',
        "",
      ].join("\n"),
    }))).resolves.toMatchObject({ sdk_imports: 1 });
  });
});

describe("repository source discovery and import syntax", () => {
  it("scans production source outside packages", async () => {
    const repositoryPath = "tools/sdk-leak.ts";
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      [repositoryPath]: 'import lark from "@larksuiteoapi/node-sdk";\n',
    }))).rejects.toThrow(repositoryPath);
  });

  it.each([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"])(
    "scans production %s source",
    async (extension) => {
      const repositoryPath = `packages/connector-runtime/src/sdk-leak${extension}`;
      await expect(checkPluginBoundaries(await fixture({
        ...allowedSdkImport,
        [repositoryPath]: 'import lark from "@larksuiteoapi/node-sdk";\n',
      }))).rejects.toThrow(repositoryPath);
    },
  );

  it.each([
    ["normal import", 'import lark from "@larksuiteoapi/node-sdk";'],
    ["side-effect import", 'import "@larksuiteoapi/node-sdk";'],
    ["dynamic import", 'void import("@larksuiteoapi/node-sdk");'],
    ["CommonJS require", 'require("@larksuiteoapi/node-sdk");'],
    ["CommonJS module.require", 'module.require("@larksuiteoapi/node-sdk");'],
    ["CommonJS module element require", 'module["require"]("@larksuiteoapi/node-sdk");'],
  ])("detects a %s", async (_name, source) => {
    const repositoryPath = "packages/connector-runtime/src/sdk-leak.ts";
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      [repositoryPath]: `${source}\n`,
    }))).rejects.toThrow(repositoryPath);
  });

  it("ignores import-like comments and ordinary strings", async () => {
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      "tools/import-notes.ts": [
        '// import lark from "@larksuiteoapi/node-sdk";',
        'const normal = "import \\\"@larksuiteoapi/node-sdk\\\"";',
        'const dynamic = "import(\\\"@larksuiteoapi/node-sdk\\\")";',
        'const commonjs = "require(\\\"@larksuiteoapi/node-sdk\\\")";',
        "export { normal, dynamic, commonjs };",
        "",
      ].join("\n"),
    }))).resolves.toMatchObject({ sdk_imports: 1 });
  });

  it("does not treat unrelated require properties as CommonJS loading", async () => {
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      "tools/custom-loader.ts": [
        "declare const customLoader: { require(value: string): unknown };",
        'customLoader.require("@larksuiteoapi/node-sdk");',
        'export const note = "module.require(\\\"@larksuiteoapi/node-sdk\\\")";',
        "",
      ].join("\n"),
    }))).resolves.toMatchObject({ sdk_imports: 1 });
  });

  it("ignores import-like text inside a regular expression literal", async () => {
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      "tools/import-pattern.ts":
        'export const pattern = /import\\(\"@larksuiteoapi\\/node-sdk\"\\)|agentBrain|long_connection/;\n',
    }))).resolves.toMatchObject({ sdk_imports: 1, responsibility_violations: 0 });
  });

  it("ignores SDK require text in a regex after a control-statement parenthesis", async () => {
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      "tools/control-pattern.ts": [
        "declare const ready: boolean;",
        "declare const value: string;",
        'if (ready) /require\\(\"@larksuiteoapi\\/node-sdk\"\\)/.test(value);',
        "",
      ].join("\n"),
    }))).resolves.toMatchObject({ sdk_imports: 1 });
  });

  it("ignores responsibility text in a regex after a control-statement parenthesis", async () => {
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      "packages/adapter-feishu-long-connection-node/src/control-pattern.ts": [
        "declare const ready: boolean;",
        "declare const value: string;",
        "if (ready) /agentBrain/.test(value);",
        "",
      ].join("\n"),
    }))).resolves.toMatchObject({ responsibility_violations: 0 });
  });

  it.each([".tsx", ".jsx"])("ignores responsibility vocabulary in %s JSX text", async (extension) => {
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      [`packages/adapter-feishu-long-connection-node/src/view${extension}`]:
        "export const view = <div>agentBrain modelInference targetSelection</div>;\n",
    }))).resolves.toMatchObject({ responsibility_violations: 0 });
  });

  it.each([".tsx", ".jsx"])("still rejects executable responsibility identifiers in %s", async (extension) => {
    const repositoryPath = `packages/adapter-feishu-long-connection-node/src/execution${extension}`;
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      [repositoryPath]:
        "const agentBrain = (): void => {}; agentBrain(); export const view = <div />;\n",
    }))).rejects.toThrow(repositoryPath);
  });

  it("excludes standard test and generated directories", async () => {
    const leak = 'import lark from "@larksuiteoapi/node-sdk";\n';
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      "packages/example/test/sdk-leak.ts": leak,
      "packages/example/tests/sdk-leak.js": leak,
      "packages/example/__tests__/sdk-leak.mts": leak,
      "packages/example/src/sdk-leak.test.tsx": leak,
      "packages/example/src/sdk-leak.spec.cjs": leak,
      "packages/example/dist/sdk-leak.ts": leak,
      "packages/example/build/sdk-leak.js": leak,
      "packages/example/out/sdk-leak.mjs": leak,
      "examples/example/dist/sdk-leak.ts": leak,
      "examples/example/build/sdk-leak.js": leak,
      "examples/example/out/sdk-leak.mjs": leak,
      "node_modules/example/sdk-leak.ts": leak,
    }))).resolves.toMatchObject({ sdk_imports: 1 });
  });

  it("scans production source beneath a package vendor directory", async () => {
    const repositoryPath = "packages/example/vendor/sdk-leak.js";
    await expect(checkPluginBoundaries(await fixture({
      ...allowedSdkImport,
      [repositoryPath]: 'import lark from "@larksuiteoapi/node-sdk";\n',
    }))).rejects.toThrow(repositoryPath);
  });

  it.each(["vendor", "build", "dist"])(
    "scans production source beneath src/%s",
    async (directory) => {
      const repositoryPath = `packages/example/src/${directory}/sdk-leak.js`;
      await expect(checkPluginBoundaries(await fixture({
        ...allowedSdkImport,
        [repositoryPath]: 'import lark from "@larksuiteoapi/node-sdk";\n',
      }))).rejects.toThrow(repositoryPath);
    },
  );

  it("rejects source-directory symlinks instead of allowing a scan bypass", async () => {
    const root = await fixture(allowedSdkImport);
    await mkdir(join(root, "tools"), { recursive: true });
    await symlink(
      join(root, "packages/adapter-feishu-long-connection-node/src"),
      join(root, "tools/linked-source"),
      "dir",
    );
    await expect(checkPluginBoundaries(root)).rejects.toThrow("tools/linked-source");
  });

  it("classifies Windows-style test and production paths through the POSIX seam", () => {
    expect(isProductionSourcePath("packages\\connector-runtime\\tests\\sdk-leak.ts")).toBe(false);
    expect(isProductionSourcePath("packages\\connector-runtime\\src\\sdk-leak.spec.mjs")).toBe(false);
    expect(isProductionSourcePath("packages\\connector-runtime\\src\\sdk-runtime.js")).toBe(true);
  });
});
