import { beforeAll, describe, expect, it } from "vitest";

import {
  loadSchemaRegistry,
  type SchemaRegistryError,
} from "../src/schema-registry.js";

let registry: Awaited<ReturnType<typeof loadSchemaRegistry>>;

beforeAll(async () => {
  registry = await loadSchemaRegistry("protocol/schemas/v1");
});

function errors(
  schemaName: string,
  value: unknown,
): readonly SchemaRegistryError[] | null {
  const schemaId = `urn:work-fabric:schema:v1:${schemaName}`;
  const validator = registry.getSchema(schemaId);
  if (validator === undefined) {
    throw new Error(`Schema not registered: ${schemaId}`);
  }
  validator(value);
  return validator.errors ?? null;
}

const event = {
  specversion: "1.0",
  id: "evt_01",
  source: "urn:work-fabric:exchange:exchange_01",
  type: "workfabric.handoff.accepted.v1",
  subject: "handoff_42",
  time: "2026-07-13T08:00:00Z",
  datacontenttype: "application/json",
  dataschema: "urn:work-fabric:schema:v1:handoff-accepted-event",
  wftenant: "tenant_01",
  wfexchange: "exchange_01",
  wfthread: "thread_01",
  wfhandoff: "handoff_42",
  wfactor: "actor_agent_01",
  wfendpoint: "endpoint_runtime_01",
  wfcorrelation: "corr_01",
  wfcausation: "msg_01",
  wfsequence: 4,
  wfvisibility: "participants",
  data: {
    resource_version: 4,
    change: {
      from_state: "offered",
      to_state: "accepted",
    },
    receipt: {
      receipt_id: "receipt_01",
      receipt_type: "responsibility_accepted",
    },
  },
};

const filter = {
  event_types: ["workfabric.handoff.offered.v1"],
  actor_ids: ["actor_agent_01"],
  endpoint_ids: [],
  thread_ids: [],
  handoff_ids: [],
  work_reference_uris: [],
  capability_ids: ["software.implementation"],
  lifecycle_states: ["offered"],
  extensions: {},
};

describe("ProtocolEvent", () => {
  it("accepts a CloudEvents 1.0 event with ordering metadata", () => {
    expect(errors("protocol-event", event)).toBeNull();
  });

  it("requires the monotonic Work Fabric sequence", () => {
    const { wfsequence: _omitted, ...invalid } = event;
    expect(errors("protocol-event", invalid)).not.toBeNull();
  });

  it("rejects a non-CloudEvents envelope", () => {
    expect(
      errors("protocol-event", {
        event_id: "evt_01",
        event_type: "handoff.accepted",
        payload: event.data,
      }),
    ).not.toBeNull();
  });

  it("does not duplicate full Context in Event Data", () => {
    const invalid = structuredClone(event);
    Object.assign(invalid.data, {
      context_bundle: {
        context_id: "context_01",
        items: [],
      },
    });

    expect(errors("protocol-event", invalid)).not.toBeNull();
  });

  it("rejects credential-like event details", () => {
    const invalid = structuredClone(event);
    Object.assign(invalid.data.change, {
      details: { access_token: "secret" },
    });

    expect(errors("protocol-event", invalid)).not.toBeNull();
  });
});

describe("SubscriptionFilter", () => {
  it("accepts the closed declarative filter model", () => {
    expect(errors("subscription-filter", filter)).toBeNull();
  });

  it.each([
    { script: "return event.data.priority > 5" },
    { expression: "$.data[?(@.priority > 5)]" },
    { predicate: { language: "javascript", source: "true" } },
  ])("rejects executable filter input", (extra) => {
    expect(errors("subscription-filter", { ...filter, ...extra })).not.toBeNull();
  });

  it("creates a durable cursor-pull subscription", () => {
    expect(
      errors("subscription", {
        subscription_id: "subscription_01",
        owner: {
          actor_id: "actor_agent_01",
          actor_type: "agent",
        },
        endpoint_id: "endpoint_runtime_01",
        filter,
        delivery: {
          mode: "cursor_pull",
        },
        state: "active",
        cursor: null,
        created_at: "2026-07-13T07:59:00Z",
        updated_at: "2026-07-13T07:59:00Z",
        extensions: {},
      }),
    ).toBeNull();
  });
});

describe("Delivery and acknowledgement", () => {
  it("describes an at-least-once cursor delivery", () => {
    expect(
      errors("event-delivery", {
        delivery_id: "delivery_01",
        subscription_id: "subscription_01",
        attempt: 2,
        events: [event],
        next_cursor: "opaque-cursor-02",
        delivered_at: "2026-07-13T08:00:01Z",
        visibility_expires_at: "2026-07-13T08:01:01Z",
        extensions: {},
      }),
    ).toBeNull();
  });

  it("acknowledges delivery without changing Handoff state", () => {
    expect(
      errors("delivery-ack", {
        delivery_id: "delivery_01",
        subscription_id: "subscription_01",
        outcome: "acknowledged",
        acknowledged_at: "2026-07-13T08:00:02Z",
        last_event_id: "evt_01",
        cursor: "opaque-cursor-02",
        extensions: {},
      }),
    ).toBeNull();
  });

  it("rejects lifecycle changes in a delivery acknowledgement", () => {
    expect(
      errors("delivery-ack", {
        delivery_id: "delivery_01",
        subscription_id: "subscription_01",
        outcome: "acknowledged",
        acknowledged_at: "2026-07-13T08:00:02Z",
        lifecycle_state: "accepted",
        extensions: {},
      }),
    ).not.toBeNull();
  });
});
