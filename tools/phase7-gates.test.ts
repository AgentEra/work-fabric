import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkFederationBoundaries } from "./check-federation-boundaries.js";

const temporary: string[] = [];

async function fixture(path: string, source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "work-fabric-phase7-"));
  temporary.push(root);
  const target = join(root, path);
  await mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
  await writeFile(target, source, "utf8");
  return root;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("Phase 7 architecture gates", () => {
  it("keeps Federation outside Core, Cluster, HTTP and SDK", async () => {
    await expect(checkFederationBoundaries()).resolves.toMatchObject({
      source_files: expect.any(Number),
      federation_imports: expect.any(Number),
    });
    await expect(checkFederationBoundaries(await fixture(
      "packages/exchange-core/src/bad.ts",
      'import { FederationGateway } from "@work-fabric/federation-runtime";\n',
    ))).rejects.toThrow(/isolated boundary/);
  });

  it("rejects scheduling responsibility and sensitive labels", async () => {
    await expect(checkFederationBoundaries(await fixture(
      "packages/federation-runtime/src/bad.ts",
      "export const role = 'target selection and model inference';\n",
    ))).rejects.toThrow(/scheduling or execution/);
    await expect(checkFederationBoundaries(await fixture(
      "packages/federation-runtime/src/telemetry.ts",
      "observeFederation({ transfer_id: value });\n",
    ))).rejects.toThrow(/identity or content/);
  });
});
