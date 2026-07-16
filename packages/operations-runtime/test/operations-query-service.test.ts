import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createOpaqueCursorCodec,
  type CursorAuthenticator,
  type BoundedOperationalHistoryStore,
} from "@work-fabric/operations-spi";

import { StoreBackedOperationsQueryService } from "../src/index.js";

function cursor() {
  const signature = (payload: string) =>
    createHmac("sha256", "operations-query-test").update(payload).digest("base64url");
  const authenticator: CursorAuthenticator = {
    async sign(payload) { return signature(payload); },
    async verify(payload, value) { return signature(payload) === value; },
  };
  return createOpaqueCursorCodec(authenticator, { max_length: 2048 });
}

function ingressRecord() {
  return {
    ingress_id: "ingress-1",
    envelope: {
      tenant_id: "tenant-1", connector_id: "connector-1",
      source_system: "feishu", external_tenant_id: "external-tenant",
      external_event_id: "external-event-1", dedupe_key: "dedupe-1",
      event_type: "document.updated", occurred_at: "2026-07-16T01:00:00.000Z",
      received_at: "2026-07-16T01:00:01.000Z",
      payload: { password: "must-not-leak" },
      trace_context: { authorization: "must-not-leak" },
    },
    state: "retry_wait" as const, attempt: 2,
    available_at: "2026-07-16T02:00:00.000Z",
    accepted_at: "2026-07-16T01:00:01.000Z",
    updated_at: "2026-07-16T01:30:00.000Z",
    last_error_code: "remote_unavailable",
    last_error_detail: "Bearer must-not-leak",
    last_requeue_reason: "contains secret",
  };
}

function fixture(boundedHistory?: BoundedOperationalHistoryStore) {
  const failures = [
    {
      projector_id: "projector-1", partition_id: "partition-1", event_id: "event-1",
      position: 9, reason: "Bearer secret failure detail",
      recorded_at: "2026-07-16T02:00:00.000Z",
    },
    {
      projector_id: "projector-1", partition_id: "partition-1", event_id: "event-2",
      position: 10, reason: "database password leaked",
      recorded_at: "2026-07-16T03:00:00.000Z",
    },
  ];
  const service = new StoreBackedOperationsQueryService({
    journal_positions: {
      async load(tenantId: string, partitionId: string) {
        return tenantId === "tenant-1" && partitionId === "partition-1" ? 10 : null;
      },
    },
    checkpoints: {
      async loadProjectionCheckpoint() { return 8; },
      async advanceProjectionCheckpoint() { return true; },
      async resetProjectionCheckpoint() {},
    },
    projection_failures: {
      async putProjectionFailure() {},
      async listProjectionFailures() { return structuredClone(failures); },
    },
    subscriptions: {
      manifest: { profile: "test", adapter: "test", capabilities: {} },
      async getSubscription(id: string) {
        return id === "subscription-1" ? {
          subscription_id: id, tenant_id: "tenant-1",
          owner: { actor_id: "actor-1", actor_type: "agent" as const },
          endpoint_id: "endpoint-1",
          filter: { event_types: [], actor_ids: [], endpoint_ids: [], thread_ids: [], handoff_ids: [], work_reference_uris: [], capability_ids: [], lifecycle_states: [] },
          destination: {
            destination_id: "destination-1",
            binding: "cursor_pull",
            configuration: {},
          },
          delivery_mode: "cursor_pull" as const,
          state: "active" as const, max_attempts: 3,
          created_at: "2026-07-16T00:00:00.000Z", updated_at: "2026-07-16T00:00:00.000Z",
        } : null;
      },
      async listActiveSubscriptions() { return []; },
      async putSubscription() {},
    },
    delivery_state: {
      async loadDeliveryPosition() { return 7; },
      async listDeliveryAttempts() {
        return [{
          subscription_id: "subscription-1", partition_id: "partition-1",
          event_id: "event-1", attempt: 1,
          attempted_at: "2026-07-16T02:00:00.000Z",
          outcome: "retryable_failure" as const,
          detail: "Authorization Bearer secret", next_attempt_at: "2026-07-16T02:01:00.000Z",
        }];
      },
      async listDeadLetters() {
        return [{
          subscription_id: "subscription-1", attempts: 3,
          reason: "password in downstream body", recorded_at: "2026-07-16T03:00:00.000Z",
          event: {
            tenant_id: "tenant-1", partition_id: "partition-1", partition_position: 7,
            stream_id: "handoff-1", stream_version: 1, commit_id: "commit-1", commit_ordinal: 0,
            event_id: "event-1", event_type: "workfabric.handoff.accepted.v1",
            schema_version: "1.0" as const, exchange_id: "exchange-1",
            request_message_id: "message-1", idempotency_key: "key-1",
            thread_id: "thread-1", handoff_id: "handoff-1", actor_id: "actor-1",
            endpoint_id: "endpoint-1", visibility: "tenant" as const,
            visible_actor_ids: [], visible_endpoint_ids: [],
            occurred_at: "2026-07-16T01:00:00.000Z",
            domain_data: { authorization: "secret-domain" },
            protocol_data: { result: "secret-result" },
          },
        }];
      },
      async getActiveDelivery() {
        return {
          delivery_id: "delivery-1", subscription_id: "subscription-1",
          partition_id: "partition-1", from_position: 5, to_position: 7,
          next_cursor: "secret-cursor", events: [], attempt: 2,
          delivered_at: "2026-07-16T02:00:00.000Z",
          visibility_expires_at: "2026-07-16T02:05:00.000Z", outcome: "pending" as const,
        };
      },
      async recordDeliveryAttempt() {}, async advanceDeliveryPosition() { return true; },
      async putDeadLetter() {}, async claimPendingDelivery() { throw new Error("not used"); },
      async getDelivery() { return null; }, async settleDelivery() { throw new Error("not used"); },
    },
    connector_ingress: {
      manifest: { profile: "connector.ingress.v1", adapter: "test", capabilities: {} },
      async list(input) {
        return input.tenant_id === "tenant-1" && input.connector_id === "connector-1"
          ? { items: [ingressRecord()] }
          : { items: [] };
      },
      async get(input) {
        return input.tenant_id === "tenant-1" &&
          input.connector_id === "connector-1" && input.ingress_id === "ingress-1"
          ? ingressRecord()
          : null;
      },
      async accept() { throw new Error("not used"); }, async claim() { return []; },
      async renew() { throw new Error("not used"); }, async complete() { throw new Error("not used"); },
      async retry() { throw new Error("not used"); }, async deadLetter() { throw new Error("not used"); },
      async requeue() { throw new Error("not used"); },
    },
    discrepancies: {
      async get(tenantId: string, discrepancyId: string) {
        return tenantId === "tenant-1" && discrepancyId === "discrepancy-1"
          ? {
              discrepancy_id: discrepancyId, tenant_id: tenantId, connector_id: "connector-1",
              external_object_id: "external-object-1", resource_id: "handoff-1",
              expected_state: "accepted", expected_version: 2, observed_state: "declined",
              observed_at: "2026-07-16T02:00:00.000Z", metadata: { note: "private-content" },
              status: "acknowledged" as const, version: 2,
              acknowledged_at: "2026-07-16T03:00:00.000Z",
              acknowledged_by: "principal-1", acknowledgement_reason: "private-reason",
            }
          : null;
      },
      async list(input: { tenant_id: string }) {
        const item = await this.get(input.tenant_id, "discrepancy-1");
        return { items: item === null ? [] : [item], next_cursor: null };
      },
      async put() {}, async acknowledge() { return { kind: "not_found" as const }; },
    },
    cursor: cursor(),
    cluster_snapshot: {
      async load() {
        return {
          state: "running" as const,
          ready_items: 3,
          in_flight_turns: 2,
          completed_turns: 9,
          lease_losses: 1,
          dropped_wakeups: 4,
          observed_at: "2026-07-16T08:00:00.000Z",
        };
      },
    },
    max_page_limit: 10,
    ...(boundedHistory === undefined ? {} : { bounded_history: boundedHistory }),
  });
  return service;
}

describe("StoreBackedOperationsQueryService", () => {
  it("returns only aggregate cluster metadata", async () => {
    await expect(fixture().getClusterSnapshot("tenant-1")).resolves.toEqual({
      state: "running",
      ready_items: 3,
      in_flight_turns: 2,
      completed_turns: 9,
      lease_losses: 1,
      dropped_wakeups: 4,
      observed_at: "2026-07-16T08:00:00.000Z",
    });
  });
  it("pushes bounded keyset pages into production history adapters", async () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    const history: BoundedOperationalHistoryStore = {
      manifest: { profile: "workfabric.operational-history.v1", adapter: "test", capabilities: { bounded_keyset: true } },
      async scanProjectionFailures(input) { calls.push({ method: "projection", input }); return []; },
      async scanDeliveryAttempts(input) { calls.push({ method: "attempt", input }); return []; },
      async scanDeadLetters(input) { calls.push({ method: "dead-letter", input }); return []; },
    };
    const service = fixture(history);
    await service.listProjectionFailures("tenant-1", { projector_id: "projector-1", partition_id: "partition-1", limit: 1 });
    await service.listDeliveryAttempts("tenant-1", { subscription_id: "subscription-1", event_id: "event-1", limit: 2 });
    await service.listDeadLetters("tenant-1", { subscription_id: "subscription-1", limit: 3 });
    expect(calls).toEqual([
      { method: "projection", input: { tenant_id: "tenant-1", projector_id: "projector-1", partition_id: "partition-1", after: null, limit: 2 } },
      { method: "attempt", input: { tenant_id: "tenant-1", subscription_id: "subscription-1", event_id: "event-1", after: null, limit: 3 } },
      { method: "dead-letter", input: { tenant_id: "tenant-1", subscription_id: "subscription-1", after: null, limit: 4 } },
    ]);
  });

  it("reports tenant-scoped projection position and redacts failure reasons", async () => {
    const service = fixture();
    await expect(service.getProjectionStatus("tenant-1", "projector-1", "partition-1"))
      .resolves.toEqual({
        tenant_id: "tenant-1", projector_id: "projector-1", partition_id: "partition-1",
        checkpoint_position: 8, journal_position: 10, lag: 2, state: "lagging",
      });
    await expect(service.getProjectionStatus("tenant-2", "projector-1", "partition-1"))
      .resolves.toBeNull();

    const first = await service.listProjectionFailures("tenant-1", {
      projector_id: "projector-1", partition_id: "partition-1", limit: 1,
    });
    expect(first.items).toEqual([{
      projector_id: "projector-1", partition_id: "partition-1", event_id: "event-1",
      position: 9, reason_code: "projection_failed",
      recorded_at: "2026-07-16T02:00:00.000Z",
    }]);
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = await service.listProjectionFailures("tenant-1", {
      projector_id: "projector-1", partition_id: "partition-1",
      cursor: first.next_cursor as string, limit: 1,
    });
    expect(second.items.map((item) => item.event_id)).toEqual(["event-2"]);
    expect(JSON.stringify([first, second])).not.toMatch(/Bearer|password|secret/i);
  });

  it("returns delivery metadata without payloads, cursor material, or failure detail", async () => {
    const service = fixture();
    const position = await service.getDeliveryState(
      "tenant-1", "subscription-1", "partition-1",
    );
    expect(position).toMatchObject({
      subscription_id: "subscription-1", partition_id: "partition-1", position: 7,
      active_delivery: { delivery_id: "delivery-1", attempt: 2, outcome: "pending" },
    });
    const attempts = await service.listDeliveryAttempts("tenant-1", {
      subscription_id: "subscription-1", event_id: "event-1", limit: 10,
    });
    const deadLetters = await service.listDeadLetters("tenant-1", {
      subscription_id: "subscription-1", limit: 10,
    });
    expect(attempts.items[0]).not.toHaveProperty("detail");
    expect(deadLetters.items[0]).toEqual({
      subscription_id: "subscription-1", partition_id: "partition-1",
      event_id: "event-1", event_type: "workfabric.handoff.accepted.v1",
      partition_position: 7, handoff_id: "handoff-1", thread_id: "thread-1",
      attempts: 3, reason_code: "delivery_dead_letter",
      recorded_at: "2026-07-16T03:00:00.000Z",
    });
    expect(JSON.stringify({ position, attempts, deadLetters })).not.toMatch(
      /secret|password|authorization/i,
    );
    await expect(service.getDeliveryState("tenant-2", "subscription-1", "partition-1"))
      .resolves.toBeNull();
  });

  it("exposes connector and discrepancy lifecycle without envelopes or metadata", async () => {
    const service = fixture();
    const ingress = await service.listConnectorIngress("tenant-1", {
      connector_id: "connector-1", states: ["retry_wait"], limit: 10,
    });
    expect(ingress.items).toEqual([{
      tenant_id: "tenant-1", connector_id: "connector-1", ingress_id: "ingress-1",
      source_system: "feishu", external_event_id: "external-event-1",
      event_type: "document.updated", state: "retry_wait", attempt: 2,
      available_at: "2026-07-16T02:00:00.000Z",
      accepted_at: "2026-07-16T01:00:01.000Z",
      updated_at: "2026-07-16T01:30:00.000Z", completed_at: null,
      last_error_code: "remote_unavailable", last_requeued_at: null,
    }]);
    const discrepancy = await service.getDiscrepancy("tenant-1", "discrepancy-1");
    expect(discrepancy).toEqual({
      discrepancy_id: "discrepancy-1", tenant_id: "tenant-1", connector_id: "connector-1",
      external_object_id: "external-object-1", resource_id: "handoff-1",
      expected_state: "accepted", expected_version: 2, observed_state: "declined",
      observed_at: "2026-07-16T02:00:00.000Z", status: "acknowledged", version: 2,
      acknowledged_at: "2026-07-16T03:00:00.000Z", acknowledged_by: "principal-1",
    });
    expect(JSON.stringify({ ingress, discrepancy })).not.toMatch(
      /must-not-leak|private-content|private-reason|payload|trace_context/i,
    );
    await expect(service.getConnectorIngress(
      "tenant-2", "connector-1", "ingress-1",
    )).resolves.toBeNull();
  });
});
