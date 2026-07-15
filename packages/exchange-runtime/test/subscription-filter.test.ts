import { describe, expect, it } from "vitest";

import type {
  EventRecord,
  ProtocolEvent,
  RuntimeSubscription,
  SubscriptionFilter,
} from "@work-fabric/exchange-spi";

import {
  buildProtocolEvent,
  DefaultSubscriptionDeliveryPolicy,
  matchesSubscription,
} from "../src/index.js";

const emptyFilter = (): SubscriptionFilter => ({
  event_types: [],
  actor_ids: [],
  endpoint_ids: [],
  thread_ids: [],
  handoff_ids: [],
  work_reference_uris: [],
  capability_ids: [],
  lifecycle_states: [],
});

function protocolEvent(overrides: Partial<ProtocolEvent> = {}): ProtocolEvent {
  return {
    specversion: "1.0",
    id: "event_01",
    source: "urn:work-fabric:exchange:exchange_01",
    type: "workfabric.handoff.accepted.v1",
    subject: "handoff_01",
    time: "2026-07-15T08:00:00.000Z",
    datacontenttype: "application/json",
    dataschema: "urn:work-fabric:schema:v1:event-data",
    wftenant: "tenant_01",
    wfexchange: "exchange_01",
    wfthread: "thread_01",
    wfhandoff: "handoff_01",
    wfactor: "actor_01",
    wfendpoint: "endpoint_01",
    wfsequence: 2,
    wfvisibility: "participants",
    data: {
      resource_version: 2,
      change: {
        change_type: "accepted",
        from_state: "offered",
        to_state: "accepted",
        details: {
          work_reference_uri: "urn:work:item:42",
          capability_ids: ["software.implementation", "code.review"],
          ignored_secret: "must-not-be-read",
        },
      },
      receipt: null,
    },
    ...overrides,
  };
}

function eventRecord(overrides: Partial<EventRecord> = {}): EventRecord {
  const event = protocolEvent();
  return {
    event_id: event.id,
    event_type: event.type,
    schema_version: "1.0",
    exchange_id: "exchange_01",
    request_message_id: "message_01",
    idempotency_key: "key_01",
    thread_id: "thread_01",
    handoff_id: "handoff_01",
    actor_id: "actor_01",
    endpoint_id: "endpoint_01",
    visibility: "participants",
    visible_actor_ids: ["actor_01", "recipient_01"],
    visible_endpoint_ids: ["endpoint_01", "recipient_endpoint_01"],
    occurred_at: event.time,
    domain_data: { internal: "never public" },
    protocol_data: event.data,
    tenant_id: "tenant_01",
    partition_id: "partition_01",
    partition_position: 1,
    stream_id: "handoff_01",
    stream_version: 2,
    commit_id: "commit_01",
    commit_ordinal: 0,
    ...overrides,
  };
}

function subscription(
  overrides: Partial<RuntimeSubscription> = {},
): RuntimeSubscription {
  return {
    subscription_id: "subscription_01",
    tenant_id: "tenant_01",
    owner: { actor_id: "recipient_01", actor_type: "agent" },
    endpoint_id: "recipient_endpoint_01",
    filter: emptyFilter(),
    destination: {
      destination_id: "destination_01",
      binding: "in-process",
      configuration: {},
    },
    delivery_mode: "webhook",
    state: "active",
    max_attempts: 3,
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("matchesSubscription", () => {
  it("treats every empty array as a wildcard", () => {
    expect(matchesSubscription(emptyFilter(), protocolEvent())).toBe(true);
  });

  it("uses OR within a populated field and AND across populated fields", () => {
    const matching: SubscriptionFilter = {
      ...emptyFilter(),
      event_types: [
        "workfabric.handoff.offered.v1",
        "workfabric.handoff.accepted.v1",
      ],
      actor_ids: ["other_actor", "actor_01"],
      lifecycle_states: ["accepted"],
    };
    expect(matchesSubscription(matching, protocolEvent())).toBe(true);
    expect(
      matchesSubscription(
        { ...matching, lifecycle_states: ["closed"] },
        protocolEvent(),
      ),
    ).toBe(false);
  });

  it.each(["target_resolution_pending", "target_unavailable"])(
    "matches the %s lifecycle state",
    (lifecycleState) => {
      const event = protocolEvent({
        type:
          lifecycleState === "target_resolution_pending"
            ? "workfabric.handoff.target_resolution_requested.v1"
            : "workfabric.handoff.target_unavailable.v1",
        data: {
          resource_version: 1,
          change: {
            change_type: lifecycleState,
            from_state: null,
            to_state: lifecycleState,
            details: {
              lifecycle_state: lifecycleState,
              capability_ids: ["software.implementation"],
            },
          },
          receipt: null,
        },
      });

      expect(
        matchesSubscription(
          { ...emptyFilter(), lifecycle_states: [lifecycleState] },
          event,
        ),
      ).toBe(true);
    },
  );

  it.each([
    ["event_types", ["workfabric.handoff.accepted.v1"]],
    ["actor_ids", ["actor_01"]],
    ["endpoint_ids", ["endpoint_01"]],
    ["thread_ids", ["thread_01"]],
    ["handoff_ids", ["handoff_01"]],
    ["work_reference_uris", ["urn:work:item:42"]],
    ["capability_ids", ["code.review"]],
    ["lifecycle_states", ["accepted"]],
  ] as const)("matches the supported %s field", (field, values) => {
    const filter = { ...emptyFilter(), [field]: values } as SubscriptionFilter;
    expect(matchesSubscription(filter, protocolEvent())).toBe(true);
  });

  it("treats missing scalar metadata as no match", () => {
    const {
      wfactor: _actor,
      wfendpoint: _endpoint,
      ...event
    } = protocolEvent();
    expect(
      matchesSubscription(
        { ...emptyFilter(), actor_ids: ["actor_01"] },
        event,
      ),
    ).toBe(false);
    expect(
      matchesSubscription(
        { ...emptyFilter(), endpoint_ids: ["endpoint_01"] },
        event,
      ),
    ).toBe(false);
  });

  it("reads routing values only from safe change fields", () => {
    const event = protocolEvent({
      data: {
        resource_version: 2,
        change: {
          change_type: "accepted",
          to_state: "accepted",
          details: {
            work_reference_uri: ["urn:work:item:42"],
            capability_ids: "software.implementation",
          },
        },
        receipt: null,
        work_reference_uri: "urn:work:item:42",
        capability_ids: ["software.implementation"],
      },
    });
    expect(
      matchesSubscription(
        {
          ...emptyFilter(),
          work_reference_uris: ["urn:work:item:42"],
          capability_ids: ["software.implementation"],
        },
        event,
      ),
    ).toBe(false);
  });

  it("ignores executable and unknown properties instead of evaluating them", () => {
    let invoked = false;
    const filter = {
      ...emptyFilter(),
      script: "return true",
      regex: /.*/,
      predicate: () => {
        invoked = true;
        return false;
      },
      arbitrary_expression: { equals: ["$domain.secret", true] },
    } as SubscriptionFilter;

    expect(matchesSubscription(filter, protocolEvent())).toBe(true);
    expect(invoked).toBe(false);
  });
});

describe("buildProtocolEvent", () => {
  it("publishes protocol facts without storage or private domain fields", () => {
    const record = eventRecord({
      event_type: "workfabric.handoff.target_resolved.v1",
      domain_data: {
        private_candidates: ["agent-a", "agent-b"],
        private_score: 0.99,
      },
      protocol_data: {
        resource_version: 2,
        change: {
          change_type: "target_resolved",
          from_state: "target_resolution_pending",
          to_state: "offered",
          details: {
            lifecycle_state: "offered",
            capability_ids: ["software.implementation"],
            resolved_target: { endpoint_id: "endpoint_agent" },
            resolved_by_actor_id: "actor_resolver",
            resolver_endpoint_id: "endpoint_resolver",
          },
        },
        receipt: null,
      },
    });

    const event = buildProtocolEvent(record);

    expect(event).toMatchObject({
      type: "workfabric.handoff.target_resolved.v1",
      wfsequence: 2,
      data: {
        change: {
          to_state: "offered",
          details: {
            resolved_target: { endpoint_id: "endpoint_agent" },
            resolver_endpoint_id: "endpoint_resolver",
          },
        },
      },
    });
    expect(JSON.stringify(event)).not.toMatch(
      /private_candidates|private_score|partition_position|commit_id|domain_data/,
    );
  });
});

describe("DefaultSubscriptionDeliveryPolicy", () => {
  const policy = new DefaultSubscriptionDeliveryPolicy();

  it("denies a Tenant mismatch after the declarative filter matches", async () => {
    await expect(
      policy.authorizeDelivery(
        subscription({ tenant_id: "tenant_other" }),
        eventRecord(),
      ),
    ).resolves.toEqual({ kind: "deny", reason: "tenant_mismatch" });
  });

  it.each(["public", "tenant"] as const)(
    "allows same-Tenant %s visibility",
    async (visibility) => {
      await expect(
        policy.authorizeDelivery(subscription(), eventRecord({ visibility })),
      ).resolves.toEqual({ kind: "allow" });
    },
  );

  it.each(["participants", "restricted"] as const)(
    "allows %s only for an internal Actor or Endpoint audience participant",
    async (visibility) => {
      await expect(
        policy.authorizeDelivery(subscription(), eventRecord({ visibility })),
      ).resolves.toEqual({ kind: "allow" });

      await expect(
        policy.authorizeDelivery(
          subscription({
            owner: { actor_id: "outsider", actor_type: "human" },
            endpoint_id: "outsider_endpoint",
          }),
          eventRecord({ visibility }),
        ),
      ).resolves.toEqual({ kind: "deny", reason: "not_in_audience" });
    },
  );

  it("defaults to denial for an unknown runtime visibility", async () => {
    await expect(
      policy.authorizeDelivery(
        subscription(),
        eventRecord({ visibility: "private" as EventRecord["visibility"] }),
      ),
    ).resolves.toEqual({ kind: "deny", reason: "unsupported_visibility" });
  });
});
