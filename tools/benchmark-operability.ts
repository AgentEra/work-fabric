import { cpus, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { MemoryOperationsFixture } from "@work-fabric/adapter-operations-memory";
import { MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import { handoffEventToJson, type Clock, type HandoffEvent, type HandoffPackage } from "@work-fabric/exchange-core";
import { HandoffProjector, MemoryHandoffReadModelStore } from "@work-fabric/exchange-runtime";
import type { EventJournal, EventRecord } from "@work-fabric/exchange-spi";
import { CollaborationProjector } from "@work-fabric/operations-runtime";

const tenant = "tenant-benchmark";
const partition = "partition-benchmark";
const clock: Clock = { now: () => "2026-07-16T00:00:00.000Z" };
const initiator = { actor_id: "human-benchmark", actor_type: "human" as const };
const recipient = { actor_id: "agent-benchmark", actor_type: "agent" as const };

class StaticJournal implements EventJournal {
  constructor(private readonly records: readonly EventRecord[]) {}
  async readStream(streamId: string, fromVersion = 0) {
    return this.records.filter((record) => record.stream_id === streamId && record.stream_version >= fromVersion);
  }
  async readPartition(partitionId: string, after: number, limit: number) {
    return this.records.filter((record) => record.partition_id === partitionId && record.partition_position > after).slice(0, limit);
  }
}

function generatedRecords(count: number): readonly EventRecord[] {
  const handoffPackage: HandoffPackage = {
    work_reference: { uri: "urn:benchmark:work" }, target: { actor_id: recipient.actor_id },
    intent: [], context: null,
    authority_scope: { delegation_id: "delegation-benchmark", scopes: [], resource_refs: [], expires_at: "2026-07-20T00:00:00.000Z", may_redelegate: false },
    acceptance_criteria: [], verifier: initiator, priority: "normal",
    accept_by: "2026-07-17T00:00:00.000Z", result_due_at: "2026-07-19T00:00:00.000Z",
  };
  return Array.from({ length: count }, (_, index) => {
    const position = index + 1;
    const handoffId = `handoff-benchmark-${position}`;
    const event: HandoffEvent = {
      event_type: "workfabric.handoff.offered.v1", handoff_id: handoffId,
      thread_id: handoffId, initiator, package: handoffPackage,
      parent_handoff_id: null, occurred_at: "2026-07-16T00:00:00.000Z",
    };
    return {
      tenant_id: tenant, partition_id: partition, partition_position: position,
      stream_id: handoffId, stream_version: 1, commit_id: `commit-${position}`, commit_ordinal: 0,
      event_id: `event-${position}`, event_type: event.event_type, schema_version: "1.0",
      exchange_id: "exchange-benchmark", request_message_id: `message-${position}`,
      idempotency_key: `key-${position}`, thread_id: handoffId, handoff_id: handoffId,
      actor_id: initiator.actor_id, endpoint_id: "endpoint-benchmark", visibility: "tenant",
      visible_actor_ids: [], visible_endpoint_ids: [], occurred_at: event.occurred_at,
      domain_data: handoffEventToJson(event), protocol_data: { change_type: event.event_type },
    } satisfies EventRecord;
  });
}

function percentile(values: readonly number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))] ?? 0;
}

function summary(values: readonly number[]) {
  return {
    p50_ms: Number(percentile(values, 0.5).toFixed(3)),
    p95_ms: Number(percentile(values, 0.95).toFixed(3)),
  };
}

export interface BenchmarkOptions { readonly records: number; readonly samples: number }

export async function runOperabilityBenchmark(options: BenchmarkOptions) {
  if (!Number.isSafeInteger(options.records) || options.records < 1 || options.records > 100_000) throw new RangeError("records is outside its bound");
  if (!Number.isSafeInteger(options.samples) || options.samples < 1 || options.samples > 50) throw new RangeError("samples is outside its bound");
  const projection: number[] = [];
  const responsibilityRead: number[] = [];
  const auditAppend: number[] = [];
  const auditRead: number[] = [];
  for (let sample = 0; sample < options.samples; sample += 1) {
    const records = generatedRecords(options.records);
    const journal = new StaticJournal(records);
    const persistence = new MemoryExchangePersistence();
    const models = new MemoryHandoffReadModelStore();
    const operations = new MemoryOperationsFixture("benchmark-cursor-secret-0123456789");
    const handoffs = new HandoffProjector(journal, persistence, persistence, models, clock);
    const collaboration = new CollaborationProjector(journal, persistence, persistence, models, operations.collaboration, clock);
    const started = performance.now();
    await handoffs.runPartition(partition, options.records);
    await collaboration.runPartition(partition, options.records);
    projection.push(performance.now() - started);

    const readStarted = performance.now();
    await operations.collaboration.listResponsibilities({ tenant_id: tenant, partition_id: partition, limit: Math.min(100, options.records) });
    responsibilityRead.push(performance.now() - readStarted);

    const appendStarted = performance.now();
    for (let index = 0; index < options.records; index += 1) {
      await operations.audit.append({
        tenant_id: tenant, audit_id: `audit-${sample}-${index}`, occurred_at: `2026-07-16T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
        request_id: `request-${sample}-${index}`, trace_id: null, principal_id: "principal-benchmark",
        represented_actor: null, represented_endpoint_id: null, delegation_id: null,
        operation: "workfabric.query.responsibility.list.v1", resource_kind: "partition",
        resource_id: partition, authorization_decision: "allowed", outcome: "succeeded",
        reason_code: null, service_category: "http",
      });
    }
    auditAppend.push(performance.now() - appendStarted);
    const auditStarted = performance.now();
    await operations.audit.list({ tenant_id: tenant, limit: Math.min(100, options.records) });
    auditRead.push(performance.now() - auditStarted);
  }
  const projectionSummary = summary(projection);
  return {
    environment: { node: process.version, platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model ?? "unknown", cpu_count: cpus().length, memory_bytes: totalmem() },
    configuration: options,
    projection_catchup: { ...projectionSummary, p50_events_per_second: Number((options.records / Math.max(projectionSummary.p50_ms, 0.001) * 1_000).toFixed(1)) },
    responsibility_read: summary(responsibilityRead),
    audit_append_batch: summary(auditAppend),
    audit_read: summary(auditRead),
  };
}

function argument(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : Number(process.argv[index + 1]);
}

const invoked = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) {
  const report = await runOperabilityBenchmark({ records: argument("records", 1_000), samples: argument("samples", 5) });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
