import type { EventRecord, ProtocolEvent } from "@work-fabric/exchange-spi";

import {
  assertOpaqueId,
  assertPositiveSafeInteger,
  assertTimestamp,
} from "./validation.js";

export function buildProtocolEvent(record: EventRecord): ProtocolEvent {
  assertOpaqueId(record.event_id, "event_id");
  assertOpaqueId(record.exchange_id, "exchange_id");
  assertOpaqueId(record.tenant_id, "tenant_id");
  assertOpaqueId(record.thread_id, "thread_id");
  assertOpaqueId(record.handoff_id, "handoff_id");
  assertOpaqueId(record.actor_id, "actor_id");
  assertOpaqueId(record.endpoint_id, "endpoint_id");
  if (record.correlation_id !== undefined) {
    assertOpaqueId(record.correlation_id, "correlation_id");
  }
  if (record.causation_id !== undefined) {
    assertOpaqueId(record.causation_id, "causation_id");
  }
  assertPositiveSafeInteger(record.stream_version, "stream_version");
  assertTimestamp(record.occurred_at, "occurred_at");
  return {
    specversion: "1.0",
    id: record.event_id,
    source: `urn:work-fabric:exchange:${record.exchange_id}`,
    type: record.event_type,
    subject: record.handoff_id,
    time: record.occurred_at,
    datacontenttype: "application/json",
    dataschema: "urn:work-fabric:schema:v1:event-data",
    wftenant: record.tenant_id,
    wfexchange: record.exchange_id,
    wfthread: record.thread_id,
    wfhandoff: record.handoff_id,
    wfactor: record.actor_id,
    wfendpoint: record.endpoint_id,
    ...(record.correlation_id === undefined
      ? {}
      : { wfcorrelation: record.correlation_id }),
    ...(record.causation_id === undefined
      ? {}
      : { wfcausation: record.causation_id }),
    wfsequence: record.stream_version,
    wfvisibility: record.visibility,
    data: structuredClone(record.protocol_data),
  };
}
