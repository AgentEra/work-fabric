import { cpus, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { MemoryClusterAdapter } from "@work-fabric/adapter-cluster-memory";
import {
  ClusterHost,
  PartitionWorker,
  TenantFairReadyQueue,
} from "@work-fabric/cluster-runtime";
import type {
  PartitionTurnHandler,
  PartitionWorkItem,
} from "@work-fabric/cluster-spi";
import { addUtcTimestampSeconds, type WorkerLease, type WorkerLeaseStore } from "@work-fabric/exchange-spi";

const timestamp = "2026-07-16T00:00:00.000Z";

class BenchmarkLeaseStore implements WorkerLeaseStore {
  private readonly leases = new Map<string, WorkerLease>();
  private readonly tokens = new Map<string, number>();

  async acquire(key: string, owner: string, now: string, seconds: number) {
    const current = this.leases.get(key);
    if (current !== undefined && current.expires_at > now && current.owner !== owner) return null;
    const token = (this.tokens.get(key) ?? 0) + 1;
    this.tokens.set(key, token);
    const lease = {
      lease_key: key, owner, fencing_token: token,
      expires_at: addUtcTimestampSeconds(now, seconds),
    };
    this.leases.set(key, lease);
    return structuredClone(lease);
  }

  async renew(key: string, owner: string, token: number, now: string, seconds: number) {
    const current = this.leases.get(key);
    if (current?.owner !== owner || current.fencing_token !== token || current.expires_at <= now) return false;
    this.leases.set(key, { ...current, expires_at: addUtcTimestampSeconds(now, seconds) });
    return true;
  }

  async release(key: string, owner: string, token: number) {
    const current = this.leases.get(key);
    if (current?.owner !== owner || current.fencing_token !== token) return false;
    this.leases.delete(key);
    return true;
  }
}

function items(partitions: number, tenants: number): readonly PartitionWorkItem[] {
  return Array.from({ length: partitions }, (_, index) => ({
    tenant_id: `tenant-${index % tenants}`,
    partition_id: `partition-${index}`,
    kind: "handoff_projection" as const,
    observed_position: index + 1,
    available_at: timestamp,
  }));
}

function percentile(values: readonly number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))] ?? 0;
}

function summary(values: readonly number[]) {
  return {
    p50_ms: Number(percentile(values, 0.50).toFixed(3)),
    p95_ms: Number(percentile(values, 0.95).toFixed(3)),
    p99_ms: Number(percentile(values, 0.99).toFixed(3)),
  };
}

function ratioSummary(values: readonly number[]) {
  return {
    p50_ratio: Number(percentile(values, 0.50).toFixed(3)),
    p95_ratio: Number(percentile(values, 0.95).toFixed(3)),
    p99_ratio: Number(percentile(values, 0.99).toFixed(3)),
  };
}

function bounded(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

async function settle(host: ClusterHost, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const snapshot = host.snapshot();
    if (snapshot.completed_turns === expected && snapshot.in_flight_turns === 0) return;
    await new Promise<void>((resolveReady) => setImmediate(resolveReady));
  }
  throw new Error("benchmark cluster host exceeded its bounded settle turns");
}

export interface ClusterBenchmarkOptions {
  readonly partitions: number;
  readonly tenants: number;
  readonly concurrency: number;
  readonly samples: number;
}

export async function runClusterBenchmark(candidate: ClusterBenchmarkOptions) {
  const options = {
    partitions: bounded(candidate.partitions, "partitions", 1, 1_000),
    tenants: bounded(candidate.tenants, "tenants", 1, 1_000),
    concurrency: bounded(candidate.concurrency, "concurrency", 1, 1_024),
    samples: bounded(candidate.samples, "samples", 1, 50),
  };
  if (options.tenants > options.partitions) throw new RangeError("tenants cannot exceed partitions");
  if (options.concurrency > options.partitions) throw new RangeError("concurrency cannot exceed partitions");
  const work = items(options.partitions, options.tenants);
  const catalogTimes: number[] = [];
  const leaseTimes: number[] = [];
  const turnTimes: number[] = [];
  const catchupTimes: number[] = [];
  const fairnessRatios: number[] = [];

  for (let sample = 0; sample < options.samples; sample += 1) {
    const adapter = new MemoryClusterAdapter(work);
    const catalogStarted = performance.now();
    for (let tenantIndex = 0; tenantIndex < options.tenants; tenantIndex += 1) {
      await adapter.scanReady({
        tenant_id: `tenant-${tenantIndex}`,
        kinds: ["handoff_projection"],
        available_at_or_before: timestamp,
        limit: Math.min(1_000, options.partitions),
      });
    }
    catalogTimes.push(performance.now() - catalogStarted);

    const leaseStore = new BenchmarkLeaseStore();
    const leaseStarted = performance.now();
    for (let index = 0; index < options.partitions; index += 1) {
      const lease = await leaseStore.acquire(`lease-${sample}-${index}`, "benchmark", timestamp, 10);
      if (lease === null) throw new Error("benchmark lease unexpectedly unavailable");
      await leaseStore.release(lease.lease_key, lease.owner, lease.fencing_token);
    }
    leaseTimes.push(performance.now() - leaseStarted);

    const handler: PartitionTurnHandler = {
      kind: "handoff_projection",
      async run(context) {
        await context.assertOwnership();
        return { outcome: "advanced", processed: 1 };
      },
    };
    const worker = new PartitionWorker({
      owner: `benchmark-worker-${sample}`,
      clock: { now: () => timestamp },
      lease_store_for_tenant: () => leaseStore,
      handlers: [handler],
      lease_seconds: 10,
      turn_item_limit: 1,
    });
    const turnStarted = performance.now();
    for (const item of work) {
      await worker.run(item, new AbortController().signal);
    }
    turnTimes.push(performance.now() - turnStarted);

    const host = new ClusterHost({
      catalog: adapter,
      tenant_ids: Array.from({ length: options.tenants }, (_, index) => `tenant-${index}`),
      worker,
      clock: { now: () => timestamp },
    }, {
      max_concurrent_turns: options.concurrency,
      max_ready_items: options.partitions,
      catalog_page_size: Math.min(1_000, options.partitions),
      turn_item_limit: 1,
      lease_seconds: 10,
      drain_timeout_seconds: 5,
      poll_interval_ms: 100,
      max_tenants_per_host: options.tenants,
    });
    const catchupStarted = performance.now();
    await host.pollOnce();
    await host.pump();
    await settle(host, options.partitions);
    catchupTimes.push(performance.now() - catchupStarted);
    await host.drain();

    const queue = new TenantFairReadyQueue(options.partitions);
    for (const item of work) queue.offer(item);
    const counts = new Map<string, number>();
    while (queue.size > 0) {
      const next = queue.take();
      if (next === null) break;
      counts.set(next.tenant_id, (counts.get(next.tenant_id) ?? 0) + 1);
    }
    const served = [...counts.values()];
    const minimum = Math.min(...served);
    const maximum = Math.max(...served);
    fairnessRatios.push(maximum / Math.max(1, minimum));
  }

  const catchup = summary(catchupTimes);
  return {
    environment: {
      node: process.version,
      platform: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model ?? "unknown",
      cpu_count: cpus().length,
      memory_bytes: totalmem(),
    },
    configuration: options,
    catalog_scan: summary(catalogTimes),
    lease_cycle: summary(leaseTimes),
    partition_turns: summary(turnTimes),
    catch_up: {
      ...catchup,
      p50_partitions_per_second: Number((options.partitions / Math.max(catchup.p50_ms, 0.001) * 1_000).toFixed(1)),
    },
    tenant_fairness: {
      ...ratioSummary(fairnessRatios),
      max_service_ratio: Number(Math.max(...fairnessRatios).toFixed(3)),
    },
  };
}

function argument(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : Number(process.argv[index + 1]);
}

const invoked = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) {
  const report = await runClusterBenchmark({
    partitions: argument("partitions", 100),
    tenants: argument("tenants", 4),
    concurrency: argument("concurrency", 8),
    samples: argument("samples", 3),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
