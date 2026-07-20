import { describe, expect, it } from "vitest";

import { MemoryConnectorIngressStore } from "@work-fabric/adapter-connector-memory";
import { ConnectorIngressStoreError } from "@work-fabric/connector-spi";
import type {
  ConnectorCommandResult,
  ConnectorAcceptedReceiptHandler,
  ConnectorCommandSink,
  ConnectorEventMapper,
  ConnectorIngressEnvelope,
  ConnectorIngressStore,
  ConnectorMappingOutcome,
  ConnectorObservationSink,
} from "@work-fabric/connector-spi";
import type { SemanticObservation, SemanticTelemetryObserver } from "@work-fabric/operations-spi";

import {
  ConnectorWorker,
  RetryableConnectorError,
  type ConnectorWorkerClock,
} from "../src/index.js";

const manifest = (profile: string) => ({
  profile,
  adapter: "test",
  capabilities: {},
});

const envelope = (
  dedupeKey: string,
  receivedAt = "2026-07-15T00:00:00Z",
): ConnectorIngressEnvelope => ({
  tenant_id: "tenant-1",
  connector_id: "connector-1",
  source_system: "test-system",
  external_tenant_id: "external-tenant-1",
  external_event_id: `event-${dedupeKey}`,
  dedupe_key: dedupeKey,
  event_type: "test.event",
  occurred_at: receivedAt,
  received_at: receivedAt,
  payload: {},
});

class MutableClock implements ConnectorWorkerClock {
  constructor(public value: string) {}
  now(): string {
    return this.value;
  }
}

class QueueMapper implements ConnectorEventMapper {
  readonly manifest = manifest("connector.mapper.v1");
  readonly calls: string[] = [];
  constructor(private readonly outcomes: (ConnectorMappingOutcome | Error)[]) {}
  async map(claim: { readonly ingress_id: string }): Promise<ConnectorMappingOutcome> {
    this.calls.push(claim.ingress_id);
    const outcome = this.outcomes.shift();
    if (outcome === undefined) throw new Error("missing test outcome");
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

class QueueSink implements ConnectorCommandSink {
  readonly manifest = manifest("connector.command-sink.v1");
  readonly calls: string[] = [];
  constructor(private readonly results: ConnectorCommandResult[]) {}
  async execute(input: { readonly ingress_id: string }): Promise<ConnectorCommandResult> {
    this.calls.push(input.ingress_id);
    const result = this.results.shift();
    if (result === undefined) throw new Error("missing test result");
    return result;
  }
}

class AcceptObservationSink implements ConnectorObservationSink {
  readonly manifest = manifest("connector.observation-sink.v1");
  readonly calls: string[] = [];
  async record(input: { readonly ingress_id: string }) {
    this.calls.push(input.ingress_id);
    return {
      kind: "accepted" as const,
      receipt_id: `observation:${input.ingress_id}`,
      event_ids: [],
    };
  }
}

const acceptedCommand: ConnectorMappingOutcome = {
  kind: "command",
  command: {
    operation: "handoff.accept",
    idempotency_key: "connector:message-1",
    expected_version: 2,
    identity: { actor_id: "actor-1", actor_type: "human" },
    input: { handoff_id: "handoff-1" },
  },
};

function worker(
  store: ConnectorIngressStore,
  mapper: ConnectorEventMapper,
  sink: ConnectorCommandSink,
  clock: ConnectorWorkerClock,
  telemetry?: SemanticTelemetryObserver,
  receiptHandler?: ConnectorAcceptedReceiptHandler,
) {
  return new ConnectorWorker({
    store,
    mapper,
    command_sink: sink,
    observation_sink: new AcceptObservationSink(),
    clock,
    retry_policy: {
      nextAvailableAt: (_attempt, _errorCode, now) =>
        now === "2026-07-15T00:00:00Z"
          ? "2026-07-15T00:00:10Z"
          : "2026-07-15T00:00:20Z",
    },
    scope: {
      tenant_id: "tenant-1",
      connector_id: "connector-1",
      worker_id: "worker-1",
      lease_seconds: 30,
      batch_limit: 10,
      max_attempts: 2,
      max_error_detail_length: 80,
    },
    ...(telemetry === undefined ? {} : { telemetry }),
    ...(receiptHandler === undefined ? {} : { accepted_receipt_handler: receiptHandler }),
  });
}

class ReceiptHandler implements ConnectorAcceptedReceiptHandler {
  readonly manifest = manifest("connector.accepted-receipt.v1");
  readonly calls: string[] = [];
  readonly receipts: unknown[] = [];
  constructor(private readonly result: ConnectorCommandResult) {}
  async record(input: { readonly ingress_id: string }): Promise<ConnectorCommandResult> {
    this.calls.push(input.ingress_id);
    this.receipts.push(structuredClone(input));
    return this.result;
  }
}

describe("ConnectorWorker", () => {
  it("emits ingress outcomes as bounded semantics", async () => {
    const store = new MemoryConnectorIngressStore();
    await store.accept(envelope("telemetry"));
    const observed: SemanticObservation[] = [];
    const runtime = worker(
      store,
      new QueueMapper([acceptedCommand]),
      new QueueSink([{ kind: "accepted", receipt_id: "receipt-1", event_ids: [] }]),
      new MutableClock("2026-07-15T00:00:00Z"),
      { observe(value) { observed.push(value); } },
    );

    await runtime.runBatch();
    expect(observed).toMatchObject([{
      operation: "connector_mapping",
      outcome: "succeeded",
      category: "connector",
      count: 1,
    }]);
    expect(JSON.stringify(observed)).not.toContain("connector-1");
  });

  it("completes non-command mapping outcomes without invoking the sink", async () => {
    const store = new MemoryConnectorIngressStore();
    await store.accept(envelope("ignored"));
    await store.accept(envelope("reference", "2026-07-15T00:00:01Z"));
    await store.accept(envelope("observation", "2026-07-15T00:00:02Z"));
    const mapper = new QueueMapper([
      { kind: "ignored", reason_code: "not_configured" },
      {
        kind: "reference_observed",
        reference: {
          uri: "test://document/1",
          external_type: "document",
          metadata: {},
        },
      },
      {
        kind: "reconciliation_observation",
        observation: {
          external_object_id: "object-1",
          observed_state: "delivered",
          observed_at: "2026-07-15T00:00:02Z",
          metadata: {},
        },
      },
    ]);
    const sink = new QueueSink([]);
    const result = await worker(
      store,
      mapper,
      sink,
      new MutableClock("2026-07-15T00:00:03Z"),
    ).runBatch();

    expect(result).toEqual({
      claimed: 3,
      completed: 3,
      retried: 0,
      dead_lettered: 0,
      fenced: 0,
    });
    expect(sink.calls).toEqual([]);
  });

  it("submits an explicit command once and completes only after acceptance", async () => {
    const store = new MemoryConnectorIngressStore();
    const accepted = await store.accept(envelope("command"));
    const mapper = new QueueMapper([acceptedCommand]);
    const sink = new QueueSink([
      { kind: "accepted", receipt_id: "receipt-1", event_ids: ["event-1"] },
    ]);
    const result = await worker(
      store,
      mapper,
      sink,
      new MutableClock("2026-07-15T00:00:00Z"),
    ).runBatch();

    expect(result.completed).toBe(1);
    expect(sink.calls).toEqual([accepted.record.ingress_id]);
    expect((await store.get({
      tenant_id: "tenant-1",
      connector_id: "connector-1",
      ingress_id: accepted.record.ingress_id,
    }))?.state).toBe("completed");
  });

  it("records an accepted resource receipt before completing ingress", async () => {
    const store = new MemoryConnectorIngressStore();
    const accepted = await store.accept(envelope("offer-receipt"));
    const receipt = new ReceiptHandler({
      kind: "accepted", receipt_id: "route-ready", event_ids: [],
    });
    const runtime = worker(
      store,
      new QueueMapper([{ kind: "command", command: {
        operation: "handoff.offer", idempotency_key: "connector:message-1",
        identity: { actor_id: "actor-1", actor_type: "human" }, input: { work_reference: {} },
      } }]),
      new QueueSink([{
        kind: "accepted", receipt_id: "receipt-1", event_ids: [],
        resource: { resource_type: "handoff", resource_id: "handoff-new", resource_version: 1 },
      }]),
      new MutableClock("2026-07-15T00:00:00Z"),
      undefined,
      receipt,
    );

    await expect(runtime.runBatch()).resolves.toMatchObject({ completed: 1 });
    expect(receipt.calls).toEqual([accepted.record.ingress_id]);
  });

  it("whitelists the auditable receipt command and strips command authentication", async () => {
    const store = new MemoryConnectorIngressStore();
    await store.accept(envelope("authenticated-receipt"));
    const receipt = new ReceiptHandler({
      kind: "accepted", receipt_id: "route-ready", event_ids: [],
    });
    const grant = "representation-grant-must-not-persist";
    const command = {
      operation: "handoff.accept",
      idempotency_key: "connector:message-1",
      expected_version: 2,
      identity: { actor_id: "actor-1", actor_type: "human" as const, endpoint_id: "endpoint-1" },
      authentication: { kind: "bearer" as const, credential: grant },
      input: { handoff_id: "handoff-1", nested: { value: true } },
    };
    await worker(
      store,
      new QueueMapper([{ kind: "command", command }]),
      new QueueSink([{
        kind: "accepted",
        receipt_id: `receipt:${grant}`,
        event_ids: [`event:${grant}`],
        resource: {
          resource_type: "handoff",
          resource_id: `resource:${grant}`,
          resource_version: 1,
        },
      }]),
      new MutableClock("2026-07-15T00:00:00Z"),
      undefined,
      receipt,
    ).runBatch();

    expect(receipt.receipts).toHaveLength(1);
    expect(receipt.receipts[0]).toMatchObject({
      command: {
        operation: command.operation,
        idempotency_key: command.idempotency_key,
        expected_version: command.expected_version,
        identity: command.identity,
        input: command.input,
      },
    });
    const serialized = JSON.stringify(receipt.receipts[0]);
    expect(serialized).not.toContain("authentication");
    expect(serialized).not.toContain(grant);
  });

  it("retries ingress when accepted receipt provisioning is temporarily unavailable", async () => {
    const store = new MemoryConnectorIngressStore();
    await store.accept(envelope("receipt-retry"));
    const receipt = new ReceiptHandler({
      kind: "retryable_failure", error_code: "route_store_unavailable",
    });
    const runtime = worker(
      store,
      new QueueMapper([acceptedCommand]),
      new QueueSink([{ kind: "accepted", receipt_id: "receipt-1", event_ids: [] }]),
      new MutableClock("2026-07-15T00:00:00Z"),
      undefined,
      receipt,
    );
    await expect(runtime.runBatch()).resolves.toMatchObject({ retried: 1 });
  });

  it("schedules retryable outcomes and dead-letters the terminal attempt", async () => {
    const store = new MemoryConnectorIngressStore();
    const accepted = await store.accept(envelope("retry"));
    const mapper = new QueueMapper([acceptedCommand, acceptedCommand]);
    const sink = new QueueSink([
      { kind: "retryable_failure", error_code: "rate_limited", detail: "try later" },
      { kind: "retryable_failure", error_code: "rate_limited", detail: "still limited" },
    ]);
    const clock = new MutableClock("2026-07-15T00:00:00Z");
    const runtime = worker(store, mapper, sink, clock);

    expect(await runtime.runBatch()).toMatchObject({ retried: 1 });
    expect((await store.get({
      tenant_id: "tenant-1",
      connector_id: "connector-1",
      ingress_id: accepted.record.ingress_id,
    }))?.available_at).toBe("2026-07-15T00:00:10Z");
    clock.value = "2026-07-15T00:00:10Z";
    expect(await runtime.runBatch()).toMatchObject({ dead_lettered: 1 });
    expect((await store.get({
      tenant_id: "tenant-1",
      connector_id: "connector-1",
      ingress_id: accepted.record.ingress_id,
    }))?.state).toBe("dead_letter");
  });

  it("sanitizes mapper exceptions and respects explicit rejection permanence", async () => {
    const store = new MemoryConnectorIngressStore();
    const first = await store.accept(envelope("exception"));
    const second = await store.accept(envelope("rejected", "2026-07-15T00:00:01Z"));
    const mapper = new QueueMapper([
      new RetryableConnectorError(
        "mapper_unavailable",
        "sensitive detail ".repeat(20),
      ),
      { kind: "rejected", reason_code: "identity_unmapped", retryable: false },
    ]);
    const result = await worker(
      store,
      mapper,
      new QueueSink([]),
      new MutableClock("2026-07-15T00:00:02Z"),
    ).runBatch();

    expect(result).toMatchObject({ retried: 1, dead_lettered: 1 });
    const retried = await store.get({
      tenant_id: "tenant-1",
      connector_id: "connector-1",
      ingress_id: first.record.ingress_id,
    });
    expect(retried?.last_error_code).toBe("mapper_unavailable");
    expect(retried?.last_error_detail?.length).toBeLessThanOrEqual(80);
    expect((await store.get({
      tenant_id: "tenant-1",
      connector_id: "connector-1",
      ingress_id: second.record.ingress_id,
    }))?.last_error_code).toBe("identity_unmapped");
  });

  it("stops the batch after fencing loss without a second side effect", async () => {
    const base = new MemoryConnectorIngressStore();
    await base.accept(envelope("fenced-1"));
    await base.accept(envelope("fenced-2", "2026-07-15T00:00:01Z"));
    const store = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "complete") {
          return async () => {
            throw new ConnectorIngressStoreError(
              "claim_lost",
              "Connector ingress claim is stale or invalid",
            );
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ConnectorIngressStore;
    const mapper = new QueueMapper([acceptedCommand, acceptedCommand]);
    const sink = new QueueSink([
      { kind: "accepted", receipt_id: "receipt-1", event_ids: [] },
      { kind: "accepted", receipt_id: "receipt-2", event_ids: [] },
    ]);
    const observed: SemanticObservation[] = [];
    const result = await worker(
      store,
      mapper,
      sink,
      new MutableClock("2026-07-15T00:00:02Z"),
      { observe(value) { observed.push(value); } },
    ).runBatch();

    expect(result.fenced).toBe(1);
    expect(sink.calls).toHaveLength(1);
    expect(mapper.calls).toHaveLength(1);
    expect(observed.map(({ operation, outcome }) => ({ operation, outcome }))).toEqual([
      { operation: "connector_mapping", outcome: "conflicted" },
      { operation: "worker_lease_loss", outcome: "conflicted" },
    ]);
  });

  it("renews the fenced claim before a public side effect and aborts after expiry", async () => {
    const store = new MemoryConnectorIngressStore();
    await store.accept(envelope("expired-before-command"));
    const clock = new MutableClock("2026-07-15T00:00:00Z");
    const mapper: ConnectorEventMapper = {
      manifest: manifest("connector.mapper.v1"),
      async map() {
        clock.value = "2026-07-15T00:00:31Z";
        return acceptedCommand;
      },
    };
    const sink = new QueueSink([
      { kind: "accepted", receipt_id: "must-not-run", event_ids: [] },
    ]);

    await expect(worker(store, mapper, sink, clock).runBatch()).resolves.toMatchObject({
      fenced: 1,
      completed: 0,
    });
    expect(sink.calls).toEqual([]);
  });
});
