import assert from "node:assert/strict";

import {
  SUBSCRIPTION_DELIVERY_REQUIRED_CAPABILITIES,
  SUBSCRIPTION_REQUIRED_CAPABILITIES,
  assertCapabilities,
  type EventRecord,
  type RuntimeSubscription,
  type SubscriptionDeliveryPolicy,
  type SubscriptionStore,
} from "@work-fabric/exchange-spi";

export type SubscriptionStoreFactory = () => SubscriptionStore;

export interface SubscriptionDeliveryProfileFixtures {
  readonly subscription: RuntimeSubscription;
  readonly event: EventRecord;
}

function baseSubscription(): RuntimeSubscription {
  return {
    subscription_id: "subscription_profile_01",
    tenant_id: "tenant_profile_01",
    owner: { actor_id: "actor_profile_01", actor_type: "agent" },
    endpoint_id: "endpoint_profile_01",
    filter: {
      event_types: [],
      actor_ids: [],
      endpoint_ids: [],
      thread_ids: [],
      handoff_ids: [],
      work_reference_uris: [],
      capability_ids: [],
      lifecycle_states: [],
    },
    destination: {
      destination_id: "destination_profile_01",
      binding: "in-process",
      configuration: { channel: "profile" },
    },
    delivery_mode: "webhook",
    state: "active",
    max_attempts: 3,
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
  };
}

function update(
  subscription: RuntimeSubscription,
  overrides: Partial<RuntimeSubscription>,
): RuntimeSubscription {
  return { ...structuredClone(subscription), ...overrides };
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function expectRejected(
  operation: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await operation;
  } catch {
    return;
  }
  assert.fail(message);
}

export async function verifySubscriptionProfile(
  factory: SubscriptionStoreFactory,
): Promise<void> {
  const store = factory();
  assert.equal(store.manifest.profile, "exchange.subscription.v1");
  assertCapabilities(store.manifest, SUBSCRIPTION_REQUIRED_CAPABILITIES);
  const original = baseSubscription();
  const input = structuredClone(original);
  await store.putSubscription(input);
  await store.putSubscription(structuredClone(original));

  for (const invalid of [
    update(original, { subscription_id: "" }),
    update(original, {
      subscription_id: "subscription_invalid_attempts",
      max_attempts: 0,
    }),
    update(original, {
      subscription_id: "subscription_invalid_time",
      updated_at: "not-a-time",
    }),
    update(original, {
      subscription_id: "subscription_unknown_filter",
      filter: {
        ...original.filter,
        script: "return true",
      } as RuntimeSubscription["filter"],
    }),
  ]) {
    await expectRejected(
      store.putSubscription(invalid),
      "invalid Subscription input must reject",
    );
  }

  (input.destination.configuration as { channel: string }).channel = "mutated";
  assert.deepEqual(
    await store.getSubscription(original.subscription_id),
    original,
    "Subscription Store must clone writes",
  );

  const direct = await store.getSubscription(original.subscription_id);
  assert.ok(direct !== null);
  (direct.destination.configuration as { channel: string }).channel = "mutated";
  assert.deepEqual(
    await store.getSubscription(original.subscription_id),
    original,
    "Subscription Store must clone direct reads",
  );

  const active = await store.listActiveSubscriptions(original.tenant_id);
  assert.deepEqual(active, [original]);
  (active[0]?.destination.configuration as { channel: string }).channel =
    "mutated";
  assert.deepEqual(
    await store.listActiveSubscriptions(original.tenant_id),
    [original],
    "Subscription Store must clone list reads",
  );

  const otherTenant = update(original, {
    subscription_id: "subscription_profile_other",
    tenant_id: "tenant_profile_other",
    updated_at: "2026-07-15T00:00:01.000Z",
  });
  await store.putSubscription(otherTenant);
  assert.deepEqual(
    await store.listActiveSubscriptions(original.tenant_id),
    [original],
    "active Subscription listing must isolate Tenants",
  );

  const suspended = update(original, {
    state: "suspended",
    updated_at: "2026-07-15T00:00:02.000Z",
  });
  await store.putSubscription(suspended);
  assert.deepEqual(
    await store.listActiveSubscriptions(original.tenant_id),
    [],
    "active Subscription listing must exclude suspended records",
  );

  const replacement = update(suspended, {
    state: "active",
    max_attempts: 5,
    destination: {
      ...suspended.destination,
      configuration: { channel: "replacement" },
    },
    updated_at: "2026-07-15T00:00:03.000Z",
  });
  await store.putSubscription(replacement);
  assert.deepEqual(
    await store.getSubscription(original.subscription_id),
    replacement,
    "same-ID replacement must update mutable Subscription fields",
  );

  for (const [label, stolen] of [
    ["Tenant", update(replacement, { tenant_id: "tenant_stolen" })],
    [
      "Owner Actor",
      update(replacement, {
        owner: { actor_id: "actor_stolen", actor_type: "agent" },
      }),
    ],
    [
      "Owner Type",
      update(replacement, {
        owner: { actor_id: replacement.owner.actor_id, actor_type: "human" },
      }),
    ],
    ["Endpoint", update(replacement, { endpoint_id: "endpoint_stolen" })],
    [
      "Created Time",
      update(replacement, { created_at: "2026-07-14T00:00:00.000Z" }),
    ],
  ] as const) {
    await expectRejected(
      store.putSubscription({
        ...stolen,
        updated_at: "2026-07-15T00:00:04.000Z",
      }),
      `Subscription ${label} identity replacement must reject`,
    );
  }

  await expectRejected(
    store.putSubscription(
      update(replacement, {
        max_attempts: 6,
        updated_at: replacement.updated_at,
      }),
    ),
    "Subscription same-timestamp different-content update must reject",
  );

  const orderingStore = factory();
  const later = update(original, {
    subscription_id: "subscription_profile_z",
  });
  const earlier = update(original, {
    subscription_id: "subscription_profile_a",
  });
  await orderingStore.putSubscription(later);
  await orderingStore.putSubscription(earlier);
  assert.deepEqual(
    (await orderingStore.listActiveSubscriptions(original.tenant_id)).map(
      (subscription) => subscription.subscription_id,
    ),
    [earlier.subscription_id, later.subscription_id],
    "active Subscription listing must use stable Subscription ID order",
  );

  const closed = update(replacement, {
    state: "closed",
    updated_at: "2026-07-15T00:00:05.000Z",
  });
  await store.putSubscription(closed);
  await expectRejected(
    store.putSubscription(
      update(closed, {
        state: "active",
        updated_at: "2026-07-15T00:00:06.000Z",
      }),
    ),
    "closed Subscription reopening must reject",
  );
}

async function expectDecision(
  policy: SubscriptionDeliveryPolicy,
  subscription: RuntimeSubscription,
  event: EventRecord,
  expected: "allow" | "deny",
  scenario: string,
): Promise<void> {
  const decision = await policy.authorizeDelivery(
    structuredClone(subscription),
    structuredClone(event),
  );
  assert.equal(
    decision.kind,
    expected,
    `${scenario} expected ${expected}, received ${decision.kind}`,
  );
}

export async function verifySubscriptionDeliveryProfile(
  policy: SubscriptionDeliveryPolicy,
  fixtures: SubscriptionDeliveryProfileFixtures,
): Promise<void> {
  try {
    assert.equal(
      policy.manifest.profile,
      "exchange.subscription_delivery.v1",
    );
    assertCapabilities(
      policy.manifest,
      SUBSCRIPTION_DELIVERY_REQUIRED_CAPABILITIES,
    );
    const subscription = structuredClone(fixtures.subscription);
    const source = structuredClone(fixtures.event);

    await expectDecision(
      policy,
      subscription,
      { ...source, visibility: "public", visible_actor_ids: [], visible_endpoint_ids: [] },
      "allow",
      "same-Tenant public",
    );
    await expectDecision(
      policy,
      subscription,
      { ...source, visibility: "tenant", visible_actor_ids: [], visible_endpoint_ids: [] },
      "allow",
      "same-Tenant tenant",
    );
    await expectDecision(
      policy,
      subscription,
      {
        ...source,
        tenant_id: `${subscription.tenant_id}_other`,
        visibility: "public",
      },
      "deny",
      "cross-Tenant public",
    );
    await expectDecision(
      policy,
      subscription,
      {
        ...source,
        visibility: "participants",
        visible_actor_ids: [subscription.owner.actor_id],
        visible_endpoint_ids: [],
      },
      "allow",
      "participant Actor",
    );
    await expectDecision(
      policy,
      subscription,
      {
        ...source,
        visibility: "participants",
        visible_actor_ids: [],
        visible_endpoint_ids: [subscription.endpoint_id],
      },
      "allow",
      "participant Endpoint",
    );
    await expectDecision(
      policy,
      subscription,
      {
        ...source,
        visibility: "participants",
        visible_actor_ids: ["actor_outsider"],
        visible_endpoint_ids: ["endpoint_outsider"],
      },
      "deny",
      "non-participant",
    );
    await expectDecision(
      policy,
      subscription,
      {
        ...source,
        visibility: "restricted",
        visible_actor_ids: [subscription.owner.actor_id],
        visible_endpoint_ids: [],
      },
      "allow",
      "restricted participant",
    );
    await expectDecision(
      policy,
      subscription,
      {
        ...source,
        visibility: "restricted",
        visible_actor_ids: [],
        visible_endpoint_ids: [],
      },
      "deny",
      "restricted non-participant",
    );
    await expectDecision(
      policy,
      subscription,
      { ...source, visibility: "unknown" as EventRecord["visibility"] },
      "deny",
      "unknown visibility default deny",
    );
  } catch (error: unknown) {
    throw new Error(`Subscription Delivery Profile failed: ${failureMessage(error)}`, {
      cause: error,
    });
  }
}
