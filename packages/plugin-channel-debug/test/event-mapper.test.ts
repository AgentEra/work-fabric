import { describe, expect, it } from "vitest";
import type { ConnectorIngressClaim } from "@work-fabric/connector-spi";
import {
  ConfiguredDebugParticipantResolver,
  DebugEventMapper,
  debugMessageIngress,
  normalizeDebugMessage,
  validateDebugPluginConfig,
} from "../src/index.js";
import { validDebugConfig } from "./fixtures.js";

function claim(overrides: Partial<ConnectorIngressClaim["envelope"]> = {}): ConnectorIngressClaim {
  const config = validateDebugPluginConfig(validDebugConfig());
  const envelope = debugMessageIngress({
    tenant_id: "tenant-local",
    connector_id: "debug-local",
    external_tenant_id: "debug-fixtures",
    submission_id: "submission-1",
    conversation_id: "conversation-1",
    message: normalizeDebugMessage({
      idempotency_key: "message-1",
      participant_ref: "internal-user",
      content: [
        { kind: "text", media_type: "text/markdown", text: "总结 **EDA**" },
        {
          kind: "data",
          schema_ref: "https://schemas.example.test/eda/v1",
          data: { status: "draft" },
        },
      ],
    }, config.limits),
    occurred_at: "2026-07-29T09:00:00.000Z",
    received_at: "2026-07-29T09:00:01.000Z",
  });
  return {
    ingress_id: "ingress-1",
    envelope: { ...envelope, ...overrides },
    state: "processing",
    attempt: 1,
    available_at: "2026-07-29T09:00:01.000Z",
    accepted_at: "2026-07-29T09:00:01.000Z",
    updated_at: "2026-07-29T09:00:01.000Z",
    claim_owner: "debug-worker",
    claim_token: "claim-1",
    fencing_token: 1,
    lease_expires_at: "2026-07-29T09:00:31.000Z",
  };
}

function mapper(participantRef = "internal-user") {
  const config = validateDebugPluginConfig(validDebugConfig());
  return new DebugEventMapper({
    tenant_id: "tenant-local",
    connector_id: config.connector_id,
    external_tenant_id: config.external_tenant_id,
    target: config.intake_target,
    delegation: config.delegation,
    accept_within_seconds: config.accept_within_seconds,
    result_due_within_seconds: config.result_due_within_seconds,
    limits: config.limits,
    participant_resolver: new ConfiguredDebugParticipantResolver({
      tenant_id: "tenant-local",
      connector_id: config.connector_id,
      external_tenant_id: config.external_tenant_id,
      participants: config.participants,
      admission: {
        async admit() {
          throw new Error(`Admission is not expected for ${participantRef}`);
        },
      },
    }),
    clock: { now: () => "2026-07-29T09:00:02.000Z" },
  });
}

describe("DebugEventMapper", () => {
  it("maps mixed content into one authorized Handoff offer command", async () => {
    const outcome = await mapper().map(claim());
    expect(outcome.kind).toBe("command");
    if (outcome.kind !== "command") throw new Error("expected command");
    expect(outcome.command).toEqual({
      operation: "handoff.offer",
      idempotency_key: "debug:debug-local:submission-1",
      identity: {
        actor_id: "actor-debug-user",
        actor_type: "human",
        endpoint_id: "endpoint-debug-user",
      },
      input: {
        work_reference: {
          uri: "debug://debug-fixtures/conversations/conversation-1/messages/submission-1",
          extensions: {
            "workfabric.dev/connector_id": "debug-local",
            "workfabric.dev/provider_family": "workfabric-debug",
            "workfabric.dev/external_tenant_id": "debug-fixtures",
            "workfabric.dev/conversation_id": "conversation-1",
            "workfabric.dev/submission_id": "submission-1",
            "workfabric.dev/occurred_at": "2026-07-29T09:00:00.000Z",
          },
        },
        target: { actor_id: "actor-daily-assistant" },
        intent: [
          { kind: "text", media_type: "text/markdown", text: "总结 **EDA**" },
          {
            kind: "data",
            schema_ref: "https://schemas.example.test/eda/v1",
            data: { status: "draft" },
          },
        ],
        authority_scope: {
          delegation_id: "debug-intake-submission-1",
          scopes: ["work:read"],
          resource_refs: [
            "debug://debug-fixtures/conversations/conversation-1/messages/submission-1",
          ],
          expires_at: "2026-08-05T09:00:02.000Z",
          may_redelegate: false,
        },
        acceptance_criteria: [{
          criterion_id: "intake_outcome_reported",
          description: "The external intake participant reports an outcome",
          required: true,
          result_schema_ref: null,
          required_evidence_types: [],
        }],
        verifier: { actor_id: "actor-debug-user", actor_type: "human" },
        priority: "normal",
        accept_by: "2026-07-30T09:00:02.000Z",
        result_due_at: "2026-08-05T09:00:02.000Z",
      },
    });
  });

  it("rejects source and event type mismatches permanently", async () => {
    await expect(mapper().map(claim({
      source_system: "feishu",
    }))).resolves.toEqual({
      kind: "rejected",
      reason_code: "source_mismatch",
      retryable: false,
    });
    await expect(mapper().map(claim({
      event_type: "debug.unknown.v1",
    }))).resolves.toEqual({
      kind: "rejected",
      reason_code: "unsupported_event_type",
      retryable: false,
    });
  });

  it("rejects an unknown participant without a command", async () => {
    const invalid = claim();
    await expect(mapper().map({
      ...invalid,
      envelope: {
        ...invalid.envelope,
        payload: { ...invalid.envelope.payload, participant_ref: "missing" },
      },
    })).resolves.toEqual({
      kind: "rejected",
      reason_code: "participant_unknown",
      retryable: false,
    });
  });

  it("rejects malformed payload without throwing from the worker", async () => {
    const invalid = claim();
    await expect(mapper().map({
      ...invalid,
      envelope: {
        ...invalid.envelope,
        payload: { ...invalid.envelope.payload, content: [] },
      },
    })).resolves.toEqual({
      kind: "rejected",
      reason_code: "invalid_debug_message",
      retryable: false,
    });
  });
});
