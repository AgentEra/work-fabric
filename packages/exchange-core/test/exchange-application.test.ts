import { createHash } from "node:crypto";

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
  ContextRepository,
  EventRecord,
  ExchangePersistence,
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
  canonicalJson,
  ExchangeApplication,
  handoffEventFromJson,
  replayHandoff,
  type Clock,
  type CommandEnvelope,
  type IdGenerator,
} from "../src/index.js";

const humanPrincipal: ResolvedPrincipal = {
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

const agentPrincipal: ResolvedPrincipal = {
  principal_id: "principal_agent",
  tenant_id: "tenant_01",
  actor_claims: [
    {
      actor_id: "actor_agent",
      actor_type: "agent",
      endpoint_ids: ["endpoint_agent"],
    },
  ],
  attributes: {},
};

const verifierPrincipal: ResolvedPrincipal = {
  principal_id: "principal_verifier",
  tenant_id: "tenant_01",
  actor_claims: [
    {
      actor_id: "actor_verifier",
      actor_type: "system",
      endpoint_ids: ["endpoint_verifier"],
    },
  ],
  attributes: {},
};

const offerPayload: JsonObject = {
  work_reference: { uri: "urn:work:item:42", extensions: {} },
  target: { actor_id: "actor_agent" },
  intent: [
    {
      kind: "text",
      media_type: "text/plain",
      text: "Implement the approved change",
    },
  ],
  authority_scope: {
    delegation_id: "delegation_01",
    scopes: ["work:read"],
    resource_refs: ["urn:work:item:42"],
    expires_at: "2026-07-15T08:00:00Z",
    may_redelegate: false,
  },
  acceptance_criteria: [
    {
      criterion_id: "tests-pass",
      description: "Tests pass",
      required: true,
      result_schema_ref: null,
      required_evidence_types: ["test_report"],
    },
  ],
  verifier: { actor_id: "actor_verifier", actor_type: "system" },
  priority: "normal",
  accept_by: "2026-07-15T06:00:00Z",
  result_due_at: "2026-07-15T08:00:00Z",
};

const contextBundle: JsonObject = {
  context_id: "context_01",
  version: 1,
  created_at: "2026-07-15T00:30:00Z",
  items: [
    {
      kind: "text",
      media_type: "text/plain",
      text: "Immutable approved context",
    },
  ],
  visibility_scope: {
    actor_ids: ["actor_agent"],
    endpoint_ids: ["endpoint_agent"],
    expires_at: "2026-07-16T00:00:00Z",
  },
  digest: { algorithm: "sha-256", value: "context-digest" },
  extensions: {},
};

function offerEnvelope(
  overrides: Partial<CommandEnvelope> = {},
): CommandEnvelope {
  return {
    spec_version: "1.0",
    message_id: "message_offer_01",
    message_type: "workfabric.handoff.offer.v1",
    sent_at: "2026-07-15T01:00:00Z",
    tenant_id: "tenant_01",
    exchange_id: "exchange_01",
    actor_id: "actor_human",
    endpoint_id: "endpoint_human",
    delegation_id: "delegation_01",
    idempotency_key: "offer-01",
    payload: offerPayload,
    ...overrides,
  };
}

type ExistingInteraction =
  | "accept"
  | "report_status"
  | "return_result"
  | "verify"
  | "close";

function existingEnvelope(
  interaction: ExistingInteraction,
  payload: JsonObject,
  options: {
    readonly actor: "agent" | "verifier";
    readonly expectedVersion: number;
    readonly idempotencyKey?: string;
    readonly messageId?: string;
  },
): CommandEnvelope {
  const agent = options.actor === "agent";
  return {
    spec_version: "1.0",
    message_id: options.messageId ?? `message_${interaction}`,
    message_type: `workfabric.handoff.${interaction}.v1`,
    sent_at: "2026-07-15T03:00:00Z",
    tenant_id: "tenant_01",
    exchange_id: "exchange_01",
    actor_id: agent ? "actor_agent" : "actor_verifier",
    endpoint_id: agent ? "endpoint_agent" : "endpoint_verifier",
    delegation_id: "delegation_01",
    idempotency_key: options.idempotencyKey ?? `${interaction}-01`,
    expected_version: options.expectedVersion,
    payload,
  };
}

class TestClock implements Clock {
  value = "2026-07-15T02:00:00Z";

  constructor(private readonly order?: string[]) {}

  now(): string {
    this.order?.push("clock.now");
    return this.value;
  }
}

class TestIds implements IdGenerator {
  private readonly counts = new Map<string, number>();
  readonly calls: string[] = [];

  constructor(
    private readonly order?: string[],
    private readonly handoffIds: readonly string[] = [],
  ) {}

  nextId(kind: "handoff" | "event" | "commit" | "receipt" | "delivery") {
    this.order?.push(`ids.${kind}`);
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

class TrackingIdentityProvider extends LocalIdentityProvider {
  resolveCalls = 0;

  constructor(
    records: readonly LocalIdentityRecord[],
    private readonly order?: string[],
  ) {
    super(records);
  }

  override async resolve(authenticationEvidence: JsonObject) {
    this.resolveCalls += 1;
    this.order?.push("identity.resolve");
    return super.resolve(authenticationEvidence);
  }
}

class TrackingAuthorityPolicy extends LocalAuthorityPolicy {
  authorizeCalls = 0;

  constructor(
    rules: readonly LocalAuthorityAllowRule[],
    private readonly order?: string[],
  ) {
    super(rules);
  }

  override async authorize(
    request: Parameters<LocalAuthorityPolicy["authorize"]>[0],
  ) {
    this.authorizeCalls += 1;
    this.order?.push("authority.authorize");
    return super.authorize(request);
  }
}

class TrackingMemoryPersistence extends MemoryExchangePersistence {
  findCommandCalls = 0;
  readStreamCalls = 0;
  commitCalls = 0;
  readonly commitRequests: AtomicCommitRequest[] = [];

  constructor(private readonly order?: string[]) {
    super();
  }

  override async findCommand(tenantId: string, idempotencyKey: string) {
    this.findCommandCalls += 1;
    this.order?.push("persistence.findCommand");
    return super.findCommand(tenantId, idempotencyKey);
  }

  override async readStream(streamId: string, fromVersion?: number) {
    this.readStreamCalls += 1;
    this.order?.push("persistence.readStream");
    return super.readStream(streamId, fromVersion);
  }

  override async commitAtomically(request: AtomicCommitRequest) {
    this.commitCalls += 1;
    this.order?.push("persistence.commitAtomically");
    this.commitRequests.push(structuredClone(request));
    return super.commitAtomically(request);
  }
}

class TrackingContextRepository extends MemoryContextRepository {
  putBundleCalls = 0;
  checkAvailabilityCalls = 0;

  constructor(private readonly order?: string[]) {
    super();
  }

  override async putBundle(tenantId: string, bundle: JsonObject) {
    this.putBundleCalls += 1;
    this.order?.push("context.putBundle");
    return super.putBundle(tenantId, bundle);
  }

  override async checkAvailability(
    request: Parameters<MemoryContextRepository["checkAvailability"]>[0],
  ) {
    this.checkAvailabilityCalls += 1;
    this.order?.push("context.checkAvailability");
    return super.checkAvailability(request);
  }
}

class TrackingValidator implements WfppCommandValidator {
  validateCalls = 0;

  constructor(
    private readonly delegate: WfppCommandValidator,
    private readonly order?: string[],
  ) {}

  validate(envelope: unknown) {
    this.validateCalls += 1;
    this.order?.push("validator.validate");
    return this.delegate.validate(envelope);
  }

  payloadSchemaId(messageType: string): string | null {
    return this.delegate.payloadSchemaId(messageType);
  }
}

class FailOnceMemoryPersistence extends MemoryExchangePersistence {
  private shouldFail = true;

  override async commitAtomically(request: AtomicCommitRequest) {
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new Error("database password=super-secret was rejected");
    }
    return super.commitAtomically(request);
  }
}

class RaceConflictPersistence extends MemoryExchangePersistence {
  failNextCommit = false;
  conflictedRequest: AtomicCommitRequest | null = null;

  override async commitAtomically(
    request: AtomicCommitRequest,
  ): Promise<AtomicCommitResult> {
    if (!this.failNextCommit) {
      return super.commitAtomically(request);
    }
    this.failNextCommit = false;
    this.conflictedRequest = structuredClone(request);
    return {
      kind: "version_conflict",
      current_versions: { handoff_1: 7 },
    };
  }
}

class BoundaryConflictPersistence extends MemoryExchangePersistence {
  constructor(
    private readonly currentVersions: Readonly<Record<string, number>>,
  ) {
    super();
  }

  override async commitAtomically(): Promise<AtomicCommitResult> {
    return {
      kind: "version_conflict",
      current_versions: this.currentVersions,
    };
  }
}

function proposedEvent(record: EventRecord): ProposedEvent {
  const {
    tenant_id: _tenantId,
    partition_id: _partitionId,
    partition_position: _partitionPosition,
    stream_id: _streamId,
    stream_version: _streamVersion,
    commit_id: _commitId,
    commit_ordinal: _commitOrdinal,
    ...proposed
  } = record;
  return proposed;
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

function identityRecords(): readonly LocalIdentityRecord[] {
  return [
    { authentication_evidence: { token: "human" }, principal: humanPrincipal },
    { authentication_evidence: { token: "agent" }, principal: agentPrincipal },
    {
      authentication_evidence: { token: "verifier" },
      principal: verifierPrincipal,
    },
  ];
}

function allowRules(): readonly LocalAuthorityAllowRule[] {
  return [
    {
      tenant_id: "tenant_01",
      principal_id: "principal_human",
      actor_id: "actor_human",
      actor_type: "human",
      endpoint_id: "endpoint_human",
      action: "workfabric.handoff.offer.v1",
      resource_id: null,
    },
    ...["accept", "report_status", "return_result"].map(
      (action): LocalAuthorityAllowRule => ({
        tenant_id: "tenant_01",
        principal_id: "principal_agent",
        actor_id: "actor_agent",
        actor_type: "agent",
        endpoint_id: "endpoint_agent",
        action: `workfabric.handoff.${action}.v1`,
        resource_id: "handoff_1",
      }),
    ),
    ...["verify", "close"].map(
      (action): LocalAuthorityAllowRule => ({
        tenant_id: "tenant_01",
        principal_id: "principal_verifier",
        actor_id: "actor_verifier",
        actor_type: "system",
        endpoint_id: "endpoint_verifier",
        action: `workfabric.handoff.${action}.v1`,
        resource_id: "handoff_1",
      }),
    ),
  ];
}

interface Harness {
  readonly application: ExchangeApplication;
  readonly persistence: ExchangePersistence;
  readonly context: ContextRepository;
  readonly ids: TestIds;
  readonly identity: TrackingIdentityProvider;
  readonly authority: TrackingAuthorityPolicy;
  readonly validator: TrackingValidator;
}

function harness(options: {
  readonly persistence?: ExchangePersistence;
  readonly context?: ContextRepository;
  readonly identityRecords?: readonly LocalIdentityRecord[];
  readonly allowRules?: readonly LocalAuthorityAllowRule[];
  readonly validator?: WfppCommandValidator;
  readonly order?: string[];
  readonly ids?: TestIds;
} = {}): Harness {
  const persistence =
    options.persistence ?? new TrackingMemoryPersistence(options.order);
  const context =
    options.context ?? new TrackingContextRepository(options.order);
  const ids = options.ids ?? new TestIds(options.order);
  const identity = new TrackingIdentityProvider(
    options.identityRecords ?? identityRecords(),
    options.order,
  );
  const authority = new TrackingAuthorityPolicy(
    options.allowRules ?? allowRules(),
    options.order,
  );
  const commandValidator = new TrackingValidator(
    options.validator ?? validator,
    options.order,
  );
  return {
    application: new ExchangeApplication({
      persistence,
      identity,
      authority,
      context,
      validator: commandValidator,
      clock: new TestClock(options.order),
      ids,
    }),
    persistence,
    context,
    ids,
    identity,
    authority,
    validator: commandValidator,
  };
}

function expectSchemaValid(value: unknown): void {
  expect(
    schemas.validate("urn:work-fabric:schema:v1:operation-result", value),
  ).toEqual({ valid: true });
}

describe("ExchangeApplication", () => {
  it("normalizes a Validator exception before any downstream side effects", async () => {
    const order: string[] = [];
    const persistence = new TrackingMemoryPersistence(order);
    const context = new TrackingContextRepository(order);
    const throwingValidator: WfppCommandValidator = {
      validate() {
        throw new Error("schema registry password=validator-secret failed");
      },
      payloadSchemaId() {
        return null;
      },
    };
    const current = harness({
      persistence,
      context,
      validator: throwingValidator,
      order,
    });

    const result = await current.application.handle(offerEnvelope(), {
      token: "human",
    });

    expect(result).toMatchObject({
      operation_status: "temporarily_unavailable",
      resource: null,
      receipt: null,
      error: { code: "temporarily_unavailable", retryable: true },
    });
    expectSchemaValid(result);
    expect(JSON.stringify(result)).not.toContain("validator-secret");
    expect(order).toEqual(["validator.validate"]);
    expect(current.identity.resolveCalls).toBe(0);
    expect(current.authority.authorizeCalls).toBe(0);
    expect(persistence.findCommandCalls).toBe(0);
    expect(persistence.readStreamCalls).toBe(0);
    expect(persistence.commitCalls).toBe(0);
    expect(context.putBundleCalls).toBe(0);
    expect(context.checkAvailabilityCalls).toBe(0);
    expect(current.ids.calls).toEqual([]);
  });

  it("creates a Schema-valid offered root stream in its stable Partition", async () => {
    const { application, persistence } = harness();

    const result = await application.handle(offerEnvelope(), { token: "human" });

    expect(result).toEqual({
      spec_version: "1.0",
      request_message_id: "message_offer_01",
      operation_status: "accepted",
      resource: {
        resource_type: "handoff",
        resource_id: "handoff_1",
        resource_version: 1,
      },
      receipt: null,
      error: null,
    });
    expectSchemaValid(result);
    const events = await persistence.readStream("handoff_1");
    const expectedPartition = `partition:${createHash("sha256")
      .update(
        canonicalJson({
          tenant_id: "tenant_01",
          root_handoff_id: "handoff_1",
        }),
        "utf8",
      )
      .digest("hex")}`;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_id: "event_1",
      event_type: "workfabric.handoff.offered.v1",
      tenant_id: "tenant_01",
      exchange_id: "exchange_01",
      stream_id: "handoff_1",
      stream_version: 1,
      partition_id: expectedPartition,
      protocol_data: { receipt: null },
    });
  });

  it("replays the saved outcome with a new message ID before any side effects", async () => {
    const persistence = new TrackingMemoryPersistence();
    const context = new TrackingContextRepository();
    const { application, ids } = harness({ persistence, context });
    const command = offerEnvelope({
      payload: { ...offerPayload, context_bundle: contextBundle },
    });
    const first = await application.handle(command, { token: "human" });
    const callsAfterFirst = [...ids.calls];

    const replay = await application.handle(
      {
        ...command,
        message_id: "message_offer_retry",
        sent_at: "2026-07-15T02:05:00Z",
      },
      { token: "human" },
    );

    expect(replay).toEqual({
      ...first,
      request_message_id: "message_offer_retry",
    });
    expect(replay.resource).toEqual(first.resource);
    expect(replay.receipt).toEqual(first.receipt);
    expect(ids.calls).toEqual(callsAfterFirst);
    expect(persistence.readStreamCalls).toBe(1);
    expect(persistence.commitCalls).toBe(1);
    expect(context.putBundleCalls).toBe(1);
  });

  it("runs validation, Identity, trusted Actor, and Authority before replay lookup", async () => {
    const order: string[] = [];
    const persistence = new TrackingMemoryPersistence(order);
    const context = new TrackingContextRepository(order);
    const seed = harness({ persistence, context, order });
    const command = offerEnvelope();
    const first = await seed.application.handle(command, { token: "human" });
    const readsAfterSeed = persistence.readStreamCalls;
    const commitsAfterSeed = persistence.commitCalls;
    order.length = 0;
    const replayHarness = harness({ persistence, context, order });

    const replay = await replayHarness.application.handle(
      { ...command, message_id: "message_secure_replay" },
      { token: "human" },
    );

    expect(replay).toEqual({
      ...first,
      request_message_id: "message_secure_replay",
    });
    expect(order).toEqual([
      "validator.validate",
      "identity.resolve",
      "authority.authorize",
      "persistence.findCommand",
    ]);
    expect(replayHarness.identity.resolveCalls).toBe(1);
    expect(replayHarness.authority.authorizeCalls).toBe(1);
    expect(persistence.readStreamCalls).toBe(readsAfterSeed);
    expect(persistence.commitCalls).toBe(commitsAfterSeed);
    expect(context.putBundleCalls).toBe(0);
    expect(context.checkAvailabilityCalls).toBe(0);
    expect(replayHarness.ids.calls).toEqual([]);
  });

  it("stops invalid and untrusted retries before deduplication or side effects", async () => {
    const order: string[] = [];
    const persistence = new TrackingMemoryPersistence(order);
    const context = new TrackingContextRepository(order);
    const command = offerEnvelope();
    await harness({ persistence, context, order }).application.handle(command, {
      token: "human",
    });
    const baseline = {
      find: persistence.findCommandCalls,
      read: persistence.readStreamCalls,
      commit: persistence.commitCalls,
      put: context.putBundleCalls,
      check: context.checkAvailabilityCalls,
    };

    const assertNoLateSideEffects = (current: Harness): void => {
      expect(persistence.findCommandCalls).toBe(baseline.find);
      expect(persistence.readStreamCalls).toBe(baseline.read);
      expect(persistence.commitCalls).toBe(baseline.commit);
      expect(context.putBundleCalls).toBe(baseline.put);
      expect(context.checkAvailabilityCalls).toBe(baseline.check);
      expect(current.ids.calls).toEqual([]);
    };

    order.length = 0;
    const invalid = harness({ persistence, context, order });
    const invalidResult = await invalid.application.handle(
      { ...command, payload: { target: { actor_id: "actor_agent" } } },
      { token: "human" },
    );
    expect(invalidResult).toMatchObject({
      operation_status: "rejected",
      error: { code: "invalid_argument" },
    });
    expect(order).toEqual(["validator.validate"]);
    expect(invalid.identity.resolveCalls).toBe(0);
    expect(invalid.authority.authorizeCalls).toBe(0);
    assertNoLateSideEffects(invalid);

    order.length = 0;
    const unauthenticated = harness({ persistence, context, order });
    const unauthenticatedResult = await unauthenticated.application.handle(
      { ...command, message_id: "message_unauthenticated_retry" },
      { token: "unknown" },
    );
    expect(unauthenticatedResult).toMatchObject({
      operation_status: "rejected",
      error: { code: "unauthenticated" },
    });
    expect(order).toEqual(["validator.validate", "identity.resolve"]);
    expect(unauthenticated.authority.authorizeCalls).toBe(0);
    assertNoLateSideEffects(unauthenticated);

    const unrepresentedPrincipal: ResolvedPrincipal = {
      ...humanPrincipal,
      actor_claims: [
        {
          actor_id: "actor_other",
          actor_type: "human",
          endpoint_ids: ["endpoint_human"],
        },
      ],
    };
    order.length = 0;
    const unrepresented = harness({
      persistence,
      context,
      order,
      identityRecords: [
        {
          authentication_evidence: { token: "unrepresented" },
          principal: unrepresentedPrincipal,
        },
      ],
    });
    const unrepresentedResult = await unrepresented.application.handle(
      { ...command, message_id: "message_unrepresented_retry" },
      { token: "unrepresented" },
    );
    expect(unrepresentedResult).toMatchObject({
      operation_status: "rejected",
      error: { code: "permission_denied" },
    });
    expect(order).toEqual(["validator.validate", "identity.resolve"]);
    expect(unrepresented.authority.authorizeCalls).toBe(0);
    assertNoLateSideEffects(unrepresented);

    order.length = 0;
    const unauthorized = harness({
      persistence,
      context,
      order,
      allowRules: [],
    });
    const unauthorizedResult = await unauthorized.application.handle(
      { ...command, message_id: "message_unauthorized_retry" },
      { token: "human" },
    );
    expect(unauthorizedResult).toMatchObject({
      operation_status: "rejected",
      error: { code: "permission_denied" },
    });
    expect(order).toEqual([
      "validator.validate",
      "identity.resolve",
      "authority.authorize",
    ]);
    assertNoLateSideEffects(unauthorized);
  });

  it("executes a Context-bearing root Offer in the exact dependency order", async () => {
    const order: string[] = [];
    const persistence = new TrackingMemoryPersistence(order);
    const context = new TrackingContextRepository(order);
    const current = harness({ persistence, context, order });

    const result = await current.application.handle(
      offerEnvelope({
        payload: { ...offerPayload, context_bundle: contextBundle },
      }),
      { token: "human" },
    );

    expect(result.operation_status).toBe("accepted");
    expect(order).toEqual([
      "validator.validate",
      "identity.resolve",
      "authority.authorize",
      "persistence.findCommand",
      "ids.handoff",
      "context.putBundle",
      "persistence.readStream",
      "clock.now",
      "ids.event",
      "ids.commit",
      "persistence.commitAtomically",
    ]);
  });

  it("returns idempotency_key_reused for changed Payload before side effects", async () => {
    const persistence = new TrackingMemoryPersistence();
    const context = new TrackingContextRepository();
    const { application, ids } = harness({ persistence, context });
    const command = offerEnvelope({
      payload: { ...offerPayload, context_bundle: contextBundle },
    });
    await application.handle(command, { token: "human" });
    const callsAfterFirst = [...ids.calls];

    const result = await application.handle(
      {
        ...command,
        message_id: "message_changed",
        payload: { ...command.payload, priority: "high" },
      },
      { token: "human" },
    );

    expect(result).toMatchObject({
      request_message_id: "message_changed",
      operation_status: "conflict",
      resource: null,
      receipt: null,
      error: { code: "idempotency_key_reused", retryable: false },
    });
    expect(ids.calls).toEqual(callsAfterFirst);
    expect(persistence.readStreamCalls).toBe(1);
    expect(persistence.commitCalls).toBe(1);
    expect(context.putBundleCalls).toBe(1);
  });

  it("normalizes validation, authentication, Actor claim, and Authority failures", async () => {
    const invalid = harness();
    const invalidResult = await invalid.application.handle(
      offerEnvelope({ payload: { target: { actor_id: "actor_agent" } } }),
      { token: "human" },
    );
    const unknown = harness();
    const unknownResult = await unknown.application.handle(offerEnvelope(), {
      token: "unknown",
    });
    const otherTenantPrincipal: ResolvedPrincipal = {
      ...humanPrincipal,
      principal_id: "principal_other_tenant",
      tenant_id: "tenant_02",
    };
    const crossTenant = harness({
      identityRecords: [
        {
          authentication_evidence: { token: "other-tenant" },
          principal: otherTenantPrincipal,
        },
      ],
    });
    const crossTenantResult = await crossTenant.application.handle(
      offerEnvelope(),
      { token: "other-tenant" },
    );
    const unrepresentedPrincipal: ResolvedPrincipal = {
      ...humanPrincipal,
      actor_claims: [
        {
          actor_id: "actor_other",
          actor_type: "human",
          endpoint_ids: ["endpoint_human"],
        },
      ],
    };
    const unrepresented = harness({
      identityRecords: [
        {
          authentication_evidence: { token: "unrepresented" },
          principal: unrepresentedPrincipal,
        },
      ],
    });
    const unrepresentedResult = await unrepresented.application.handle(
      offerEnvelope(),
      { token: "unrepresented" },
    );
    const unauthorized = harness({ allowRules: [] });
    const unauthorizedResult = await unauthorized.application.handle(
      offerEnvelope(),
      { token: "human" },
    );

    expect(invalidResult).toMatchObject({
      operation_status: "rejected",
      error: {
        code: "invalid_argument",
        field_violations: expect.arrayContaining([
          {
            field: "/payload",
            description: "must have required property 'work_reference'",
          },
        ]),
      },
    });
    for (const result of [unknownResult, crossTenantResult]) {
      expect(result).toMatchObject({
        operation_status: "rejected",
        resource: null,
        receipt: null,
        error: { code: "unauthenticated", retryable: false },
      });
    }
    for (const result of [unrepresentedResult, unauthorizedResult]) {
      expect(result).toMatchObject({
        operation_status: "rejected",
        resource: null,
        receipt: null,
        error: { code: "permission_denied", retryable: false },
      });
    }
    for (const result of [
      invalidResult,
      unknownResult,
      crossTenantResult,
      unrepresentedResult,
      unauthorizedResult,
    ]) {
      expectSchemaValid(result);
    }
    expect(invalid.ids.calls).toEqual([]);
    expect(unknown.ids.calls).toEqual([]);
    expect(crossTenant.ids.calls).toEqual([]);
    expect(unrepresented.ids.calls).toEqual([]);
    expect(unauthorized.ids.calls).toEqual([]);
  });

  it("accepts responsibility with one Receipt and rejects a stale version without IDs", async () => {
    const { application, persistence, ids } = harness();
    await application.handle(offerEnvelope(), { token: "human" });
    const callsAfterOffer = [...ids.calls];
    const stale = await application.handle(
      existingEnvelope(
        "accept",
        { handoff_id: "handoff_1" },
        { actor: "agent", expectedVersion: 2, idempotencyKey: "accept-stale" },
      ),
      { token: "agent" },
    );
    expect(stale).toMatchObject({
      operation_status: "conflict",
      resource: null,
      receipt: null,
      error: {
        code: "version_conflict",
        retryable: true,
        current_resource_version: 1,
        details: { expected_version: 2 },
      },
    });
    expect(ids.calls).toEqual(callsAfterOffer);

    const accepted = await application.handle(
      existingEnvelope(
        "accept",
        { handoff_id: "handoff_1" },
        { actor: "agent", expectedVersion: 1 },
      ),
      { token: "agent" },
    );
    expect(accepted).toMatchObject({
      operation_status: "accepted",
      resource: { resource_id: "handoff_1", resource_version: 2 },
      receipt: {
        receipt_id: "receipt_1",
        receipt_type: "responsibility_accepted",
        handoff_id: "handoff_1",
        actor_id: "actor_agent",
        endpoint_id: "endpoint_agent",
        resource_version: 2,
      },
      error: null,
    });
    expectSchemaValid(accepted);
    const events = await persistence.readStream("handoff_1");
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      event_type: "workfabric.handoff.accepted.v1",
      partition_id: events[0]?.partition_id,
    });
  });

  it("maps a commit-time version race without persisting the proposed Event", async () => {
    const persistence = new RaceConflictPersistence();
    const current = harness({ persistence });
    await current.application.handle(offerEnvelope(), { token: "human" });
    persistence.failNextCommit = true;

    const result = await current.application.handle(
      existingEnvelope(
        "accept",
        { handoff_id: "handoff_1" },
        { actor: "agent", expectedVersion: 1, idempotencyKey: "accept-race" },
      ),
      { token: "agent" },
    );

    expect(result).toMatchObject({
      operation_status: "conflict",
      resource: null,
      receipt: null,
      error: {
        code: "version_conflict",
        retryable: true,
        current_resource_version: 7,
      },
    });
    expectSchemaValid(result);
    expect(persistence.conflictedRequest).toMatchObject({
      partition_id: expect.stringMatching(/^partition:/),
      appends: [
        {
          stream_id: "handoff_1",
          expected_version: 1,
          events: [{ event_type: "workfabric.handoff.accepted.v1" }],
        },
      ],
    });
    expect(await persistence.readStream("handoff_1")).toHaveLength(1);
    expect(
      await persistence.findCommand("tenant_01", "accept-race"),
    ).toBeNull();
  });

  it.each([
    ["a missing own key", {}],
    ["NaN", { constructor: Number.NaN }],
    ["infinity", { constructor: Number.POSITIVE_INFINITY }],
    ["a fractional value", { constructor: 1.5 }],
    ["an unsafe integer", { constructor: Number.MAX_SAFE_INTEGER + 1 }],
  ] satisfies readonly [string, Readonly<Record<string, number>>][])(
    "normalizes %s from Adapter current_versions for a prototype-named stream",
    async (_label, currentVersions) => {
      const current = harness({
        persistence: new BoundaryConflictPersistence(currentVersions),
        ids: new TestIds(undefined, ["constructor"]),
      });

      const result = await current.application.handle(offerEnvelope(), {
        token: "human",
      });

      expect(result).toMatchObject({
        operation_status: "conflict",
        resource: null,
        receipt: null,
        error: {
          code: "version_conflict",
          current_resource_version: null,
        },
      });
      expectSchemaValid(result);
    },
  );

  it("accepts an own positive safe version for a prototype-named stream", async () => {
    const current = harness({
      persistence: new BoundaryConflictPersistence({ constructor: 7 }),
      ids: new TestIds(undefined, ["constructor"]),
    });

    const result = await current.application.handle(offerEnvelope(), {
      token: "human",
    });

    expect(result).toMatchObject({
      operation_status: "conflict",
      error: { current_resource_version: 7 },
    });
    expectSchemaValid(result);
  });

  it("reuses a recorded non-hash Partition for an existing Handoff", async () => {
    const source = harness();
    await source.application.handle(offerEnvelope(), { token: "human" });
    const sourceEvent = (await source.persistence.readStream("handoff_1"))[0];
    if (sourceEvent === undefined) {
      throw new Error("Expected source offered Event");
    }
    const persistence = new TrackingMemoryPersistence();
    const recordedPartition = "partition:recorded-root-lineage";
    const seededEvent: ProposedEvent = {
      ...proposedEvent(sourceEvent),
      event_id: "event_seed_recorded",
      request_message_id: "message_seed_recorded",
      idempotency_key: "seed-recorded",
    };
    const seeded = await persistence.commitAtomically({
      tenant_id: "tenant_01",
      partition_id: recordedPartition,
      commit_id: "commit_seed_recorded",
      idempotency_key: "seed-recorded",
      payload_digest: "digest-seed-recorded",
      request_message_id: "message_seed_recorded",
      outcome: {
        operation_status: "accepted",
        resource: {
          resource_type: "handoff",
          resource_id: "handoff_1",
          resource_version: 1,
        },
        receipt: null,
        error: null,
      },
      version_checks: [],
      appends: [
        {
          stream_id: "handoff_1",
          expected_version: 0,
          events: [seededEvent],
        },
      ],
    });
    expect(seeded.kind).toBe("committed");
    const current = harness({ persistence });

    const result = await current.application.handle(
      existingEnvelope(
        "accept",
        { handoff_id: "handoff_1" },
        {
          actor: "agent",
          expectedVersion: 1,
          idempotencyKey: "accept-recorded-partition",
        },
      ),
      { token: "agent" },
    );

    expect(result.operation_status).toBe("accepted");
    const request = persistence.commitRequests.at(-1);
    expect(request?.partition_id).toBe(recordedPartition);
    const hashedPartition = `partition:${createHash("sha256")
      .update(
        canonicalJson({
          tenant_id: "tenant_01",
          root_handoff_id: "handoff_1",
        }),
        "utf8",
      )
      .digest("hex")}`;
    expect(request?.partition_id).not.toBe(hashedPartition);
    expect(
      (await persistence.readStream("handoff_1")).map(
        ({ partition_id }) => partition_id,
      ),
    ).toEqual([recordedPartition, recordedPartition]);
  });

  it("returns context_unavailable before committing when Accept cannot access Context", async () => {
    const persistence = new TrackingMemoryPersistence();
    const offer = harness({ persistence });
    await offer.application.handle(
      offerEnvelope({
        payload: { ...offerPayload, context_bundle: contextBundle },
      }),
      { token: "human" },
    );
    const commitsAfterOffer = persistence.commitCalls;
    const accept = harness({
      persistence,
      context: new MemoryContextRepository(),
    });

    const result = await accept.application.handle(
      existingEnvelope(
        "accept",
        { handoff_id: "handoff_1" },
        { actor: "agent", expectedVersion: 1, idempotencyKey: "accept-context" },
      ),
      { token: "agent" },
    );

    expect(result).toMatchObject({
      operation_status: "rejected",
      receipt: null,
      error: { code: "context_unavailable", retryable: false },
    });
    expect(await persistence.readStream("handoff_1")).toHaveLength(1);
    expect(persistence.commitCalls).toBe(commitsAfterOffer);
    expect(accept.ids.count("event")).toBe(0);
    expect(accept.ids.count("receipt")).toBe(0);
    expect(accept.ids.count("commit")).toBe(0);
  });

  it("keeps Status non-lifecycle and completes Result, Verify, and Close", async () => {
    const { application, persistence, ids } = harness();
    const offer = await application.handle(offerEnvelope(), { token: "human" });
    const acceptCommand = existingEnvelope(
      "accept",
      { handoff_id: "handoff_1" },
      { actor: "agent", expectedVersion: 1 },
    );
    const accept = await application.handle(acceptCommand, { token: "agent" });
    const callsAfterAccept = [...ids.calls];
    const acceptReplay = await application.handle(
      { ...acceptCommand, message_id: "message_accept_retry" },
      { token: "agent" },
    );
    expect(ids.calls).toEqual(callsAfterAccept);
    const status = await application.handle(
      existingEnvelope(
        "report_status",
        {
          handoff_id: "handoff_1",
          status: {
            status_report_id: "status_01",
            execution_status: "in_progress",
            progress: 0.5,
            message: [],
            observed_at: "2026-07-15T03:10:00Z",
            blocked_on: [],
          },
        },
        { actor: "agent", expectedVersion: 2, idempotencyKey: "status-01" },
      ),
      { token: "agent" },
    );
    const returned = await application.handle(
      existingEnvelope(
        "return_result",
        {
          handoff_id: "handoff_1",
          result: {
            summary: [
              {
                kind: "text",
                media_type: "text/plain",
                text: "Implemented and tested",
              },
            ],
            artifacts: [],
            evidence: [],
          },
        },
        { actor: "agent", expectedVersion: 3, idempotencyKey: "result-01" },
      ),
      { token: "agent" },
    );
    const verified = await application.handle(
      existingEnvelope(
        "verify",
        {
          handoff_id: "handoff_1",
          satisfied_criterion_ids: ["tests-pass"],
          summary: [
            {
              kind: "text",
              media_type: "text/plain",
              text: "All acceptance criteria are satisfied",
            },
          ],
          evidence: [],
        },
        { actor: "verifier", expectedVersion: 4, idempotencyKey: "verify-01" },
      ),
      { token: "verifier" },
    );
    const closed = await application.handle(
      existingEnvelope(
        "close",
        { handoff_id: "handoff_1" },
        { actor: "verifier", expectedVersion: 5, idempotencyKey: "close-01" },
      ),
      { token: "verifier" },
    );

    expect(offer).toMatchObject({ operation_status: "accepted", receipt: null });
    expect(accept).toMatchObject({
      operation_status: "accepted",
      receipt: { receipt_type: "responsibility_accepted" },
    });
    expect(acceptReplay).toEqual({
      ...accept,
      request_message_id: "message_accept_retry",
    });
    expect(status).toMatchObject({
      operation_status: "accepted",
      resource: { resource_version: 3 },
      receipt: null,
    });
    expect(returned).toMatchObject({
      operation_status: "accepted",
      resource: { resource_version: 4 },
      receipt: { receipt_type: "result_received" },
    });
    expect(verified).toMatchObject({
      operation_status: "accepted",
      resource: { resource_version: 5 },
      receipt: { receipt_type: "result_verified" },
    });
    expect(closed).toMatchObject({
      operation_status: "accepted",
      resource: { resource_version: 6 },
      receipt: null,
    });
    for (const result of [offer, accept, acceptReplay, status, returned, verified, closed]) {
      expectSchemaValid(result);
    }
    const events = await persistence.readStream("handoff_1");
    expect(events.map(({ event_type }) => event_type)).toEqual([
      "workfabric.handoff.offered.v1",
      "workfabric.handoff.accepted.v1",
      "workfabric.handoff.status_reported.v1",
      "workfabric.handoff.result_returned.v1",
      "workfabric.handoff.verified.v1",
      "workfabric.handoff.closed.v1",
    ]);
    expect(new Set(events.map(({ partition_id }) => partition_id))).toEqual(
      new Set([events[0]?.partition_id]),
    );
    const state = replayHandoff(
      events.map((event) => ({
        stream_version: event.stream_version,
        event: handoffEventFromJson(event.domain_data),
      })),
    );
    expect(state).toMatchObject({
      lifecycle_state: "closed",
      resource_version: 6,
      current_responsible_actor: null,
    });
    expect(ids.count("handoff")).toBe(1);
    expect(ids.count("event")).toBe(6);
    expect(ids.count("receipt")).toBe(3);
  });

  it("persists and replays deterministic rejection without Event or Receipt IDs", async () => {
    const { application, persistence, ids } = harness();
    await application.handle(offerEnvelope(), { token: "human" });
    await application.handle(
      existingEnvelope(
        "accept",
        { handoff_id: "handoff_1" },
        { actor: "agent", expectedVersion: 1 },
      ),
      { token: "agent" },
    );
    const secondAccept = existingEnvelope(
      "accept",
      { handoff_id: "handoff_1" },
      {
        actor: "agent",
        expectedVersion: 2,
        idempotencyKey: "accept-again",
        messageId: "message_accept_again",
      },
    );
    const callsBefore = [...ids.calls];
    const rejectedResult = await application.handle(secondAccept, {
      token: "agent",
    });
    const callsAfter = [...ids.calls];
    const replay = await application.handle(
      { ...secondAccept, message_id: "message_accept_again_retry" },
      { token: "agent" },
    );

    expect(rejectedResult).toMatchObject({
      operation_status: "rejected",
      resource: null,
      receipt: null,
      error: { code: "invalid_state_transition", retryable: false },
    });
    expect(replay).toEqual({
      ...rejectedResult,
      request_message_id: "message_accept_again_retry",
    });
    expect(callsAfter).toEqual([...callsBefore, "commit"]);
    expect(ids.calls).toEqual(callsAfter);
    expect(await persistence.readStream("handoff_1")).toHaveLength(2);
  });

  it("returns a safe retryable failure without deduplicating a failed commit", async () => {
    const persistence = new FailOnceMemoryPersistence();
    const { application, ids } = harness({ persistence });
    const command = offerEnvelope();

    const failed = await application.handle(command, { token: "human" });
    const retried = await application.handle(
      { ...command, message_id: "message_offer_retry" },
      { token: "human" },
    );

    expect(failed).toEqual({
      spec_version: "1.0",
      request_message_id: "message_offer_01",
      operation_status: "temporarily_unavailable",
      resource: null,
      receipt: null,
      error: {
        code: "temporarily_unavailable",
        message: "The Exchange is temporarily unavailable",
        retryable: true,
        retry_after_seconds: null,
        current_resource_version: null,
        field_violations: [],
        details: {},
      },
    });
    expect(JSON.stringify(failed)).not.toContain("super-secret");
    expect(retried).toMatchObject({
      request_message_id: "message_offer_retry",
      operation_status: "accepted",
      resource: { resource_id: "handoff_2", resource_version: 1 },
    });
    expect(ids.count("handoff")).toBe(2);
    expect(await persistence.findCommand("tenant_01", "offer-01")).not.toBeNull();
    expect(await persistence.readStream("handoff_1")).toHaveLength(0);
    expect(await persistence.readStream("handoff_2")).toHaveLength(1);
  });

  it("does not expose a stored Handoff across Tenant or Exchange scope", async () => {
    const persistence = new MemoryExchangePersistence();
    await harness({ persistence }).application.handle(offerEnvelope(), {
      token: "human",
    });
    const tenantTwoPrincipal: ResolvedPrincipal = {
      ...agentPrincipal,
      principal_id: "principal_agent_tenant_02",
      tenant_id: "tenant_02",
    };
    const otherTenant = harness({
      persistence,
      identityRecords: [
        {
          authentication_evidence: { token: "agent-tenant-02" },
          principal: tenantTwoPrincipal,
        },
      ],
      allowRules: [
        {
          tenant_id: "tenant_02",
          principal_id: "principal_agent_tenant_02",
          actor_id: "actor_agent",
          actor_type: "agent",
          endpoint_id: "endpoint_agent",
          action: "workfabric.handoff.accept.v1",
          resource_id: "handoff_1",
        },
      ],
    });
    const crossTenant = await otherTenant.application.handle(
      {
        ...existingEnvelope(
          "accept",
          { handoff_id: "handoff_1" },
          {
            actor: "agent",
            expectedVersion: 1,
            idempotencyKey: "cross-tenant",
          },
        ),
        tenant_id: "tenant_02",
      },
      { token: "agent-tenant-02" },
    );
    const otherExchange = harness({ persistence });
    const crossExchange = await otherExchange.application.handle(
      {
        ...existingEnvelope(
          "accept",
          { handoff_id: "handoff_1" },
          {
            actor: "agent",
            expectedVersion: 1,
            idempotencyKey: "cross-exchange",
          },
        ),
        exchange_id: "exchange_02",
      },
      { token: "agent" },
    );

    for (const result of [crossTenant, crossExchange]) {
      expect(result).toMatchObject({
        operation_status: "rejected",
        resource: null,
        receipt: null,
        error: { code: "not_found", retryable: false },
      });
      expect(JSON.stringify(result)).not.toContain("tenant_01");
      expect(JSON.stringify(result)).not.toContain("exchange_01");
    }
    expect(otherTenant.ids.calls).toEqual([]);
    expect(otherExchange.ids.calls).toEqual([]);
    expect(await persistence.readStream("handoff_1")).toHaveLength(1);
  });

  it("refuses internal child-accepted commands at the public Application boundary", async () => {
    const childAcceptedRule: LocalAuthorityAllowRule = {
      tenant_id: "tenant_01",
      principal_id: "principal_agent",
      actor_id: "actor_agent",
      actor_type: "agent",
      endpoint_id: "endpoint_agent",
      action: "workfabric.handoff.child_accepted.v1",
      resource_id: "handoff_1",
    };
    const childAccepted: CommandEnvelope = {
      ...existingEnvelope(
        "accept",
        { handoff_id: "handoff_2" },
        { actor: "agent", expectedVersion: 2 },
      ),
      message_id: "message_child_accepted",
      message_type: "workfabric.handoff.child_accepted.v1",
      idempotency_key: "child-accepted-01",
      payload: {
        parent_handoff_id: "handoff_1",
        child_handoff_id: "handoff_2",
      },
    };

    const validInternalValidator: WfppCommandValidator = {
      validate() {
        return { valid: true };
      },
      payloadSchemaId() {
        return null;
      },
    };
    const childOrder: string[] = [];
    const childPersistence = new TrackingMemoryPersistence(childOrder);
    const childContext = new TrackingContextRepository(childOrder);
    const childHarness = harness({
      persistence: childPersistence,
      context: childContext,
      allowRules: [...allowRules(), childAcceptedRule],
      validator: validInternalValidator,
      order: childOrder,
    });
    const childAcceptedResult = await childHarness.application.handle(
      childAccepted,
      { token: "agent" },
    );

    expect(childAcceptedResult).toMatchObject({
      operation_status: "rejected",
      resource: null,
      receipt: null,
      error: { code: "invalid_argument", retryable: false },
    });
    expect(childOrder).toEqual([
      "validator.validate",
      "identity.resolve",
      "authority.authorize",
    ]);
    expect(childHarness.ids.calls).toEqual([]);
    expect(childPersistence.findCommandCalls).toBe(0);
    expect(childPersistence.readStreamCalls).toBe(0);
    expect(childPersistence.commitCalls).toBe(0);
    expect(childContext.putBundleCalls).toBe(0);
    expect(childContext.checkAvailabilityCalls).toBe(0);
  });
});
