import assert from "node:assert/strict";

import {
  handoffEventFromJson,
  replayHandoff,
  type CommandEnvelope,
  type ExchangeApplication,
  type OperationResult,
} from "@work-fabric/exchange-core";
import {
  assignmentFromHandoff,
  type HandoffProjector,
  type SignalDispatcher,
} from "@work-fabric/exchange-runtime";
import type {
  DeliveryStateStore,
  ExchangePersistence,
  HandoffReadModelStore,
  JsonObject,
  ProjectionCheckpointStore,
  ProjectionFailureStore,
} from "@work-fabric/exchange-spi";

export interface ReferenceSuiteDependencies {
  readonly application: ExchangeApplication;
  readonly projector: HandoffProjector;
  readonly dispatcher: SignalDispatcher;
  readonly read_models: HandoffReadModelStore;
  readonly persistence: ExchangePersistence &
    ProjectionCheckpointStore &
    DeliveryStateStore &
    ProjectionFailureStore;
  readonly scenario: {
    readonly tenant_id: string;
    readonly exchange_id: string;
    readonly human_actor_id: string;
    readonly human_endpoint_id: string;
    readonly human_evidence: JsonObject;
    readonly agent_actor_id: string;
    readonly agent_endpoint_id: string;
    readonly agent_evidence: JsonObject;
    /** An active push Subscription owned by a participant, with max_attempts >= 2. */
    readonly signal_subscription_id: string;
  };
}

type ReferenceActor = "human" | "agent";

function text(value: string): JsonObject {
  return { kind: "text", media_type: "text/plain", text: value };
}

function acceptedResourceId(result: OperationResult, label: string): string {
  assert.equal(result.operation_status, "accepted", `${label} must be accepted`);
  assert.notEqual(result.resource, null, `${label} must return a resource`);
  const resourceId = result.resource?.resource_id;
  assert.equal(typeof resourceId, "string", `${label} resource_id must be a string`);
  assert.notEqual(resourceId, "", `${label} resource_id must not be empty`);
  return resourceId as string;
}

function assertAccepted(result: OperationResult, label: string): void {
  assert.equal(result.operation_status, "accepted", `${label} must be accepted`);
  assert.equal(result.error, null, `${label} must not return an error`);
}

function assertConflict(result: OperationResult, label: string): void {
  assert.equal(result.operation_status, "conflict", `${label} must conflict`);
  assert.equal(result.resource, null, `${label} must not return a resource`);
  assert.equal(result.error?.code, "version_conflict");
}

function replay(records: Awaited<ReturnType<ExchangePersistence["readStream"]>>) {
  return replayHandoff(
    records.map((record) => ({
      stream_version: record.stream_version,
      event: handoffEventFromJson(record.domain_data),
    })),
  );
}

/**
 * Executes the complete transport-independent Phase 1 reference contract.
 * Participants are identities only: their work continues to execute outside
 * Exchange Core and is represented here solely by commands and references.
 */
export async function verifyExchangeReferenceSuite(
  dependencies: ReferenceSuiteDependencies,
): Promise<void> {
  const { application, persistence, projector, read_models, dispatcher } =
    dependencies;
  const scenario = dependencies.scenario;
  let message = 0;

  function command(
    interaction: string,
    actor: ReferenceActor,
    key: string,
    payload: JsonObject,
    expectedVersion?: number,
    delegationId = "delegation_reference_suite",
  ): CommandEnvelope {
    message += 1;
    const human = actor === "human";
    return {
      spec_version: "1.0",
      message_id: `message_reference_suite_${message}`,
      message_type: `workfabric.handoff.${interaction}.v1`,
      sent_at: "2026-07-15T09:00:00Z",
      tenant_id: scenario.tenant_id,
      exchange_id: scenario.exchange_id,
      actor_id: human ? scenario.human_actor_id : scenario.agent_actor_id,
      endpoint_id: human
        ? scenario.human_endpoint_id
        : scenario.agent_endpoint_id,
      delegation_id: delegationId,
      idempotency_key: key,
      ...(expectedVersion === undefined
        ? {}
        : { expected_version: expectedVersion }),
      payload,
    };
  }

  function offerPayload(
    targetActorId: string,
    mayRedelegate: boolean,
    workReferenceUri: string,
    delegationId = "delegation_reference_suite",
  ): JsonObject {
    return {
      work_reference: { uri: workReferenceUri, extensions: {} },
      target: { actor_id: targetActorId },
      intent: [text("Coordinate externally executed reference work")],
      authority_scope: {
        delegation_id: delegationId,
        scopes: ["work:read", "result:write"],
        resource_refs: [workReferenceUri],
        expires_at: "2026-07-16T09:00:00Z",
        may_redelegate: mayRedelegate,
      },
      acceptance_criteria: [
        {
          criterion_id: "reference-tests-pass",
          description: "Reference evidence is accepted",
          required: true,
          result_schema_ref: null,
          required_evidence_types: ["test_report"],
        },
      ],
      verifier: {
        actor_id: scenario.human_actor_id,
        actor_type: "human",
      },
      priority: "normal",
      accept_by: "2026-07-15T10:00:00Z",
      result_due_at: "2026-07-16T09:00:00Z",
    };
  }

  function resultPayload(handoffId: string, suffix: string): JsonObject {
    return {
      handoff_id: handoffId,
      result: {
        summary: [text(`Reference result ${suffix}`)],
        artifacts: [
          {
            artifact_id: `artifact_reference_${suffix}`,
            artifact_type: "reference_output",
            resource: {
              uri: `urn:work-fabric:reference-suite:artifact:${suffix}`,
              extensions: {},
            },
          },
        ],
        evidence: [
          {
            evidence_id: `evidence_reference_${suffix}`,
            evidence_type: "test_report",
            content: {
              kind: "resource",
              resource: {
                uri: `urn:work-fabric:reference-suite:evidence:${suffix}`,
                media_type: "application/json",
                extensions: {},
              },
            },
          },
        ],
      },
    };
  }

  const mainOffer = command(
    "offer",
    "human",
    "reference-suite-main-offer",
    offerPayload(
      scenario.agent_actor_id,
      false,
      "urn:work-fabric:reference-suite:work:main",
    ),
  );
  const offered = await application.handle(mainOffer, scenario.human_evidence);
  const mainHandoffId = acceptedResourceId(offered, "main Offer");
  const recordsAfterOffer = await persistence.readStream(mainHandoffId);
  assert.equal(recordsAfterOffer.length, 1, "Offer must append exactly one Event");
  const mainPartitionId = recordsAfterOffer[0]?.partition_id;
  assert.equal(typeof mainPartitionId, "string", "Offer must select a Partition");

  const replayedOffer = await application.handle(
    { ...mainOffer, message_id: "message_reference_suite_offer_replay" },
    scenario.human_evidence,
  );
  assert.deepEqual(replayedOffer, {
    ...offered,
    request_message_id: "message_reference_suite_offer_replay",
  });
  assert.equal(
    (await persistence.readStream(mainHandoffId)).length,
    1,
    "idempotent Offer replay must not append",
  );

  const staleAccept = await application.handle(
    command(
      "accept",
      "agent",
      "reference-suite-stale-accept",
      { handoff_id: mainHandoffId },
      2,
    ),
    scenario.agent_evidence,
  );
  assertConflict(staleAccept, "stale Accept");

  assertAccepted(
    await application.handle(
      command(
        "accept",
        "agent",
        "reference-suite-main-accept",
        { handoff_id: mainHandoffId },
        1,
      ),
      scenario.agent_evidence,
    ),
    "main Accept",
  );
  assertAccepted(
    await application.handle(
      command(
        "report_status",
        "agent",
        "reference-suite-main-status",
        {
          handoff_id: mainHandoffId,
          status: {
            status_report_id: "status_reference_suite",
            execution_status: "in_progress",
            progress: 0.5,
            message: [],
            observed_at: "2026-07-15T09:00:00Z",
            blocked_on: [],
          },
        },
        2,
      ),
      scenario.agent_evidence,
    ),
    "Status",
  );
  assertAccepted(
    await application.handle(
      command(
        "return_result",
        "agent",
        "reference-suite-main-result-1",
        resultPayload(mainHandoffId, "first"),
        3,
      ),
      scenario.agent_evidence,
    ),
    "first Result",
  );
  assertAccepted(
    await application.handle(
      command(
        "request_rework",
        "human",
        "reference-suite-main-rework",
        {
          handoff_id: mainHandoffId,
          criterion_ids: ["reference-tests-pass"],
          reason: [text("Exercise the Rework transition")],
        },
        4,
      ),
      scenario.human_evidence,
    ),
    "Rework",
  );
  assertAccepted(
    await application.handle(
      command(
        "accept",
        "agent",
        "reference-suite-main-reaccept",
        { handoff_id: mainHandoffId },
        5,
      ),
      scenario.agent_evidence,
    ),
    "Rework Accept",
  );
  assertAccepted(
    await application.handle(
      command(
        "return_result",
        "agent",
        "reference-suite-main-result-2",
        resultPayload(mainHandoffId, "second"),
        6,
      ),
      scenario.agent_evidence,
    ),
    "second Result",
  );
  assertAccepted(
    await application.handle(
      command(
        "verify",
        "human",
        "reference-suite-main-verify",
        {
          handoff_id: mainHandoffId,
          satisfied_criterion_ids: ["reference-tests-pass"],
          summary: [text("Reference result verified")],
          evidence: [],
        },
        7,
      ),
      scenario.human_evidence,
    ),
    "Verify",
  );
  assertAccepted(
    await application.handle(
      command(
        "close",
        "human",
        "reference-suite-main-close",
        { handoff_id: mainHandoffId },
        8,
      ),
      scenario.human_evidence,
    ),
    "Close",
  );

  const mainRecords = await persistence.readStream(mainHandoffId);
  assert.deepEqual(
    mainRecords.map(({ event_type }) => event_type),
    [
      "workfabric.handoff.offered.v1",
      "workfabric.handoff.accepted.v1",
      "workfabric.handoff.status_reported.v1",
      "workfabric.handoff.result_returned.v1",
      "workfabric.handoff.rework_requested.v1",
      "workfabric.handoff.accepted.v1",
      "workfabric.handoff.result_returned.v1",
      "workfabric.handoff.verified.v1",
      "workfabric.handoff.closed.v1",
    ],
  );
  assert.equal(replay(mainRecords)?.lifecycle_state, "closed");

  const parentOffered = await application.handle(
    command(
      "offer",
      "human",
      "reference-suite-transfer-offer",
      offerPayload(
        scenario.agent_actor_id,
        true,
        "urn:work-fabric:reference-suite:work:transfer",
        "delegation_reference_parent",
      ),
      undefined,
      "delegation_reference_parent",
    ),
    scenario.human_evidence,
  );
  const parentHandoffId = acceptedResourceId(parentOffered, "transfer Offer");
  assertAccepted(
    await application.handle(
      command(
        "accept",
        "agent",
        "reference-suite-transfer-accept",
        { handoff_id: parentHandoffId },
        1,
        "delegation_reference_parent",
      ),
      scenario.agent_evidence,
    ),
    "transfer parent Accept",
  );
  const transferred = await application.handle(
    command(
      "transfer",
      "agent",
      "reference-suite-transfer",
      {
        parent_handoff_id: parentHandoffId,
        child_offer: offerPayload(
          scenario.human_actor_id,
          false,
          "urn:work-fabric:reference-suite:work:child",
          "delegation_reference_child",
        ),
      },
      2,
      "delegation_reference_parent",
    ),
    scenario.agent_evidence,
  );
  const childHandoffId = acceptedResourceId(transferred, "Transfer");
  assert.notEqual(childHandoffId, parentHandoffId);
  assertAccepted(
    await application.handle(
      command(
        "accept",
        "human",
        "reference-suite-child-accept",
        { handoff_id: childHandoffId },
        1,
        "delegation_reference_child",
      ),
      scenario.human_evidence,
    ),
    "child Accept",
  );
  assert.equal(
    replay(await persistence.readStream(parentHandoffId))?.lifecycle_state,
    "transferred",
  );
  assert.equal(
    replay(await persistence.readStream(childHandoffId))?.lifecycle_state,
    "accepted",
  );

  assert.notEqual(mainPartitionId, undefined);
  await projector.runPartition(mainPartitionId as string, 100);
  const incremental = await read_models.listHandoffs(mainPartitionId as string);
  const mainModel = await read_models.getHandoff(mainHandoffId);
  assert.notEqual(mainModel, null, "main Handoff must project");
  if (mainModel !== null) assert.equal(assignmentFromHandoff(mainModel), null);
  await projector.rebuildPartition(mainPartitionId as string, 2);
  assert.deepEqual(
    await read_models.listHandoffs(mainPartitionId as string),
    incremental,
    "projection rebuild must reproduce the incremental view",
  );

  const firstEvent = mainRecords[0];
  assert.notEqual(firstEvent, undefined);
  if (firstEvent === undefined) throw new Error("main Offer Event is missing");
  await persistence.recordDeliveryAttempt({
    subscription_id: scenario.signal_subscription_id,
    partition_id: firstEvent.partition_id,
    event_id: firstEvent.event_id,
    attempt: 1,
    attempted_at: firstEvent.occurred_at,
    outcome: "retryable_failure",
    detail: "reference retry",
    next_attempt_at: null,
  });
  await dispatcher.dispatchPartition(
    firstEvent.partition_id,
    scenario.tenant_id,
    100,
  );
  const attempts = await persistence.listDeliveryAttempts(
    scenario.signal_subscription_id,
    firstEvent.event_id,
  );
  assert.equal(
    attempts.length,
    2,
    "durable retry-state recovery must append attempt 2",
  );
  assert.equal(attempts[1]?.outcome, "accepted");
  assert.equal(
    await persistence.loadDeliveryPosition(
      scenario.signal_subscription_id,
      firstEvent.partition_id,
    ),
    mainRecords.at(-1)?.partition_position,
    "accepted retry must allow the delivery position to advance",
  );
}
