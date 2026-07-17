import { describe, expect, it } from "vitest";

import {
  CONNECTOR_INGRESS_REQUIRED_CAPABILITIES,
  type ConnectorCommandSink,
  type ConnectorAcceptedReceiptHandler,
  type ConnectorEventMapper,
  type ConnectorIdentityResolver,
  type ConnectorIngressEnvelope,
  type ConnectorIngressState,
  type ConnectorIngressStore,
  type ConnectorMappingOutcome,
  type ConnectorResourceResolver,
} from "../src/index.js";

const envelope: ConnectorIngressEnvelope = {
  tenant_id: "tenant-1",
  connector_id: "feishu-primary",
  source_system: "feishu",
  external_tenant_id: "tenant-key-1",
  external_event_id: "event-1",
  dedupe_key: "message:om_123",
  event_type: "im.message.receive_v1",
  partition_key: "chat:oc_123",
  occurred_at: "2026-07-15T01:00:00.000Z",
  received_at: "2026-07-15T01:00:01.000Z",
  payload: { message_id: "om_123" },
  trace_context: { correlation_id: "correlation-1" },
};

describe("Connector SPI contracts", () => {
  it("publishes the durable ingress capability profile", () => {
    expect(CONNECTOR_INGRESS_REQUIRED_CAPABILITIES).toEqual([
      "atomic_deduplication",
      "tenant_isolation",
      "fenced_claims",
      "claim_renewal",
      "lease_recovery",
      "retry_scheduling",
      "dead_letter_requeue",
      "deterministic_pagination",
      "payload_isolation",
    ]);
  });

  it("keeps every lifecycle state explicit and closed", () => {
    const states = [
      "pending",
      "processing",
      "retry_wait",
      "completed",
      "dead_letter",
    ] as const satisfies readonly ConnectorIngressState[];
    expect(states).toHaveLength(5);
  });

  it("defines transport-neutral ports", () => {
    const compileOnly = <T>(_value: T): true => true;
    expect(compileOnly<ConnectorIngressStore>).toBeTypeOf("function");
    expect(compileOnly<ConnectorEventMapper>).toBeTypeOf("function");
    expect(compileOnly<ConnectorCommandSink>).toBeTypeOf("function");
    expect(compileOnly<ConnectorAcceptedReceiptHandler>).toBeTypeOf("function");
    expect(compileOnly<ConnectorIdentityResolver>).toBeTypeOf("function");
    expect(compileOnly<ConnectorResourceResolver>).toBeTypeOf("function");
  });

  it("represents all mapping outcomes without implying execution", () => {
    const outcomes: readonly ConnectorMappingOutcome[] = [
      { kind: "ignored", reason_code: "unconfigured_message" },
      {
        kind: "reference_observed",
        reference: {
          uri: "feishu://docx/doc-1?revision=7",
          external_type: "document",
          version: "7",
          metadata: { title: "Proposal" },
        },
      },
      {
        kind: "command",
        command: {
          operation: "handoff.accept",
          idempotency_key: "connector:ingress-1",
          expected_version: 3,
          identity: { actor_id: "actor-1", endpoint_id: "endpoint-1" },
          input: { handoff_id: "handoff-1" },
        },
      },
      {
        kind: "reconciliation_observation",
        observation: {
          external_object_id: "om_123",
          observed_state: "delivered",
          observed_at: "2026-07-15T01:00:02.000Z",
          metadata: {},
        },
      },
      { kind: "rejected", reason_code: "identity_unmapped", retryable: false },
    ];

    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      "ignored",
      "reference_observed",
      "command",
      "reconciliation_observation",
      "rejected",
    ]);
    expect(envelope.payload).toEqual({ message_id: "om_123" });
  });
});
