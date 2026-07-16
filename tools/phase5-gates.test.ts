import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkConsoleBoundaries } from "./check-console-boundaries.js";
import { checkSensitiveObservability } from "./check-sensitive-observability.js";
import { runOperabilityBenchmark } from "./benchmark-operability.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("Phase 5 static gates", () => {
  it("accepts the repository Console and semantic telemetry boundaries", async () => {
    await expect(checkConsoleBoundaries()).resolves.toMatchObject({ source_files: expect.any(Number) });
    await expect(checkSensitiveObservability()).resolves.toMatchObject({ observation_calls: expect.any(Number) });
  });

  it("rejects a Console SDK bypass", async () => {
    const root = await mkdtemp(join(tmpdir(), "work-fabric-console-gate-"));
    cleanup.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "bad.ts"), "fetch('/v1/responsibilities')\n");
    await expect(checkConsoleBoundaries(root)).rejects.toThrow(/bypasses the SDK/);
  });

  it("runs a bounded generated-data benchmark smoke", async () => {
    const report = await runOperabilityBenchmark({ records: 10, samples: 2 });
    expect(report.projection_catchup.p50_events_per_second).toBeGreaterThan(0);
    expect(report.responsibility_read.p95_ms).toBeGreaterThanOrEqual(0);
    await expect(runOperabilityBenchmark({ records: 0, samples: 1 })).rejects.toThrow();
  });
});
