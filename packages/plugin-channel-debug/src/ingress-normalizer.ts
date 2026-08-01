import type { ConnectorIngressEnvelope } from "@work-fabric/connector-spi";
import type { JsonObject } from "@work-fabric/exchange-spi";

import type { DebugMessage } from "./content.js";

export interface DebugMessageIngressInput {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly external_tenant_id: string;
  readonly submission_id: string;
  readonly conversation_id: string;
  readonly message: DebugMessage;
  readonly occurred_at: string;
  readonly received_at: string;
}

function id(value: string, field: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value.trim() !== value
    || /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function timestamp(value: string, field: string): string {
  id(value, field, 64);
  if (
    !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

export function debugMessageIngress(
  input: DebugMessageIngressInput,
): ConnectorIngressEnvelope {
  const tenantId = id(input.tenant_id, "tenant_id", 128);
  const connectorId = id(input.connector_id, "connector_id", 128);
  const externalTenantId = id(
    input.external_tenant_id,
    "external_tenant_id",
    255,
  );
  const submissionId = id(input.submission_id, "submission_id", 96);
  const conversationId = id(input.conversation_id, "conversation_id", 512);
  const occurredAt = timestamp(input.occurred_at, "occurred_at");
  const receivedAt = timestamp(input.received_at, "received_at");
  if (Date.parse(receivedAt) < Date.parse(occurredAt)) {
    throw new TypeError("received_at must not precede occurred_at");
  }
  return {
    tenant_id: tenantId,
    connector_id: connectorId,
    source_system: "workfabric-debug",
    external_tenant_id: externalTenantId,
    external_event_id: submissionId,
    dedupe_key: `workfabric-debug:${connectorId}:${submissionId}`,
    event_type: "debug.message.receive_v1",
    partition_key: conversationId,
    occurred_at: occurredAt,
    received_at: receivedAt,
    payload: {
      submission_id: submissionId,
      conversation_id: conversationId,
      idempotency_key: input.message.idempotency_key,
      participant_ref: input.message.participant_ref,
      content: structuredClone(input.message.content),
    } as JsonObject,
  };
}
