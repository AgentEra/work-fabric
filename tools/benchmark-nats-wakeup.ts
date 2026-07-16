import { randomBytes } from "node:crypto";
import { cpus, platform, release } from "node:os";
import { performance } from "node:perf_hooks";

import { jetstreamManager } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  HmacWakeupSubjectCodec,
  NatsJetStreamTopologyPort,
  createNatsWakeupAdapter,
  desiredNatsWakeupTopology,
  reconcileNatsWakeupTopology,
  type NatsWakeupAdapter,
} from "@work-fabric/adapter-cluster-nats";
import type { PartitionWakeup, WakeupDelivery } from "@work-fabric/cluster-spi";

export interface NatsWakeupBenchmarkOptions {
  readonly messages: number;
  readonly publishers: number;
  readonly consumers: number;
  readonly samples: number;
}

interface SampleResult {
  readonly publish_ms: readonly number[];
  readonly consume_to_ack_ms: readonly number[];
  readonly elapsed_seconds: number;
  readonly duplicate_deliveries: number;
}

function bounded(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${field} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function normalizeNatsWakeupBenchmarkOptions(
  input: Partial<NatsWakeupBenchmarkOptions>,
): NatsWakeupBenchmarkOptions {
  const messages = bounded(input.messages ?? 1_000, "messages", 1, 100_000);
  const publishers = bounded(input.publishers ?? 4, "publishers", 1, 64);
  const consumers = bounded(input.consumers ?? 4, "consumers", 1, 64);
  const samples = bounded(input.samples ?? 3, "samples", 1, 20);
  if (publishers > messages || consumers > messages) {
    throw new RangeError("publishers and consumers cannot exceed messages");
  }
  return { messages, publishers, consumers, samples };
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function summary(values: readonly number[]): {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
} {
  return {
    p50: Number(percentile(values, 0.5).toFixed(3)),
    p95: Number(percentile(values, 0.95).toFixed(3)),
    p99: Number(percentile(values, 0.99).toFixed(3)),
  };
}

async function closeAll(
  adapters: readonly NatsWakeupAdapter[],
  connections: readonly NatsConnection[],
): Promise<void> {
  for (const adapter of adapters) await adapter.close().catch(() => undefined);
  for (const connection of connections) await connection.drain().catch(() => undefined);
}

async function sample(
  url: string,
  options: NatsWakeupBenchmarkOptions,
  sampleNumber: number,
): Promise<SampleResult> {
  const suffix = randomBytes(6).toString("hex");
  const prefix = `wf_bench_${suffix}.wakeup`;
  const stream = `WF_BENCH_${suffix.toUpperCase()}`;
  const consumer = `wf_bench_${suffix}`;
  const tenant = `tenant-${suffix}`;
  const key = randomBytes(32);
  const management = await connect({ servers: url });
  const manager = await jetstreamManager(management);
  const connections: NatsConnection[] = [];
  const publishers: NatsWakeupAdapter[] = [];
  const consumers: NatsWakeupAdapter[] = [];
  try {
    const subjects = new HmacWakeupSubjectCodec({
      subject_prefix: prefix,
      subject_key_id: "key1",
      subject_key: key,
      allowed_tenant_ids: [tenant],
    });
    await reconcileNatsWakeupTopology(
      new NatsJetStreamTopologyPort(manager),
      desiredNatsWakeupTopology({
        stream,
        consumer,
        subject_prefix: prefix,
        filter_subjects: subjects.filterSubjects(),
        replicas: 1,
        max_ack_pending: Math.min(10_000, Math.max(1_024, options.messages)),
        max_waiting: Math.max(32, options.consumers),
      }),
      "apply",
    );
    const common = {
      stream,
      consumer,
      subject_prefix: prefix,
      subject_key_id: "key1",
      subject_key: key,
      allowed_tenant_ids: [tenant],
      config: {
        pull_expires_ms: 1_000,
        retry_delay_ms: 100,
        max_poison_per_pull: 10,
      },
    } as const;
    for (let index = 0; index < options.publishers + options.consumers; index += 1) {
      connections.push(await connect({ servers: url }));
    }
    for (let index = 0; index < options.publishers; index += 1) {
      const connection = connections[index];
      if (connection === undefined) throw new Error("publisher connection missing");
      publishers.push(await createNatsWakeupAdapter({ ...common, connection }));
    }
    for (let index = 0; index < options.consumers; index += 1) {
      const connection = connections[options.publishers + index];
      if (connection === undefined) throw new Error("consumer connection missing");
      consumers.push(await createNatsWakeupAdapter({ ...common, connection }));
    }

    const publishMs: number[] = [];
    let publishIndex = 0;
    const publishWorker = async (adapter: NatsWakeupAdapter): Promise<void> => {
      while (true) {
        const index = publishIndex;
        publishIndex += 1;
        if (index >= options.messages) return;
        const wakeup: PartitionWakeup = {
          wakeup_id: `s${sampleNumber}-w${index}`,
          exchange_id: `exchange-${suffix}`,
          tenant_id: tenant,
          partition_id: `partition-${index}`,
          kind: "handoff_projection",
          observed_position: index + 1,
          occurred_at: "2026-07-16T00:00:00.000Z",
        };
        const started = performance.now();
        const outcome = await adapter.publish(wakeup);
        publishMs.push(performance.now() - started);
        if (outcome !== "accepted") throw new Error("benchmark publish failed");
      }
    };
    await Promise.all(publishers.map(publishWorker));

    const consumeMs: number[] = [];
    const seen = new Set<string>();
    let duplicateDeliveries = 0;
    let attempts = 0;
    const consumeStarted = performance.now();
    const deadline = consumeStarted + 60_000;
    const completed = new AbortController();
    const consumeWorker = async (adapter: NatsWakeupAdapter): Promise<void> => {
      while (seen.size < options.messages) {
        attempts += 1;
        if (attempts > options.messages * 2 + options.consumers * 2 || performance.now() > deadline) {
          throw new Error("benchmark consumption bound exceeded");
        }
        const started = performance.now();
        let delivery: WakeupDelivery | null;
        try {
          delivery = await adapter.next(completed.signal);
        } catch (error) {
          if (completed.signal.aborted) return;
          throw error;
        }
        if (delivery === null) continue;
        await delivery.acknowledge();
        consumeMs.push(performance.now() - started);
        if (seen.has(delivery.wakeup.wakeup_id)) duplicateDeliveries += 1;
        else {
          seen.add(delivery.wakeup.wakeup_id);
          if (seen.size === options.messages) {
            completed.abort(new Error("benchmark sample complete"));
          }
        }
      }
    };
    await Promise.all(consumers.map(consumeWorker));
    return {
      publish_ms: publishMs,
      consume_to_ack_ms: consumeMs,
      elapsed_seconds: (performance.now() - consumeStarted) / 1_000,
      duplicate_deliveries: duplicateDeliveries,
    };
  } finally {
    await closeAll([...publishers, ...consumers], connections);
    try { await manager.consumers.delete(stream, consumer); } catch { /* exact benchmark resource */ }
    try { await manager.streams.delete(stream); } catch { /* exact benchmark resource */ }
    await management.drain().catch(() => undefined);
  }
}

export async function benchmarkNatsWakeup(
  url: string,
  input: Partial<NatsWakeupBenchmarkOptions>,
): Promise<Record<string, unknown>> {
  if (url.length === 0) throw new TypeError("NATS_TEST_URL is required");
  const options = normalizeNatsWakeupBenchmarkOptions(input);
  const results: SampleResult[] = [];
  for (let index = 0; index < options.samples; index += 1) {
    results.push(await sample(url, options, index));
  }
  const publish = results.flatMap((result) => result.publish_ms);
  const consume = results.flatMap((result) => result.consume_to_ack_ms);
  const duplicates = results.reduce(
    (total, result) => total + result.duplicate_deliveries,
    0,
  );
  const throughput = results.map(
    (result) => options.messages / result.elapsed_seconds,
  );
  return {
    scope: "internal_metadata_wakeup_transport_only",
    environment: {
      node: process.version,
      os: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model ?? "unknown",
      nats_server: "2.12.1",
      nats_client: "3.1.0",
    },
    configuration: options,
    puback_ms: summary(publish),
    consume_to_ack_ms: summary(consume),
    throughput_messages_per_second: summary(throughput),
    duplicate_ratio: Number((duplicates / consume.length).toFixed(6)),
    redelivery_count: duplicates,
  };
}

function argument(argv: readonly string[], name: string): number | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = Number(argv[index + 1]);
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const url = process.env.NATS_TEST_URL;
  if (url === undefined) {
    process.stderr.write("NATS_TEST_URL is required\n");
    process.exitCode = 2;
  } else {
    const messages = argument(argv, "--messages");
    const publishers = argument(argv, "--publishers");
    const consumers = argument(argv, "--consumers");
    const samples = argument(argv, "--samples");
    benchmarkNatsWakeup(url, {
      ...(messages === undefined ? {} : { messages }),
      ...(publishers === undefined ? {} : { publishers }),
      ...(consumers === undefined ? {} : { consumers }),
      ...(samples === undefined ? {} : { samples }),
    }).then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }).catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "benchmark failed"}\n`);
      process.exitCode = 1;
    });
  }
}
