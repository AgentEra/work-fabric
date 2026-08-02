import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkDiscoveryBoundaries } from "./check-discovery-boundaries.js";

const temporary: string[] = [];

async function fixture(sources: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "work-fabric-discovery-boundary-"));
  temporary.push(root);
  for (const [repositoryPath, source] of Object.entries(sources)) {
    const target = join(root, repositoryPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source, "utf8");
  }
  return root;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("Participation Discovery architecture boundaries", () => {
  it("accepts the real repository", async () => {
    await expect(checkDiscoveryBoundaries()).resolves.toMatchObject({
      source_files: expect.any(Number),
      discovery_imports: expect.any(Number),
      responsibility_violations: 0,
      schema_violations: 0,
    });
  });

  it.each([
    "packages/exchange-core/src/leak.ts",
    "packages/exchange-runtime/src/leak.ts",
    "packages/federation-runtime/src/leak.ts",
    "packages/cluster-runtime/src/leak.ts",
    "packages/protocol-runtime/src/leak.ts",
  ])("rejects a Discovery import from isolated production code at %s", async (repositoryPath) => {
    await expect(checkDiscoveryBoundaries(await fixture({
      [repositoryPath]: 'import { DiscoveryGateway } from "@work-fabric/discovery-runtime";\n',
    }))).rejects.toThrow(repositoryPath);
  });

  it("rejects Discovery profile coupling in protocol schemas", async () => {
    await expect(checkDiscoveryBoundaries(await fixture({
      "protocol/schemas/v1/handoff/leak.schema.json": JSON.stringify({
        $ref: "workfabric.discovery.v1",
      }),
    }))).rejects.toThrow(/leak\.schema\.json/);
  });

  it.each([
    ["Fastify", 'import Fastify from "fastify";'],
    ["PostgreSQL", 'import pg from "pg";'],
    ["SQLite", 'import Database from "better-sqlite3";'],
    ["NATS", 'import { connect } from "nats";'],
    ["Agent runtime", 'import { AgentGateway } from "@work-fabric/agent-gateway";'],
    ["model runtime", 'import { infer } from "@vendor/model-runtime";'],
    ["tool runtime", 'import { executeTool } from "@vendor/tool-runtime";'],
  ])("rejects %s coupling from Discovery Runtime", async (_name, source) => {
    await expect(checkDiscoveryBoundaries(await fixture({
      "packages/discovery-runtime/src/leak.ts": `${source}\n`,
    }))).rejects.toThrow(/discovery-runtime\/src\/leak\.ts/);
  });

  it.each([
    "fencing_token",
    "heartbeat_sequence",
    "session_id",
    "tenant_id",
    "credential",
    "access_token",
    "private_key",
  ])("rejects cross-Exchange schema field %s", async (field) => {
    await expect(checkDiscoveryBoundaries(await fixture({
      "packages/discovery-spi/src/records.ts": `export interface Leak { readonly ${field}: string; }\n`,
    }))).rejects.toThrow(/records\.ts/);
  });

  it.each(["rank", "score", "recommend", "selectTarget", "invokeDiscovered"])(
    "rejects Discovery SDK responsibility %s",
    async (method) => {
      await expect(checkDiscoveryBoundaries(await fixture({
        "packages/sdk-typescript/src/discovery-client.ts": `export class DiscoveryClient { ${method}(): void {} }\n`,
      }))).rejects.toThrow(/discovery-client\.ts/);
    },
  );

  it("allows technology-neutral facts and explicit client queries", async () => {
    await expect(checkDiscoveryBoundaries(await fixture({
      "packages/discovery-spi/src/records.ts": [
        "export interface Record { readonly key_id: string; readonly signature: string; }",
      ].join("\n"),
      "packages/discovery-runtime/src/query.ts": [
        'import type { DiscoveryRecord } from "@work-fabric/discovery-spi";',
        "export const query = (record: DiscoveryRecord) => record;",
      ].join("\n"),
      "packages/sdk-typescript/src/discovery-client.ts": [
        "export class DiscoveryClient { findCapabilities(): void {} getEndpoint(): void {} }",
      ].join("\n"),
    }))).resolves.toMatchObject({
      responsibility_violations: 0,
      schema_violations: 0,
    });
  });

  it("ignores tests so negative fixtures do not self-trigger", async () => {
    await expect(checkDiscoveryBoundaries(await fixture({
      "packages/exchange-core/test/leak.test.ts": 'import "@work-fabric/discovery-runtime";',
      "packages/discovery-spi/test/schema.test.ts": "const tenant_id = 'fixture';",
    }))).resolves.toMatchObject({ schema_violations: 0 });
  });
});
