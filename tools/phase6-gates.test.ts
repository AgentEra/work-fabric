import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runClusterBenchmark } from "./benchmark-cluster-runtime.js";
import { checkClusterBoundaries } from "./check-cluster-boundaries.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(
  cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
));

async function fixture(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "work-fabric-cluster-gate-"));
  cleanup.push(root);
  await mkdir(join(root, "packages/cluster-spi/src"), { recursive: true });
  await mkdir(join(root, "packages/cluster-runtime/src"), { recursive: true });
  await writeFile(join(root, "packages/cluster-runtime/src/bad.ts"), source);
  await writeFile(join(root, "packages/cluster-spi/src/index.ts"), "export {};\n");
  return root;
}

describe("Phase 6A release gates", () => {
  it("accepts the repository cluster boundary", async () => {
    await expect(checkClusterBoundaries()).resolves.toMatchObject({
      source_files: expect.any(Number),
      imports: expect.any(Number),
    });
  });

  it("rejects deployment technology and participant execution coupling", async () => {
    await expect(checkClusterBoundaries(await fixture(
      'import postgres from "postgres";\nexport const role = "workflow scheduler";\n',
    ))).rejects.toThrow(/deployment technology|participant-execution/);
  });

  it("runs a bounded clustered runtime benchmark smoke", async () => {
    const report = await runClusterBenchmark({
      partitions: 12, tenants: 3, concurrency: 4, samples: 2,
    });
    expect(report.catch_up.p50_partitions_per_second).toBeGreaterThan(0);
    expect(report.tenant_fairness.max_service_ratio).toBe(1);
    expect(report.catalog_scan.p99_ms).toBeGreaterThanOrEqual(0);
    await expect(runClusterBenchmark({
      partitions: 0, tenants: 1, concurrency: 1, samples: 1,
    })).rejects.toThrow(/partitions/);
    await expect(runClusterBenchmark({
      partitions: 1_001, tenants: 1, concurrency: 1, samples: 1,
    })).rejects.toThrow(/partitions/);
    await expect(runClusterBenchmark({
      partitions: 2, tenants: 1, concurrency: 3, samples: 1,
    })).rejects.toThrow(/concurrency cannot exceed partitions/);
  });
});
