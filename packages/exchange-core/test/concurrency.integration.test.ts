import { beforeAll, describe, expect, it } from "vitest";

import { MemoryContextRepository } from "@work-fabric/adapter-context-memory";
import {
  LocalIdentityProvider,
  type LocalIdentityRecord,
} from "@work-fabric/adapter-identity-local";
import { MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import type {
  AtomicCommitRequest,
  AtomicCommitResult,
  AuthorityPolicy,
  ExchangePersistence,
  JsonObject,
  ResolvedPrincipal,
} from "@work-fabric/exchange-spi";
import {
  loadWfppCommandValidator,
  loadWfppSchemaValidator,
  type WfppCommandValidator,
} from "@work-fabric/protocol-runtime";

import {
  ExchangeApplication,
  type Clock,
  type CommandEnvelope,
  type IdGenerator,
} from "../src/index.js";

const tenantId = "tenant_concurrency";
const exchangeId = "exchange_concurrency";

const principals = {
  human: principal("human", "human"),
  agentA: principal("agent_a", "agent"),
  agentB: principal("agent_b", "agent"),
  child: principal("child", "agent"),
} as const;

function principal(
  name: string,
  actorType: "human" | "agent" | "system",
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
    adapter: "integration-allow",
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

class TestClock implements Clock {
  now(): string {
    return "2026-07-15T09:00:00Z";
  }
}

class TestIds implements IdGenerator {
  private readonly counts = new Map<string, number>();

  nextId(kind: "handoff" | "event" | "commit" | "receipt" | "delivery") {
    const count = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, count);
    return `${kind}_${count}`;
  }
}

class ConflictOnChildAcceptPersistence extends MemoryExchangePersistence {
  conflictNextMulti = false;

  override async commitAtomically(
    request: AtomicCommitRequest,
  ): Promise<AtomicCommitResult> {
    if (this.conflictNextMulti && request.appends.length === 2) {
      this.conflictNextMulti = false;
      return {
        kind: "version_conflict",
        current_versions: { handoff_1: 3, handoff_2: 1 },
      };
    }
    return super.commitAtomically(request);
  }
}

class FailOncePersistence extends MemoryExchangePersistence {
  private fail = true;

  override async commitAtomically(request: AtomicCommitRequest) {
    if (this.fail) {
      this.fail = false;
      throw new Error("temporary persistence outage");
    }
    return super.commitAtomically(request);
  }
}

const identityRecords: readonly LocalIdentityRecord[] = Object.entries(
  principals,
).map(([token, resolved]) => ({
  authentication_evidence: { token },
  principal: resolved,
}));

let validator: WfppCommandValidator;

beforeAll(async () => {
  const schemas = await loadWfppSchemaValidator("protocol/schemas/v1");
  validator = await loadWfppCommandValidator(
    schemas,
    "protocol/spec/interaction-payloads.json",
  );
});

function application(
  persistence: ExchangePersistence = new MemoryExchangePersistence(),
  context = new MemoryContextRepository(),
) {
  return new ExchangeApplication({
    persistence,
    identity: new LocalIdentityProvider(identityRecords),
    authority: new AllowAuthority(),
    context,
    validator,
    clock: new TestClock(),
    ids: new TestIds(),
  });
}

function actorFields(actor: keyof typeof principals) {
  const claim = principals[actor].actor_claims[0];
  const endpointId = claim?.endpoint_ids[0];
  if (claim === undefined || endpointId === undefined) {
    throw new Error("Test principal is incomplete");
  }
  return { actor_id: claim.actor_id, endpoint_id: endpointId };
}

function envelope(
  interaction: string,
  actor: keyof typeof principals,
  idempotencyKey: string,
  payload: JsonObject,
  expectedVersion?: number,
): CommandEnvelope {
  return {
    spec_version: "1.0",
    message_id: `message_${idempotencyKey}`,
    message_type: `workfabric.handoff.${interaction}.v1`,
    sent_at: "2026-07-15T09:00:00Z",
    tenant_id: tenantId,
    exchange_id: exchangeId,
    ...actorFields(actor),
    delegation_id: "delegation_concurrency",
    idempotency_key: idempotencyKey,
    ...(expectedVersion === undefined
      ? {}
      : { expected_version: expectedVersion }),
    payload,
  };
}

function offerPayload(
  target: JsonObject = { actor_id: "actor_agent_a" },
  mayRedelegate = false,
  contextBundle?: JsonObject,
): JsonObject {
  return {
    work_reference: { uri: "urn:work:concurrency", extensions: {} },
    target,
    intent: [
      {
        kind: "text",
        media_type: "text/plain",
        text: "Coordinate work externally",
      },
    ],
    ...(contextBundle === undefined ? {} : { context_bundle: contextBundle }),
    authority_scope: {
      delegation_id: "delegation_concurrency",
      scopes: ["work:read"],
      resource_refs: ["urn:work:concurrency"],
      expires_at: "2026-07-16T09:00:00Z",
      may_redelegate: mayRedelegate,
    },
    acceptance_criteria: [
      {
        criterion_id: "tests-pass",
        description: "Tests pass",
        required: true,
        result_schema_ref: null,
        required_evidence_types: [],
      },
    ],
    verifier: { actor_id: "actor_human", actor_type: "human" },
    priority: "normal",
    accept_by: "2026-07-15T10:00:00Z",
    result_due_at: "2026-07-16T09:00:00Z",
  };
}

function offer(
  key = "offer-1",
  payload: JsonObject = offerPayload(),
): CommandEnvelope {
  return envelope("offer", "human", key, payload);
}

function accept(
  actor: "agentA" | "agentB" | "child",
  handoffId: string,
  key: string,
): CommandEnvelope {
  return envelope("accept", actor, key, { handoff_id: handoffId }, 1);
}

function result(key: string): CommandEnvelope {
  return envelope(
    "return_result",
    "agentA",
    key,
    {
      handoff_id: "handoff_1",
      result: {
        summary: [
          { kind: "text", media_type: "text/plain", text: "Done" },
        ],
        artifacts: [],
        evidence: [],
      },
    },
    2,
  );
}

async function streamLengths(
  persistence: MemoryExchangePersistence,
): Promise<readonly number[]> {
  return Promise.all(
    ["handoff_1", "handoff_2"].map(async (id) =>
      (await persistence.readStream(id)).length,
    ),
  );
}

describe("Exchange concurrency and application recovery", () => {
  it("commits exactly one of two concurrent capability-target Accepts", async () => {
    const persistence = new MemoryExchangePersistence();
    const app = application(persistence);
    await app.handle(
      offer(
        "offer-capability",
        offerPayload({
          capability_requirement: { capability_id: "software.implementation" },
        }),
      ),
      { token: "human" },
    );

    const outcomes = await Promise.all([
      app.handle(accept("agentA", "handoff_1", "accept-a"), {
        token: "agentA",
      }),
      app.handle(accept("agentB", "handoff_1", "accept-b"), {
        token: "agentB",
      }),
    ]);

    expect(outcomes.map((value) => value.operation_status).sort()).toEqual([
      "accepted",
      "conflict",
    ]);
    expect(await persistence.readStream("handoff_1")).toHaveLength(2);
  });

  it("commits only one valid next state in an Accept and Cancel race", async () => {
    const persistence = new MemoryExchangePersistence();
    const app = application(persistence);
    await app.handle(offer(), { token: "human" });

    const outcomes = await Promise.all([
      app.handle(accept("agentA", "handoff_1", "accept-race"), {
        token: "agentA",
      }),
      app.handle(
        envelope(
          "cancel",
          "human",
          "cancel-race",
          { handoff_id: "handoff_1", reason: [] },
          1,
        ),
        { token: "human" },
      ),
    ]);

    expect(outcomes.map((value) => value.operation_status).sort()).toEqual([
      "accepted",
      "conflict",
    ]);
    const records = await persistence.readStream("handoff_1");
    expect(records).toHaveLength(2);
    expect([
      "workfabric.handoff.accepted.v1",
      "workfabric.handoff.cancelled.v1",
    ]).toContain(records[1]?.event_type);
  });

  it("commits exactly one of two Result Returns at one expected version", async () => {
    const persistence = new MemoryExchangePersistence();
    const app = application(persistence);
    await app.handle(offer(), { token: "human" });
    await app.handle(accept("agentA", "handoff_1", "accept-result"), {
      token: "agentA",
    });

    const outcomes = await Promise.all([
      app.handle(result("result-a"), { token: "agentA" }),
      app.handle(result("result-b"), { token: "agentA" }),
    ]);

    expect(outcomes.map((value) => value.operation_status).sort()).toEqual([
      "accepted",
      "conflict",
    ]);
    expect(await persistence.readStream("handoff_1")).toHaveLength(3);
  });

  it("changes neither stream when child Accept sees a stale parent", async () => {
    const persistence = new ConflictOnChildAcceptPersistence();
    const app = application(persistence);
    await app.handle(
      offer("offer-parent", offerPayload({ actor_id: "actor_agent_a" }, true)),
      { token: "human" },
    );
    await app.handle(accept("agentA", "handoff_1", "accept-parent"), {
      token: "agentA",
    });
    const transfer = await app.handle(
      envelope(
        "transfer",
        "agentA",
        "transfer-child",
        {
          parent_handoff_id: "handoff_1",
          child_offer: offerPayload({ actor_id: "actor_child" }),
        },
        2,
      ),
      { token: "agentA" },
    );
    expect(transfer).toMatchObject({
      operation_status: "accepted",
      resource: { resource_id: "handoff_2" },
    });
    const before = await streamLengths(persistence);
    persistence.conflictNextMulti = true;

    const accepted = await app.handle(
      accept("child", "handoff_2", "accept-child"),
      { token: "child" },
    );

    expect(accepted).toMatchObject({
      operation_status: "conflict",
      error: { code: "version_conflict" },
    });
    expect(await streamLengths(persistence)).toEqual(before);
    expect(
      await persistence.findCommand(tenantId, "accept-child"),
    ).toBeNull();
  });

  it("does not append accepted when referenced Context is unavailable", async () => {
    const persistence = new MemoryExchangePersistence();
    const contextBundle: JsonObject = {
      context_id: "context_concurrency",
      version: 1,
      created_at: "2026-07-15T08:00:00Z",
      items: [
        { kind: "text", media_type: "text/plain", text: "Required context" },
      ],
      visibility_scope: {
        actor_ids: ["actor_agent_a"],
        endpoint_ids: ["endpoint_agent_a"],
        expires_at: "2026-07-16T09:00:00Z",
      },
      digest: { algorithm: "sha-256", value: "context-digest" },
      extensions: {},
    };
    await application(persistence).handle(
      offer("offer-context", offerPayload(undefined, false, contextBundle)),
      { token: "human" },
    );

    const rejected = await application(
      persistence,
      new MemoryContextRepository(),
    ).handle(accept("agentA", "handoff_1", "accept-context"), {
      token: "agentA",
    });

    expect(rejected).toMatchObject({
      operation_status: "rejected",
      error: { code: "context_unavailable" },
    });
    expect(
      (await persistence.readStream("handoff_1")).map(
        ({ event_type }) => event_type,
      ),
    ).toEqual(["workfabric.handoff.offered.v1"]);
  });

  it("lets the same idempotency key retry after a temporary persistence exception", async () => {
    const persistence = new FailOncePersistence();
    const app = application(persistence);
    const first = offer("offer-retry");

    const failed = await app.handle(first, { token: "human" });
    const retried = await app.handle(
      { ...first, message_id: "message_offer_retry" },
      { token: "human" },
    );

    expect(failed).toMatchObject({
      operation_status: "temporarily_unavailable",
      error: { retryable: true },
    });
    expect(retried).toMatchObject({ operation_status: "accepted" });
    expect(await persistence.findCommand(tenantId, "offer-retry")).not.toBeNull();
  });
});
