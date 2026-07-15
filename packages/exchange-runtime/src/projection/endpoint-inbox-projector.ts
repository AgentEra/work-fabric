import type {
  EndpointInboxRoutingFact,
  EndpointInboxStore,
  EventRecord,
  JsonObject,
} from "@work-fabric/exchange-spi";

const HANDOFF_EVENT = /^workfabric\.handoff\.[a-z][a-z0-9_]*\.v1$/;
const TERMINAL_STATES = new Set([
  "closed",
  "declined",
  "expired",
  "cancelled",
  "transferred",
]);

function object(value: unknown, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`);
  }
  return value as JsonObject;
}

function lifecycle(record: EventRecord): {
  readonly state: string;
  readonly resourceVersion: number;
} {
  const protocol = object(record.protocol_data, "protocol_data");
  const resourceVersion = protocol.resource_version;
  const change = object(protocol.change, "protocol_data.change");
  const state = change.to_state;
  if (
    !Number.isSafeInteger(resourceVersion) ||
    Number(resourceVersion) <= 0 ||
    resourceVersion !== record.stream_version
  ) {
    throw new TypeError("protocol resource_version is inconsistent");
  }
  if (typeof state !== "string" || state.length === 0 || state.length > 64) {
    throw new TypeError("protocol lifecycle state is invalid");
  }
  return { state, resourceVersion: Number(resourceVersion) };
}

function assertRecord(record: EventRecord): void {
  for (const [field, value] of [
    ["tenant_id", record.tenant_id],
    ["partition_id", record.partition_id],
    ["handoff_id", record.handoff_id],
    ["event_id", record.event_id],
  ] as const) {
    if (value.length === 0) throw new TypeError(`${field} must not be empty`);
  }
  if (
    !Number.isSafeInteger(record.partition_position) ||
    record.partition_position <= 0 ||
    !Number.isSafeInteger(record.stream_version) ||
    record.stream_version <= 0
  ) {
    throw new TypeError("Journal positions must be positive safe integers");
  }
}

export class EndpointInboxProjector {
  constructor(private readonly store: EndpointInboxStore) {}

  async apply(record: EventRecord): Promise<void> {
    if (!HANDOFF_EVENT.test(record.event_type)) return;
    assertRecord(record);
    const state = lifecycle(record);
    const fact: EndpointInboxRoutingFact = {
      tenant_id: record.tenant_id,
      partition_id: record.partition_id,
      handoff_id: record.handoff_id,
      resource_version: state.resourceVersion,
      lifecycle_state: state.state,
      last_event_id: record.event_id,
      observed_position: record.partition_position,
      visible_actor_ids: [...record.visible_actor_ids],
      visible_endpoint_ids: [...record.visible_endpoint_ids],
      active: !TERMINAL_STATES.has(state.state),
    };
    await this.store.upsertRoutingFact(fact);
  }

  async rebuild(
    tenantId: string,
    records: Iterable<EventRecord> | AsyncIterable<EventRecord>,
  ): Promise<void> {
    if (tenantId.length === 0) throw new TypeError("tenantId must not be empty");
    await this.store.clearTenantProjection(tenantId);
    for await (const record of records) {
      if (record.tenant_id !== tenantId) {
        throw new TypeError("rebuild record Tenant does not match");
      }
      await this.apply(record);
    }
  }
}
