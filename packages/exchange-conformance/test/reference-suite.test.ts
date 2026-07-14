import { beforeAll, describe, it } from "vitest";

import { MemoryContextRepository } from "@work-fabric/adapter-context-memory";
import {
  LocalIdentityProvider,
  type LocalIdentityRecord,
} from "@work-fabric/adapter-identity-local";
import { InProcessSignalAdapter } from "@work-fabric/adapter-signal-in-process";
import { MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import {
  ExchangeApplication,
  type Clock,
  type IdGenerator,
} from "@work-fabric/exchange-core";
import type {
  AuthorityPolicy,
  ResolvedPrincipal,
  RuntimeSubscription,
} from "@work-fabric/exchange-spi";
import {
  loadWfppCommandValidator,
  loadWfppSchemaValidator,
  type WfppCommandValidator,
  type WfppSchemaValidator,
} from "@work-fabric/protocol-runtime";
import {
  DefaultSubscriptionDeliveryPolicy,
  HandoffProjector,
  MemoryHandoffReadModelStore,
  MemorySubscriptionStore,
  SignalDispatcher,
} from "@work-fabric/exchange-runtime";

import { verifyExchangeReferenceSuite } from "../src/index.js";

const tenantId = "tenant_reference_suite";

function principal(
  name: "human" | "agent",
  actorType: "human" | "agent",
): ResolvedPrincipal {
  return {
    principal_id: `principal_${name}`,
    tenant_id: tenantId,
    actor_claims: [
      {
        actor_id: `actor_${name}`,
        actor_type: actorType,
        endpoint_ids: [`endpoint_${name}`],
      },
    ],
    attributes: {},
  };
}

class AllowAuthority implements AuthorityPolicy {
  readonly manifest = {
    profile: "exchange.authority.v1",
    adapter: "reference-suite-test",
    capabilities: {
      explicit_decision: true,
      default_deny: true,
      resource_scoping: true,
    },
  } as const;

  async authorize() {
    return { kind: "allow" as const };
  }
}

class ReferenceClock implements Clock {
  now(): string {
    return "2026-07-15T09:00:00Z";
  }
}

class ReferenceIds implements IdGenerator {
  private readonly counts = new Map<string, number>();

  nextId(kind: "handoff" | "event" | "commit" | "receipt" | "delivery") {
    const count = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, count);
    return `${kind}_suite_${count}`;
  }
}

function subscription(): RuntimeSubscription {
  return {
    subscription_id: "subscription_reference_suite",
    tenant_id: tenantId,
    owner: { actor_id: "actor_agent", actor_type: "agent" },
    endpoint_id: "endpoint_agent",
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
      destination_id: "destination_reference_suite",
      binding: "in-process",
      configuration: {},
    },
    delivery_mode: "webhook",
    state: "active",
    max_attempts: 3,
    created_at: "2026-07-15T08:00:00Z",
    updated_at: "2026-07-15T08:00:00Z",
  };
}

let validator: WfppCommandValidator;
let schemas: WfppSchemaValidator;

beforeAll(async () => {
  schemas = await loadWfppSchemaValidator("protocol/schemas/v1");
  validator = await loadWfppCommandValidator(
    schemas,
    "protocol/spec/interaction-payloads.json",
  );
});

describe("verifyExchangeReferenceSuite", () => {
  it("verifies the complete public Exchange reference contract", async () => {
    const human = principal("human", "human");
    const agent = principal("agent", "agent");
    const records: readonly LocalIdentityRecord[] = [
      { authentication_evidence: { token: "human" }, principal: human },
      { authentication_evidence: { token: "agent" }, principal: agent },
    ];
    const persistence = new MemoryExchangePersistence();
    const clock = new ReferenceClock();
    const application = new ExchangeApplication({
      persistence,
      identity: new LocalIdentityProvider(records),
      authority: new AllowAuthority(),
      context: new MemoryContextRepository(),
      validator,
      clock,
      ids: new ReferenceIds(),
    });
    const readModels = new MemoryHandoffReadModelStore();
    const projector = new HandoffProjector(
      persistence,
      persistence,
      persistence,
      readModels,
      clock,
    );
    const subscriptions = new MemorySubscriptionStore();
    await subscriptions.putSubscription(subscription());
    const dispatcher = new SignalDispatcher(
      persistence,
      persistence,
      subscriptions,
      new DefaultSubscriptionDeliveryPolicy(),
      new InProcessSignalAdapter(),
      clock,
      { base_delay_seconds: 1, max_delay_seconds: 8 },
      schemas,
    );

    await verifyExchangeReferenceSuite({
      application,
      projector,
      dispatcher,
      read_models: readModels,
      persistence,
      scenario: {
        tenant_id: tenantId,
        exchange_id: "exchange_reference_suite",
        human_actor_id: "actor_human",
        human_endpoint_id: "endpoint_human",
        human_evidence: { token: "human" },
        agent_actor_id: "actor_agent",
        agent_endpoint_id: "endpoint_agent",
        agent_evidence: { token: "agent" },
        signal_subscription_id: "subscription_reference_suite",
      },
    });
  });
});
