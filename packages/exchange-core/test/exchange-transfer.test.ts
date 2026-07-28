import { beforeAll, describe, expect, it } from "vitest";

import { MemoryContextRepository } from "@work-fabric/adapter-context-memory";
import {
  LocalAuthorityPolicy,
  LocalIdentityProvider,
  type LocalAuthorityAllowRule,
  type LocalIdentityRecord,
} from "@work-fabric/adapter-identity-local";
import { MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import type {
  AtomicCommitRequest,
  AtomicCommitResult,
  EventRecord,
  JsonObject,
  ProposedEvent,
  ResolvedPrincipal,
} from "@work-fabric/exchange-spi";
import {
  loadWfppCommandValidator,
  loadWfppSchemaValidator,
  type WfppCommandValidator,
  type WfppSchemaValidator,
} from "@work-fabric/protocol-runtime";

import {
  ExchangeApplication,
  handoffEventFromJson,
  replayHandoff,
  type Clock,
  type CommandEnvelope,
  type IdGenerator,
  type OperationResult,
} from "../src/index.js";

const human: ResolvedPrincipal = {
  principal_id: "principal_human",
  tenant_id: "tenant_01",
  actor_claims: [
    {
      actor_id: "actor_human",
      actor_type: "human",
      endpoint_ids: ["endpoint_human"],
    },
  ],
  attributes: {},
};
const parentAgent: ResolvedPrincipal = {
  principal_id: "principal_parent",
  tenant_id: "tenant_01",
  actor_claims: [
    {
      actor_id: "actor_parent",
      actor_type: "agent",
      endpoint_ids: ["endpoint_parent"],
    },
  ],
  attributes: {},
};
const childAgent: ResolvedPrincipal = {
  principal_id: "principal_child",
  tenant_id: "tenant_01",
  actor_claims: [
    {
      actor_id: "actor_child",
      actor_type: "agent",
      endpoint_ids: ["endpoint_child"],
    },
  ],
  attributes: {},
};
const childAgentTenant2: ResolvedPrincipal = {
  ...childAgent,
  principal_id: "principal_child_tenant_02",
  tenant_id: "tenant_02",
};

const contextBundle: JsonObject = {
  context_id: "context_child",
  version: 1,
  created_at: "2026-07-15T02:30:00Z",
  items: [
    {
      kind: "text",
      media_type: "text/plain",
      text: "Immutable child handoff context",
    },
  ],
  visibility_scope: {
    actor_ids: ["actor_child"],
    endpoint_ids: ["endpoint_child"],
    expires_at: "2026-08-16T00:00:00Z",
  },
  digest: { algorithm: "sha-256", value: "child-context-digest" },
  extensions: {},
};

function offerPayload(
  targetActorId: string,
  mayRedelegate: boolean,
  context: JsonObject | null = null,
): JsonObject {
  return {
    work_reference: { uri: "urn:work:item:42", extensions: {} },
    target: { actor_id: targetActorId },
    intent: [
      {
        kind: "text",
        media_type: "text/plain",
        text: "Complete the delegated work",
      },
    ],
    ...(context === null ? {} : { context_bundle: context }),
    authority_scope: {
      delegation_id: mayRedelegate ? "delegation_parent" : "delegation_child",
      scopes: ["work:read"],
      resource_refs: ["urn:work:item:42"],
      expires_at: "2026-07-16T00:00:00Z",
      may_redelegate: mayRedelegate,
      extensions: {},
    },
    acceptance_criteria: [
      {
        criterion_id: "tests-pass",
        description: "Tests pass",
        required: true,
        result_schema_ref: null,
        required_evidence_types: [],
        extensions: {},
      },
    ],
    verifier: { actor_id: "actor_human", actor_type: "human" },
    priority: "normal",
    accept_by: "2026-07-15T08:00:00Z",
    result_due_at: "2026-07-15T10:00:00Z",
    extensions: {},
  };
}

function rootOffer(
  overrides: Partial<CommandEnvelope> = {},
): CommandEnvelope {
  return {
    spec_version: "1.0",
    message_id: "message_offer_parent",
    message_type: "workfabric.handoff.offer.v1",
    sent_at: "2026-07-15T01:00:00Z",
    tenant_id: "tenant_01",
    exchange_id: "exchange_01",
    actor_id: "actor_human",
    endpoint_id: "endpoint_human",
    delegation_id: "delegation_parent",
    idempotency_key: "offer-parent-01",
    payload: offerPayload("actor_parent", true),
    ...overrides,
  };
}

function parentAccept(): CommandEnvelope {
  return {
    spec_version: "1.0",
    message_id: "message_accept_parent",
    message_type: "workfabric.handoff.accept.v1",
    sent_at: "2026-07-15T02:00:00Z",
    tenant_id: "tenant_01",
    exchange_id: "exchange_01",
    actor_id: "actor_parent",
    endpoint_id: "endpoint_parent",
    delegation_id: "delegation_parent",
    idempotency_key: "accept-parent-01",
    expected_version: 1,
    payload: { handoff_id: "handoff_1" },
  };
}

function transfer(
  overrides: Partial<CommandEnvelope> = {},
  withContext = false,
): CommandEnvelope {
  return {
    spec_version: "1.0",
    message_id: "message_transfer",
    message_type: "workfabric.handoff.transfer.v1",
    sent_at: "2026-07-15T03:00:00Z",
    tenant_id: "tenant_01",
    exchange_id: "exchange_01",
    actor_id: "actor_parent",
    endpoint_id: "endpoint_parent",
    delegation_id: "delegation_parent",
    idempotency_key: "transfer-01",
    expected_version: 2,
    payload: {
      parent_handoff_id: "handoff_1",
      child_offer: offerPayload(
        "actor_child",
        false,
        withContext ? contextBundle : null,
      ),
    },
    ...overrides,
  };
}

function childAccept(
  handoffId = "handoff_2",
  overrides: Partial<CommandEnvelope> = {},
): CommandEnvelope {
  return {
    spec_version: "1.0",
    message_id: `message_accept_${handoffId}`,
    message_type: "workfabric.handoff.accept.v1",
    sent_at: "2026-07-15T04:00:00Z",
    tenant_id: "tenant_01",
    exchange_id: "exchange_01",
    actor_id: "actor_child",
    endpoint_id: "endpoint_child",
    delegation_id: "delegation_child",
    idempotency_key: `accept-${handoffId}-01`,
    expected_version: 1,
    payload: { handoff_id: handoffId },
    ...overrides,
  };
}

class TestClock implements Clock {
  private tick = 0;

  now(): string {
    this.tick += 1;
    return `2026-07-15T0${this.tick}:30:00Z`;
  }
}

class TestIds implements IdGenerator {
  private readonly counts = new Map<string, number>();
  readonly calls: string[] = [];

  constructor(private readonly handoffIds: readonly string[] = []) {}

  nextId(kind: "handoff" | "event" | "commit" | "receipt" | "delivery") {
    this.calls.push(kind);
    const count = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, count);
    const configuredHandoffId = this.handoffIds[count - 1];
    if (kind === "handoff" && configuredHandoffId !== undefined) {
      return configuredHandoffId;
    }
    return `${kind}_${count}`;
  }

  count(kind: string): number {
    return this.calls.filter((candidate) => candidate === kind).length;
  }
}

class TrackingContext extends MemoryContextRepository {
  putCalls = 0;
  availabilityCalls = 0;
  failNextPut = false;
  unavailableNext = false;

  override async putBundle(tenantId: string, bundle: JsonObject) {
    this.putCalls += 1;
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("context adapter secret=do-not-leak");
    }
    return super.putBundle(tenantId, bundle);
  }

  override async checkAvailability(
    request: Parameters<MemoryContextRepository["checkAvailability"]>[0],
  ) {
    this.availabilityCalls += 1;
    if (this.unavailableNext) {
      this.unavailableNext = false;
      return { kind: "unavailable" as const, reason: "Context is offline" };
    }
    return super.checkAvailability(request);
  }
}

class TrackingPersistence extends MemoryExchangePersistence {
  readonly readStreamIds: string[] = [];
  readonly commitRequests: AtomicCommitRequest[] = [];
  conflictStreamOnNextMulti: string | null = null;
  throwOnNextMulti = false;
  advanceParentBeforeNextChildOffer = false;
  advanceParentBeforeNextChildAccept = false;

  override async readStream(streamId: string, fromVersion?: number) {
    this.readStreamIds.push(streamId);
    return super.readStream(streamId, fromVersion);
  }

  override async commitAtomically(
    request: AtomicCommitRequest,
  ): Promise<AtomicCommitResult> {
    this.commitRequests.push(structuredClone(request));
    const racesChildOffer =
      this.advanceParentBeforeNextChildOffer &&
      request.appends.length === 1 &&
      request.appends[0]?.stream_id === "handoff_2";
    const racesChildAccept =
      this.advanceParentBeforeNextChildAccept &&
      request.appends.length === 2 &&
      request.appends.some((append) => append.stream_id === "handoff_1") &&
      request.appends.some((append) => append.stream_id === "handoff_2");
    if (racesChildOffer || racesChildAccept) {
      this.advanceParentBeforeNextChildOffer = false;
      this.advanceParentBeforeNextChildAccept = false;
      const parentRecords = await super.readStream("handoff_1");
      const lastParent = parentRecords.at(-1);
      if (lastParent === undefined) throw new Error("Missing parent race fixture");
      const racedEvent: ProposedEvent = {
        ...proposed(lastParent),
        event_id: "event_parent_race",
        event_type: "workfabric.handoff.status_reported.v1",
        request_message_id: "message_parent_race",
        idempotency_key: "parent-race",
        occurred_at: "2026-07-15T03:15:00Z",
        domain_data: {
          event_type: "workfabric.handoff.status_reported.v1",
          handoff_id: "handoff_1",
          status: { execution_status: "in_progress" },
          occurred_at: "2026-07-15T03:15:00Z",
        },
        protocol_data: {
          resource_version: 3,
          change: {
            change_type: "status_reported",
            from_state: "accepted",
            to_state: "accepted",
            changed_fields: ["latest_status", "resource_version", "updated_at"],
            details: { lifecycle_state: "accepted" },
          },
          receipt: null,
        },
      };
      const raced = await super.commitAtomically({
        tenant_id: "tenant_01",
        partition_id: lastParent.partition_id,
        commit_id: "commit_parent_race",
        idempotency_key: "parent-race",
        payload_digest: "sha256:parent-race",
        request_message_id: "message_parent_race",
        outcome: {
          operation_status: "accepted",
          resource: {
            resource_type: "handoff",
            resource_id: "handoff_1",
            resource_version: 3,
          },
          receipt: null,
          error: null,
        },
        version_checks: [],
        appends: [
          {
            stream_id: "handoff_1",
            expected_version: 2,
            events: [racedEvent],
          },
        ],
      });
      if (raced.kind !== "committed") {
        throw new Error("Parent race fixture did not commit");
      }
    }
    if (request.appends.length === 2 && this.throwOnNextMulti) {
      this.throwOnNextMulti = false;
      throw new Error("storage adapter password=do-not-leak");
    }
    if (
      request.appends.length === 2 &&
      this.conflictStreamOnNextMulti !== null
    ) {
      const conflictStream = this.conflictStreamOnNextMulti;
      this.conflictStreamOnNextMulti = null;
      const currentVersions = Object.fromEntries(
        await Promise.all(
          request.appends.map(async (append) => {
            const current = (await super.readStream(append.stream_id)).length;
            return [
              append.stream_id,
              append.stream_id === conflictStream ? current + 1 : current,
            ] as const;
          }),
        ),
      );
      return { kind: "version_conflict", current_versions: currentVersions };
    }
    return super.commitAtomically(request);
  }
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

function identities(): readonly LocalIdentityRecord[] {
  return [
    { authentication_evidence: { token: "human" }, principal: human },
    { authentication_evidence: { token: "parent" }, principal: parentAgent },
    { authentication_evidence: { token: "child" }, principal: childAgent },
    {
      authentication_evidence: { token: "child-tenant-02" },
      principal: childAgentTenant2,
    },
  ];
}

function rule(
  principal: ResolvedPrincipal,
  action: string,
  resourceId: string | null,
): LocalAuthorityAllowRule {
  const claim = principal.actor_claims[0];
  if (claim === undefined || claim.endpoint_ids[0] === undefined) {
    throw new Error("Invalid test principal");
  }
  return {
    tenant_id: principal.tenant_id,
    principal_id: principal.principal_id,
    actor_id: claim.actor_id,
    actor_type: claim.actor_type,
    endpoint_id: claim.endpoint_ids[0],
    action,
    resource_id: resourceId,
  };
}

function rules(): readonly LocalAuthorityAllowRule[] {
  return [
    rule(human, "workfabric.handoff.offer.v1", null),
    rule(parentAgent, "workfabric.handoff.accept.v1", "handoff_1"),
    rule(parentAgent, "workfabric.handoff.transfer.v1", "handoff_1"),
    ...["handoff_2", "handoff_bad_partition", "handoff_bad_thread"].flatMap(
      (handoffId) => [
        rule(childAgent, "workfabric.handoff.accept.v1", handoffId),
        rule(childAgent, "workfabric.handoff.claim.v1", handoffId),
        rule(
          childAgentTenant2,
          "workfabric.handoff.accept.v1",
          handoffId,
        ),
      ],
    ),
  ];
}

interface Harness {
  readonly application: ExchangeApplication;
  readonly persistence: TrackingPersistence;
  readonly context: TrackingContext;
  readonly ids: TestIds;
}

function harness(
  persistence = new TrackingPersistence(),
  context = new TrackingContext(),
  ids = new TestIds(),
  clock: Clock = new TestClock(),
): Harness {
  return {
    application: new ExchangeApplication({
      persistence,
      context,
      identity: new LocalIdentityProvider(identities()),
      authority: new LocalAuthorityPolicy(rules()),
      validator,
      clock,
      ids,
      target_eligibility: {
        manifest: {
          profile: "exchange.target-eligibility.v1",
          adapter: "transfer-test",
          capabilities: {
            explicit_target_only: true,
            no_candidate_selection: true,
            fail_closed: true,
          },
        },
        async verify() {
          return { kind: "eligible" as const };
        },
      },
    }),
    persistence,
    context,
    ids,
  };
}

function expectSchemaValid(result: OperationResult): void {
  expect(
    schemas.validate("urn:work-fabric:schema:v1:operation-result", result),
  ).toEqual({ valid: true });
}

async function createParentAndChild(
  current: Harness,
  withContext = false,
): Promise<{
  readonly offer: OperationResult;
  readonly accept: OperationResult;
  readonly transfer: OperationResult;
}> {
  const offer = await current.application.handle(rootOffer(), { token: "human" });
  const accept = await current.application.handle(parentAccept(), {
    token: "parent",
  });
  const transferResult = await current.application.handle(
    transfer({}, withContext),
    { token: "parent" },
  );
  return { offer, accept, transfer: transferResult };
}

async function state(
  persistence: TrackingPersistence,
  handoffId: string,
) {
  const records = await persistence.readStream(handoffId);
  return replayHandoff(
    records.map((record) => ({
      stream_version: record.stream_version,
      event: handoffEventFromJson(record.domain_data),
    })),
  );
}

function proposed(record: EventRecord): ProposedEvent {
  const {
    tenant_id: _tenantId,
    partition_id: _partitionId,
    partition_position: _partitionPosition,
    stream_id: _streamId,
    stream_version: _streamVersion,
    commit_id: _commitId,
    commit_ordinal: _commitOrdinal,
    ...event
  } = record;
  return event;
}

describe("ExchangeApplication Handoff Transfer", () => {
  it("offers a child in the parent Partition, then accepts child and transfers parent atomically", async () => {
    const current = harness();
    const created = await createParentAndChild(current);

    for (const result of Object.values(created)) expectSchemaValid(result);
    expect(created.transfer).toMatchObject({
      operation_status: "accepted",
      resource: {
        resource_type: "handoff",
        resource_id: "handoff_2",
        resource_version: 1,
      },
      receipt: null,
      error: null,
    });
    expect(await state(current.persistence, "handoff_1")).toMatchObject({
      lifecycle_state: "accepted",
      child_handoff_id: null,
    });
    expect(await state(current.persistence, "handoff_2")).toMatchObject({
      lifecycle_state: "offered",
      parent_handoff_id: "handoff_1",
      thread_id: "handoff_1",
    });
    expect(current.persistence.commitRequests.at(-1)).toMatchObject({
      version_checks: [
        { stream_id: "handoff_1", expected_version: 2 },
      ],
      appends: [
        { stream_id: "handoff_2", expected_version: 0 },
      ],
    });

    const parentBefore = await current.persistence.readStream("handoff_1");
    const childBefore = await current.persistence.readStream("handoff_2");
    expect(childBefore[0]?.partition_id).toBe(parentBefore[0]?.partition_id);
    const beforeCommitCount = current.persistence.commitRequests.length;

    const result = await current.application.handle(childAccept(), {
      token: "child",
    });

    expectSchemaValid(result);
    expect(result).toMatchObject({
      operation_status: "accepted",
      resource: {
        resource_type: "handoff",
        resource_id: "handoff_2",
        resource_version: 2,
      },
      receipt: {
        receipt_type: "responsibility_accepted",
        handoff_id: "handoff_2",
        actor_id: "actor_child",
      },
      error: null,
    });
    const atomicRequest = current.persistence.commitRequests.at(-1);
    expect(current.persistence.commitRequests).toHaveLength(beforeCommitCount + 1);
    expect(atomicRequest?.appends).toHaveLength(2);
    expect(atomicRequest?.appends.map((append) => append.stream_id)).toEqual([
      "handoff_2",
      "handoff_1",
    ]);
    expect(
      atomicRequest?.appends.flatMap((append) =>
        append.events.map((event) => [event.event_type, event.protocol_data.receipt]),
      ),
    ).toEqual([
      [
        "workfabric.handoff.accepted.v1",
        {
          receipt_id: expect.any(String),
          receipt_type: "responsibility_accepted",
        },
      ],
      ["workfabric.handoff.transferred.v1", null],
    ]);
    expect(await state(current.persistence, "handoff_2")).toMatchObject({
      lifecycle_state: "accepted",
      current_responsible_actor: {
        actor_id: "actor_child",
        actor_type: "agent",
      },
    });
    expect(await state(current.persistence, "handoff_1")).toMatchObject({
      lifecycle_state: "transferred",
      child_handoff_id: "handoff_2",
      current_responsible_actor: null,
    });
  });

  it("carries the current Claim fence through child Accept and transfers the parent atomically", async () => {
    const current = harness(
      undefined,
      undefined,
      undefined,
      { now: () => "2026-07-15T03:00:00Z" },
    );
    await current.application.handle(rootOffer(), { token: "human" });
    await current.application.handle(parentAccept(), { token: "parent" });
    const base = transfer();
    const payload = base.payload as {
      readonly parent_handoff_id: string;
      readonly child_offer: Record<string, unknown>;
    };
    const childOffer = payload.child_offer;
    const transferred = await current.application.handle({
      ...base,
      payload: {
        ...payload,
        child_offer: {
          ...childOffer,
          target: {
            capability_requirement: {
              capability_id: "software.implementation",
              assignment_mode: "eligible_pool_claim",
            },
          },
        },
      },
    }, { token: "parent" });
    expect(transferred).toMatchObject({
      operation_status: "accepted",
      resource: { resource_id: "handoff_2", resource_version: 1 },
    });
    expect(await state(current.persistence, "handoff_2")).toMatchObject({
      lifecycle_state: "claimable",
      parent_handoff_id: "handoff_1",
    });

    const claimed = await current.application.handle({
      ...childAccept(),
      message_id: "message_claim_child",
      message_type: "workfabric.handoff.claim.v1",
      idempotency_key: "claim-child-01",
      expected_version: 1,
      payload: {
        handoff_id: "handoff_2",
        claim_id: "claim_child",
        requested_lease_seconds: 60,
      },
    }, { token: "child" });
    expect(claimed).toMatchObject({
      operation_status: "accepted",
      resource: { resource_version: 2 },
      receipt: { receipt_type: "claim_acquired" },
    });

    const acceptedChild = await current.application.handle({
      ...childAccept(),
      expected_version: 2,
      payload: {
        handoff_id: "handoff_2",
        claim_id: "claim_child",
        fencing_token: 1,
      },
    }, { token: "child" });
    expect(acceptedChild, JSON.stringify(acceptedChild)).toMatchObject({
      operation_status: "accepted",
      resource: { resource_version: 3 },
      receipt: { receipt_type: "responsibility_accepted" },
    });
    expect(await state(current.persistence, "handoff_1")).toMatchObject({
      lifecycle_state: "transferred",
      child_handoff_id: "handoff_2",
    });
    expect(await state(current.persistence, "handoff_2")).toMatchObject({
      lifecycle_state: "accepted",
      recipient: { actor_id: "actor_child", actor_type: "agent" },
      active_claim: null,
    });
  });

  it("replays a same-key Transfer before generating a child or touching Context and streams", async () => {
    const current = harness();
    const created = await createParentAndChild(current, true);
    expect(created.transfer.operation_status).toBe("accepted");
    const counts = {
      handoff: current.ids.count("handoff"),
      event: current.ids.count("event"),
      commit: current.ids.count("commit"),
      put: current.context.putCalls,
      reads: current.persistence.readStreamIds.length,
      commits: current.persistence.commitRequests.length,
    };

    const replay = await current.application.handle(
      transfer({ message_id: "message_transfer_retry" }, true),
      { token: "parent" },
    );

    expectSchemaValid(replay);
    expect(replay).toEqual({
      ...created.transfer,
      request_message_id: "message_transfer_retry",
    });
    expect(current.ids.count("handoff")).toBe(counts.handoff);
    expect(current.ids.count("event")).toBe(counts.event);
    expect(current.ids.count("commit")).toBe(counts.commit);
    expect(current.context.putCalls).toBe(counts.put);
    expect(current.persistence.readStreamIds).toHaveLength(counts.reads);
    expect(current.persistence.commitRequests).toHaveLength(counts.commits);
  });

  it("records a safe conflict when the generated child ID collides with the parent stream", async () => {
    const ids = new TestIds(["handoff_1", "handoff_1"]);
    const current = harness(
      new TrackingPersistence(),
      new TrackingContext(),
      ids,
    );
    await current.application.handle(rootOffer(), { token: "human" });
    await current.application.handle(parentAccept(), { token: "parent" });
    const parentBefore = await current.persistence.readStream("handoff_1");

    const result = await current.application.handle(transfer({}, true), {
      token: "parent",
    });

    expectSchemaValid(result);
    expect(result).toMatchObject({
      operation_status: "conflict",
      resource: null,
      receipt: null,
      error: {
        code: "version_conflict",
        retryable: true,
        current_resource_version: null,
      },
    });
    expect(await current.persistence.readStream("handoff_1")).toEqual(
      parentBefore,
    );
    expect(
      await current.persistence.findCommand("tenant_01", "transfer-01"),
    ).toMatchObject({
      outcome: {
        operation_status: "conflict",
        resource: null,
        receipt: null,
        error: { code: "version_conflict" },
      },
    });
    expect(current.context.putCalls).toBe(0);
  });

  it("atomically checks the parent version when offering a child", async () => {
    const current = harness();
    await current.application.handle(rootOffer(), { token: "human" });
    await current.application.handle(parentAccept(), { token: "parent" });
    current.persistence.advanceParentBeforeNextChildOffer = true;

    const result = await current.application.handle(transfer(), {
      token: "parent",
    });

    expectSchemaValid(result);
    expect(result).toMatchObject({
      operation_status: "conflict",
      resource: null,
      receipt: null,
      error: {
        code: "version_conflict",
        retryable: true,
        current_resource_version: 3,
      },
    });
    expect(await current.persistence.readStream("handoff_1")).toHaveLength(3);
    expect(await current.persistence.readStream("handoff_2")).toEqual([]);
    expect(
      await current.persistence.findCommand("tenant_01", "transfer-01"),
    ).toBeNull();
  });

  it("persists and replays an eventless rejection when parent authority forbids redelegation", async () => {
    const current = harness();
    await current.application.handle(
      rootOffer({ payload: offerPayload("actor_parent", false) }),
      { token: "human" },
    );
    await current.application.handle(parentAccept(), { token: "parent" });

    const first = await current.application.handle(transfer(), {
      token: "parent",
    });

    expectSchemaValid(first);
    expect(first).toMatchObject({
      operation_status: "rejected",
      resource: null,
      receipt: null,
      error: { code: "permission_denied", retryable: false },
    });
    expect(current.persistence.commitRequests.at(-1)?.appends).toEqual([]);
    expect(await current.persistence.readStream("handoff_1")).toHaveLength(2);
    expect(await current.persistence.readStream("handoff_2")).toEqual([]);
    const counts = {
      ids: current.ids.calls.length,
      reads: current.persistence.readStreamIds.length,
      commits: current.persistence.commitRequests.length,
    };

    const replay = await current.application.handle(
      transfer({ message_id: "message_transfer_rejected_retry" }),
      { token: "parent" },
    );

    expect(replay).toEqual({
      ...first,
      request_message_id: "message_transfer_rejected_retry",
    });
    expect(current.ids.calls).toHaveLength(counts.ids);
    expect(current.persistence.readStreamIds).toHaveLength(counts.reads);
    expect(current.persistence.commitRequests).toHaveLength(counts.commits);
  });

  it.each(["handoff_1", "handoff_2"])(
    "maps a commit-time %s conflict without partially changing either stream",
    async (conflictingStream) => {
      const current = harness();
      await createParentAndChild(current);
      const parentBefore = await current.persistence.readStream("handoff_1");
      const childBefore = await current.persistence.readStream("handoff_2");
      current.persistence.conflictStreamOnNextMulti = conflictingStream;

      const result = await current.application.handle(childAccept(), {
        token: "child",
      });

      expectSchemaValid(result);
      expect(result).toMatchObject({
        operation_status: "conflict",
        resource: null,
        receipt: null,
        error: {
          code: "version_conflict",
          retryable: true,
          current_resource_version:
            conflictingStream === "handoff_2" ? 2 : 1,
        },
      });
      expect(await current.persistence.readStream("handoff_1")).toEqual(
        parentBefore,
      );
      expect(await current.persistence.readStream("handoff_2")).toEqual(
        childBefore,
      );
      expect(
        await current.persistence.findCommand(
          "tenant_01",
          childAccept().idempotency_key,
        ),
      ).toBeNull();
    },
  );

  it("leaves the child offered when the parent advances before child Accept commits", async () => {
    const current = harness();
    await createParentAndChild(current);
    current.persistence.advanceParentBeforeNextChildAccept = true;

    const result = await current.application.handle(childAccept(), {
      token: "child",
    });

    expectSchemaValid(result);
    expect(result).toMatchObject({
      operation_status: "conflict",
      resource: null,
      receipt: null,
      error: {
        code: "version_conflict",
        current_resource_version: 1,
      },
    });
    expect(
      (await current.persistence.readStream("handoff_2")).at(-1)?.event_type,
    ).toBe("workfabric.handoff.offered.v1");
    expect(
      (await current.persistence.readStream("handoff_1")).at(-1)?.event_type,
    ).toBe("workfabric.handoff.status_reported.v1");
    expect(
      await current.persistence.findCommand(
        "tenant_01",
        childAccept().idempotency_key,
      ),
    ).toBeNull();
  });

  it("replays an atomic child Accept without reading either stream or minting another Receipt", async () => {
    const current = harness();
    await createParentAndChild(current, true);
    const first = await current.application.handle(childAccept(), {
      token: "child",
    });
    const counts = {
      ids: current.ids.calls.length,
      reads: current.persistence.readStreamIds.length,
      commits: current.persistence.commitRequests.length,
      availability: current.context.availabilityCalls,
    };

    const replay = await current.application.handle(
      childAccept("handoff_2", { message_id: "message_accept_child_retry" }),
      { token: "child" },
    );

    expectSchemaValid(replay);
    expect(replay).toEqual({
      ...first,
      request_message_id: "message_accept_child_retry",
    });
    expect(current.ids.calls).toHaveLength(counts.ids);
    expect(current.persistence.readStreamIds).toHaveLength(counts.reads);
    expect(current.persistence.commitRequests).toHaveLength(counts.commits);
    expect(current.context.availabilityCalls).toBe(counts.availability);
  });

  it("checks child Context before loading the parent or preparing an atomic commit", async () => {
    const current = harness();
    await createParentAndChild(current, true);
    const parentBefore = await current.persistence.readStream("handoff_1");
    const childBefore = await current.persistence.readStream("handoff_2");
    const readsBefore = current.persistence.readStreamIds.length;
    const commitsBefore = current.persistence.commitRequests.length;
    const idCallsBefore = current.ids.calls.length;
    current.context.unavailableNext = true;

    const result = await current.application.handle(childAccept(), {
      token: "child",
    });

    expectSchemaValid(result);
    expect(result).toMatchObject({
      operation_status: "rejected",
      resource: null,
      receipt: null,
      error: { code: "context_unavailable", retryable: false },
    });
    expect(current.persistence.readStreamIds.slice(readsBefore)).toEqual([
      "handoff_2",
    ]);
    expect(current.persistence.commitRequests).toHaveLength(commitsBefore);
    expect(current.ids.calls).toHaveLength(idCallsBefore);
    expect(await current.persistence.readStream("handoff_1")).toEqual(
      parentBefore,
    );
    expect(await current.persistence.readStream("handoff_2")).toEqual(
      childBefore,
    );
  });

  it("rejects cross-tenant, cross-Exchange, and mismatched Partition lineage without commits", async () => {
    const current = harness();
    await createParentAndChild(current);
    const childRecord = (await current.persistence.readStream("handoff_2"))[0];
    if (childRecord === undefined) throw new Error("Missing child fixture");
    const childEvent = structuredClone(proposed(childRecord));
    const badEvent: ProposedEvent = {
      ...childEvent,
      event_id: "event_bad_partition",
      handoff_id: "handoff_bad_partition",
      domain_data: {
        ...childEvent.domain_data,
        handoff_id: "handoff_bad_partition",
      },
    };
    const seeded = await current.persistence.commitAtomically({
      tenant_id: "tenant_01",
      partition_id: "partition:wrong",
      commit_id: "commit_bad_partition",
      idempotency_key: "seed-bad-partition",
      payload_digest: "sha256:seed-bad-partition",
      request_message_id: "message_seed_bad_partition",
      outcome: {
        operation_status: "accepted",
        resource: {
          resource_type: "handoff",
          resource_id: "handoff_bad_partition",
          resource_version: 1,
        },
        receipt: null,
        error: null,
      },
      version_checks: [],
      appends: [
        {
          stream_id: "handoff_bad_partition",
          expected_version: 0,
          events: [badEvent],
        },
      ],
    });
    expect(seeded.kind).toBe("committed");
    const commitCount = current.persistence.commitRequests.length;

    const crossTenant = await current.application.handle(
      childAccept("handoff_2", {
        tenant_id: "tenant_02",
        idempotency_key: "accept-cross-tenant",
      }),
      { token: "child-tenant-02" },
    );
    const crossExchange = await current.application.handle(
      childAccept("handoff_2", {
        exchange_id: "exchange_02",
        idempotency_key: "accept-cross-exchange",
      }),
      { token: "child" },
    );
    const badPartition = await current.application.handle(
      childAccept("handoff_bad_partition"),
      { token: "child" },
    );

    for (const result of [crossTenant, crossExchange, badPartition]) {
      expectSchemaValid(result);
      expect(result).toMatchObject({
        operation_status: "rejected",
        resource: null,
        receipt: null,
        error: { code: "not_found", retryable: false },
      });
    }
    expect(current.persistence.commitRequests).toHaveLength(commitCount);
    expect(await current.persistence.readStream("handoff_1")).toHaveLength(2);
    expect(await current.persistence.readStream("handoff_2")).toHaveLength(1);
    expect(
      await current.persistence.readStream("handoff_bad_partition"),
    ).toHaveLength(1);
  });

  it("rejects a child whose thread does not match its parent lineage", async () => {
    const current = harness();
    await createParentAndChild(current);
    const childRecord = (await current.persistence.readStream("handoff_2"))[0];
    if (childRecord === undefined) throw new Error("Missing child fixture");
    const childEvent = structuredClone(proposed(childRecord));
    const badEvent: ProposedEvent = {
      ...childEvent,
      event_id: "event_bad_thread",
      handoff_id: "handoff_bad_thread",
      domain_data: {
        ...childEvent.domain_data,
        handoff_id: "handoff_bad_thread",
        thread_id: "thread_unrelated",
      },
    };
    const parentPartition = childRecord.partition_id;
    await current.persistence.commitAtomically({
      tenant_id: "tenant_01",
      partition_id: parentPartition,
      commit_id: "commit_bad_thread",
      idempotency_key: "seed-bad-thread",
      payload_digest: "sha256:seed-bad-thread",
      request_message_id: "message_seed_bad_thread",
      outcome: {
        operation_status: "accepted",
        resource: {
          resource_type: "handoff",
          resource_id: "handoff_bad_thread",
          resource_version: 1,
        },
        receipt: null,
        error: null,
      },
      version_checks: [],
      appends: [
        {
          stream_id: "handoff_bad_thread",
          expected_version: 0,
          events: [badEvent],
        },
      ],
    });
    const commitCount = current.persistence.commitRequests.length;

    const result = await current.application.handle(
      childAccept("handoff_bad_thread"),
      { token: "child" },
    );

    expectSchemaValid(result);
    expect(result).toMatchObject({
      operation_status: "rejected",
      resource: null,
      receipt: null,
      error: { code: "not_found", retryable: false },
    });
    expect(current.persistence.commitRequests).toHaveLength(commitCount);
  });

  it("normalizes Context and persistence adapter exceptions without persisting partial Transfer facts", async () => {
    const contextFailure = harness();
    await contextFailure.application.handle(rootOffer(), { token: "human" });
    await contextFailure.application.handle(parentAccept(), { token: "parent" });
    contextFailure.context.failNextPut = true;
    const commitsBeforeContext = contextFailure.persistence.commitRequests.length;
    const failedTransfer = await contextFailure.application.handle(
      transfer({}, true),
      { token: "parent" },
    );

    expectSchemaValid(failedTransfer);
    expect(failedTransfer).toMatchObject({
      operation_status: "temporarily_unavailable",
      error: { code: "temporarily_unavailable", retryable: true },
    });
    expect(JSON.stringify(failedTransfer)).not.toContain("do-not-leak");
    expect(contextFailure.persistence.commitRequests).toHaveLength(
      commitsBeforeContext,
    );
    expect(await contextFailure.persistence.readStream("handoff_2")).toEqual([]);
    expect(
      await contextFailure.persistence.findCommand("tenant_01", "transfer-01"),
    ).toBeNull();

    const persistenceFailure = harness();
    await createParentAndChild(persistenceFailure, true);
    persistenceFailure.persistence.throwOnNextMulti = true;
    const parentBefore = await persistenceFailure.persistence.readStream(
      "handoff_1",
    );
    const childBefore = await persistenceFailure.persistence.readStream(
      "handoff_2",
    );
    const failedAccept = await persistenceFailure.application.handle(
      childAccept(),
      { token: "child" },
    );

    expectSchemaValid(failedAccept);
    expect(failedAccept).toMatchObject({
      operation_status: "temporarily_unavailable",
      error: { code: "temporarily_unavailable", retryable: true },
    });
    expect(JSON.stringify(failedAccept)).not.toContain("do-not-leak");
    expect(await persistenceFailure.persistence.readStream("handoff_1")).toEqual(
      parentBefore,
    );
    expect(await persistenceFailure.persistence.readStream("handoff_2")).toEqual(
      childBefore,
    );
    expect(
      await persistenceFailure.persistence.findCommand(
        "tenant_01",
        childAccept().idempotency_key,
      ),
    ).toBeNull();
  });
});
