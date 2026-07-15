import { beforeAll, describe, expect, it } from "vitest";

import { MemoryContextRepository } from "@work-fabric/adapter-context-memory";
import {
  LocalAuthorityPolicy,
  LocalIdentityProvider,
  type LocalAuthorityAllowRule,
  type LocalIdentityRecord,
} from "@work-fabric/adapter-identity-local";
import { InProcessSignalAdapter } from "@work-fabric/adapter-signal-in-process";
import { MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import type {
  JsonObject,
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
  assignmentFromHandoff,
  DefaultSubscriptionDeliveryPolicy,
  HandoffProjector,
  MemoryHandoffReadModelStore,
  MemorySubscriptionStore,
  SignalDispatcher,
} from "@work-fabric/exchange-runtime";

import {
  ExchangeApplication,
  handoffEventFromJson,
  handoffStateFromJson,
  replayHandoff,
  type Clock,
  type CommandEnvelope,
  type IdGenerator,
} from "../src/index.js";

const tenantId = "tenant_reference";
const exchangeId = "exchange_reference";
const humanActorId = "actor_human";
const humanEndpointId = "endpoint_human";
const agentActorId = "actor_agent";
const agentEndpointId = "endpoint_agent";

const humanPrincipal: ResolvedPrincipal = {
  principal_id: "principal_human",
  tenant_id: tenantId,
  actor_claims: [
    {
      actor_id: humanActorId,
      actor_type: "human",
      endpoint_ids: [humanEndpointId],
    },
  ],
  attributes: {},
};

const agentPrincipal: ResolvedPrincipal = {
  principal_id: "principal_agent",
  tenant_id: tenantId,
  actor_claims: [
    {
      actor_id: agentActorId,
      actor_type: "agent",
      endpoint_ids: [agentEndpointId],
    },
  ],
  attributes: {},
};

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
    return `${kind}_reference_${count}`;
  }
}

function rule(
  principal: ResolvedPrincipal,
  action: string,
  resourceId: string | null,
): LocalAuthorityAllowRule {
  const claim = principal.actor_claims[0];
  const endpointId = claim?.endpoint_ids[0];
  if (claim === undefined || endpointId === undefined) {
    throw new Error("Reference principal is incomplete");
  }
  return {
    tenant_id: principal.tenant_id,
    principal_id: principal.principal_id,
    actor_id: claim.actor_id,
    actor_type: claim.actor_type,
    endpoint_id: endpointId,
    action,
    resource_id: resourceId,
  };
}

function command(
  interaction: string,
  actor: "human" | "agent",
  payload: JsonObject,
  expectedVersion?: number,
): CommandEnvelope {
  const human = actor === "human";
  return {
    spec_version: "1.0",
    message_id: `message_${interaction}`,
    message_type: `workfabric.handoff.${interaction}.v1`,
    sent_at: "2026-07-15T09:00:00Z",
    tenant_id: tenantId,
    exchange_id: exchangeId,
    actor_id: human ? humanActorId : agentActorId,
    endpoint_id: human ? humanEndpointId : agentEndpointId,
    delegation_id: "delegation_reference",
    idempotency_key: `reference-${interaction}`,
    ...(expectedVersion === undefined
      ? {}
      : { expected_version: expectedVersion }),
    payload,
  };
}

function offer(): CommandEnvelope {
  return command("offer", "human", {
    work_reference: {
      uri: "feishu://document/reference-flow-requirements",
      extensions: {},
    },
    target: { actor_id: agentActorId },
    intent: [
      {
        kind: "text",
        media_type: "text/plain",
        text: "Implement the approved requirement outside Exchange Core",
      },
    ],
    authority_scope: {
      delegation_id: "delegation_reference",
      scopes: ["work:read", "result:write"],
      resource_refs: ["feishu://document/reference-flow-requirements"],
      expires_at: "2026-07-16T09:00:00Z",
      may_redelegate: false,
    },
    acceptance_criteria: [
      {
        criterion_id: "tests-pass",
        description: "The external implementation tests pass",
        required: true,
        result_schema_ref: null,
        required_evidence_types: ["test_report"],
      },
    ],
    verifier: { actor_id: humanActorId, actor_type: "human" },
    priority: "normal",
    accept_by: "2026-07-15T10:00:00Z",
    result_due_at: "2026-07-16T09:00:00Z",
  });
}

function subscription(): RuntimeSubscription {
  return {
    subscription_id: "subscription_agent_reference",
    tenant_id: tenantId,
    owner: { actor_id: agentActorId, actor_type: "agent" },
    endpoint_id: agentEndpointId,
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
      destination_id: "destination_agent_reference",
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

describe("human -> Agent -> human verifier reference flow", () => {
  it("coordinates external work through Handoff, Signal, projection, and replay", async () => {
    const persistence = new MemoryExchangePersistence();
    const clock = new ReferenceClock();
    const identities: readonly LocalIdentityRecord[] = [
      { authentication_evidence: { token: "human" }, principal: humanPrincipal },
      { authentication_evidence: { token: "agent" }, principal: agentPrincipal },
    ];
    const handoffId = "handoff_reference_1";
    const rules = [
      rule(humanPrincipal, "workfabric.handoff.offer.v1", null),
      ...["verify", "close"].map((interaction) =>
        rule(
          humanPrincipal,
          `workfabric.handoff.${interaction}.v1`,
          handoffId,
        ),
      ),
      ...["accept", "report_status", "return_result"].map((interaction) =>
        rule(
          agentPrincipal,
          `workfabric.handoff.${interaction}.v1`,
          handoffId,
        ),
      ),
    ];
    const application = new ExchangeApplication({
      persistence,
      identity: new LocalIdentityProvider(identities),
      authority: new LocalAuthorityPolicy(rules),
      context: new MemoryContextRepository(),
      validator,
      clock,
      ids: new ReferenceIds(),
    });
    const subscriptions = new MemorySubscriptionStore();
    await subscriptions.putSubscription(subscription());
    const signal = new InProcessSignalAdapter();
    const dispatcher = new SignalDispatcher(
      persistence,
      persistence,
      subscriptions,
      new DefaultSubscriptionDeliveryPolicy(),
      signal,
      clock,
      { base_delay_seconds: 1, max_delay_seconds: 8 },
      schemas,
    );
    const models = new MemoryHandoffReadModelStore();
    const projector = new HandoffProjector(
      persistence,
      persistence,
      persistence,
      models,
      clock,
    );

    const offered = await application.handle(offer(), { token: "human" });
    expect(offered, JSON.stringify(offered)).toMatchObject({
      operation_status: "accepted",
      resource: { resource_id: handoffId, resource_version: 1 },
    });
    const offeredRecords = await persistence.readStream(handoffId);
    const partitionId = offeredRecords[0]?.partition_id;
    if (partitionId === undefined) throw new Error("Offer was not journaled");

    await dispatcher.dispatchPartition(partitionId, tenantId, 20);
    const offeredDelivery = signal.deliveries()[0];
    expect(offeredDelivery?.event.type).toBe("workfabric.handoff.offered.v1");
    expect(
      schemas.validate(
        "urn:work-fabric:schema:v1:protocol-event",
        offeredDelivery?.event,
      ),
    ).toEqual({ valid: true });
    expect(JSON.stringify(offeredDelivery?.event)).not.toContain("domain_data");
    expect(JSON.stringify(offeredDelivery?.event)).not.toContain(
      "partition_position",
    );

    const accepted = await application.handle(
      command("accept", "agent", { handoff_id: handoffId }, 1),
      { token: "agent" },
    );
    expect(accepted.operation_status).toBe("accepted");
    await projector.runPartition(partitionId, 20);
    const acceptedModel = await models.getHandoff(handoffId);
    if (acceptedModel === null) throw new Error("Handoff was not projected");
    expect(assignmentFromHandoff(acceptedModel)).toMatchObject({
      responsible_actor: { actor_id: agentActorId, actor_type: "agent" },
      handoff_id: handoffId,
    });

    const status = await application.handle(
      command(
        "report_status",
        "agent",
        {
          handoff_id: handoffId,
          status: {
            status_report_id: "status_reference_1",
            execution_status: "in_progress",
            progress: 0.5,
            message: [],
            observed_at: "2026-07-15T09:10:00Z",
            blocked_on: [],
          },
        },
        2,
      ),
      { token: "agent" },
    );
    const returned = await application.handle(
      command(
        "return_result",
        "agent",
        {
          handoff_id: handoffId,
          result: {
            summary: [
              {
                kind: "text",
                media_type: "text/plain",
                text: "External Agent Runtime completed the work",
              },
            ],
            artifacts: [
              {
                artifact_id: "artifact_reference_1",
                artifact_type: "source_repository",
                resource: {
                  uri: "urn:git:reference-flow:commit:abc123",
                  extensions: {},
                },
              },
            ],
            evidence: [
              {
                evidence_id: "evidence_reference_1",
                evidence_type: "test_report",
                content: {
                  kind: "resource",
                  resource: {
                    uri: "urn:test-report:reference-flow:1",
                    media_type: "application/json",
                    extensions: {},
                  },
                },
              },
            ],
          },
        },
        3,
      ),
      { token: "agent" },
    );
    const verified = await application.handle(
      command(
        "verify",
        "human",
        {
          handoff_id: handoffId,
          satisfied_criterion_ids: ["tests-pass"],
          summary: [
            {
              kind: "text",
              media_type: "text/plain",
              text: "Human verifier accepted the evidence",
            },
          ],
          evidence: [],
        },
        4,
      ),
      { token: "human" },
    );
    const closed = await application.handle(
      command("close", "human", { handoff_id: handoffId }, 5),
      { token: "human" },
    );
    for (const result of [status, returned, verified, closed]) {
      expect(result.operation_status).toBe("accepted");
    }

    await dispatcher.dispatchPartition(partitionId, tenantId, 20);
    const deliveredSignals = signal.deliveries().map(({ event }) => event);
    expect(deliveredSignals.map(({ type }) => type)).toEqual([
      "workfabric.handoff.offered.v1",
      "workfabric.handoff.accepted.v1",
      "workfabric.handoff.status_reported.v1",
      "workfabric.handoff.result_returned.v1",
      "workfabric.handoff.verified.v1",
      "workfabric.handoff.closed.v1",
    ]);
    for (const delivered of deliveredSignals) {
      expect(
        schemas.validate(
          "urn:work-fabric:schema:v1:protocol-event",
          delivered,
        ),
      ).toEqual({ valid: true });
      expect(delivered).not.toHaveProperty("domain_data");
      expect(delivered).not.toHaveProperty("partition_position");
    }

    await projector.runPartition(partitionId, 20);
    const closedModel = await models.getHandoff(handoffId);
    if (closedModel === null) throw new Error("Closed Handoff was not projected");
    expect(assignmentFromHandoff(closedModel)).toBeNull();

    const records = await persistence.readStream(handoffId);
    const replayed = replayHandoff(
      records.map((record) => ({
        stream_version: record.stream_version,
        event: handoffEventFromJson(record.domain_data),
      })),
    );
    expect(replayed).toEqual(handoffStateFromJson(closedModel.state));
    expect(replayed).toMatchObject({
      lifecycle_state: "closed",
      current_responsible_actor: null,
      resource_version: 6,
    });
  });
});
