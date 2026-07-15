import { describe, expect, it } from "vitest";

import {
  DefaultSubscriptionDeliveryPolicy,
  MemorySubscriptionStore,
} from "@work-fabric/exchange-runtime";
import type {
  EventRecord,
  RuntimeSubscription,
  SubscriptionDeliveryDecision,
  SubscriptionDeliveryPolicy,
} from "@work-fabric/exchange-spi";

import {
  verifySubscriptionDeliveryProfile,
  verifySubscriptionProfile,
} from "../src/index.js";

function subscription(): RuntimeSubscription {
  return {
    subscription_id: "subscription_01",
    tenant_id: "tenant_01",
    owner: { actor_id: "actor_01", actor_type: "agent" },
    endpoint_id: "endpoint_01",
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
      destination_id: "destination_01",
      binding: "in-process",
      configuration: {},
    },
    delivery_mode: "webhook",
    state: "active",
    max_attempts: 3,
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
  };
}

function event(): EventRecord {
  return {
    event_id: "event_01",
    event_type: "workfabric.handoff.accepted.v1",
    schema_version: "1.0",
    exchange_id: "exchange_01",
    request_message_id: "message_01",
    idempotency_key: "key_01",
    thread_id: "thread_01",
    handoff_id: "handoff_01",
    actor_id: "actor_source",
    endpoint_id: "endpoint_source",
    visibility: "participants",
    visible_actor_ids: ["actor_01"],
    visible_endpoint_ids: ["endpoint_01"],
    occurred_at: "2026-07-15T01:00:00.000Z",
    domain_data: { secret: true },
    protocol_data: {
      resource_version: 1,
      change: { change_type: "accepted", to_state: "accepted" },
      receipt: null,
    },
    tenant_id: "tenant_01",
    partition_id: "partition_01",
    partition_position: 1,
    stream_id: "handoff_01",
    stream_version: 1,
    commit_id: "commit_01",
    commit_ordinal: 0,
  };
}

class MutableDirectReadStore extends MemorySubscriptionStore {
  private cached: RuntimeSubscription | null | undefined;

  override async getSubscription(
    subscriptionId: string,
  ): Promise<RuntimeSubscription | null> {
    if (this.cached === undefined) {
      this.cached = await super.getSubscription(subscriptionId);
    }
    return this.cached;
  }
}

class AcceptsIdentityTheftStore extends MemorySubscriptionStore {
  override async putSubscription(value: RuntimeSubscription): Promise<void> {
    try {
      await super.putSubscription(value);
    } catch (error: unknown) {
      if (!(error instanceof Error && /identity/i.test(error.message))) throw error;
    }
  }
}

class AcceptsTimeRollbackStore extends MemorySubscriptionStore {
  override async putSubscription(value: RuntimeSubscription): Promise<void> {
    try {
      await super.putSubscription(value);
    } catch (error: unknown) {
      if (!(error instanceof Error && /updated_at must increase/i.test(error.message))) {
        throw error;
      }
    }
  }
}

class ReopensClosedStore extends MemorySubscriptionStore {
  override async putSubscription(value: RuntimeSubscription): Promise<void> {
    try {
      await super.putSubscription(value);
    } catch (error: unknown) {
      if (!(error instanceof Error && /closed/i.test(error.message))) throw error;
    }
  }
}

class UnstableActiveOrderingStore extends MemorySubscriptionStore {
  override async listActiveSubscriptions(
    tenantId: string,
  ): Promise<readonly RuntimeSubscription[]> {
    return [...(await super.listActiveSubscriptions(tenantId))].reverse();
  }
}

class ListsClosedStore extends MemorySubscriptionStore {
  private closed: RuntimeSubscription | null = null;

  override async putSubscription(value: RuntimeSubscription): Promise<void> {
    await super.putSubscription(value);
    if (value.state === "closed") this.closed = structuredClone(value);
  }

  override async listActiveSubscriptions(
    tenantId: string,
  ): Promise<readonly RuntimeSubscription[]> {
    const active = await super.listActiveSubscriptions(tenantId);
    return this.closed?.tenant_id === tenantId
      ? [...active, structuredClone(this.closed)]
      : active;
  }
}

class AllowEverythingPolicy implements SubscriptionDeliveryPolicy {
  readonly manifest = {
    profile: "exchange.subscription_delivery.v1",
    adapter: "broken",
    capabilities: {
      tenant_isolation: true,
      audience_enforcement: true,
      default_deny: true,
    },
  } as const;

  async authorizeDelivery(): Promise<SubscriptionDeliveryDecision> {
    return { kind: "allow" };
  }
}

describe("Subscription Conformance Profiles", () => {
  it("verifies the Memory Subscription Store", async () => {
    await expect(
      verifySubscriptionProfile(() => new MemorySubscriptionStore()),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["mutable direct reads", () => new MutableDirectReadStore(), /clone direct reads/i],
    ["identity replacement", () => new AcceptsIdentityTheftStore(), /Tenant identity replacement/i],
    ["updated_at rollback", () => new AcceptsTimeRollbackStore(), /same-timestamp different-content/i],
    ["closed reopening", () => new ReopensClosedStore(), /closed Subscription reopening/i],
    ["unstable active ordering", () => new UnstableActiveOrderingStore(), /stable Subscription ID order/i],
    ["closed records in active listing", () => new ListsClosedStore(), /exclude closed records/i],
  ] as const)("rejects a Store with %s", async (_name, factory, message) => {
    await expect(verifySubscriptionProfile(factory)).rejects.toThrow(message);
  });

  it("verifies the default Tenant and visibility Delivery Policy", async () => {
    await expect(
      verifySubscriptionDeliveryProfile(
        new DefaultSubscriptionDeliveryPolicy(),
        { subscription: subscription(), event: event() },
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a Policy that allows cross-Tenant and non-participant delivery", async () => {
    await expect(
      verifySubscriptionDeliveryProfile(new AllowEverythingPolicy(), {
        subscription: subscription(),
        event: event(),
      }),
    ).rejects.toThrow(/cross-Tenant|non-participant/i);
  });
});
