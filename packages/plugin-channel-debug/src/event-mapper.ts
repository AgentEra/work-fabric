import type {
  ConnectorEventMapper,
  ConnectorIngressClaim,
  ConnectorMappingOutcome,
} from "@work-fabric/connector-spi";
import type { JsonObject } from "@work-fabric/exchange-spi";

import type { DebugHttpLimits } from "./config.js";
import { normalizeDebugMessage } from "./content.js";
import type {
  ConfiguredDebugParticipantResolver,
  DebugParticipantResolution,
} from "./participant-resolver.js";

export interface DebugEventMapperOptions {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly external_tenant_id: string;
  readonly target: {
    readonly actor_id: string;
    readonly endpoint_id: string;
  };
  readonly delegation: {
    readonly scopes: readonly string[];
    readonly may_redelegate: boolean;
  };
  readonly accept_within_seconds: number;
  readonly result_due_within_seconds: number;
  readonly limits: DebugHttpLimits;
  readonly participant_resolver: ConfiguredDebugParticipantResolver;
  readonly clock: { now(): string };
}

function id(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value.trim() !== value
    || /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function addSeconds(timestamp: string, seconds: number): string {
  const milliseconds = Date.parse(timestamp);
  if (
    !Number.isFinite(milliseconds)
    || !Number.isSafeInteger(seconds)
    || seconds <= 0
    || seconds > 31_536_000
  ) {
    throw new TypeError("Debug intake timing is invalid");
  }
  return new Date(milliseconds + seconds * 1000).toISOString();
}

function participantFailure(
  resolution: Exclude<DebugParticipantResolution, { readonly kind: "resolved" }>,
): ConnectorMappingOutcome {
  return {
    kind: "rejected",
    reason_code: resolution.reason_code,
    retryable: resolution.kind === "temporarily_unavailable",
  };
}

export class DebugEventMapper implements ConnectorEventMapper {
  readonly manifest = {
    profile: "connector.mapper.v1",
    adapter: "workfabric-debug",
    capabilities: {
      identity_resolution: true,
      mixed_content: true,
      inert_unknown_events: true,
    },
  } as const;

  constructor(private readonly options: DebugEventMapperOptions) {}

  async map(claim: ConnectorIngressClaim): Promise<ConnectorMappingOutcome> {
    if (
      claim.envelope.source_system !== "workfabric-debug"
      || claim.envelope.tenant_id !== this.options.tenant_id
      || claim.envelope.connector_id !== this.options.connector_id
      || claim.envelope.external_tenant_id !== this.options.external_tenant_id
    ) {
      return {
        kind: "rejected",
        reason_code: "source_mismatch",
        retryable: false,
      };
    }
    if (claim.envelope.event_type !== "debug.message.receive_v1") {
      return {
        kind: "rejected",
        reason_code: "unsupported_event_type",
        retryable: false,
      };
    }
    let submissionId: string;
    let conversationId: string;
    let message: ReturnType<typeof normalizeDebugMessage>;
    try {
      submissionId = id(
        claim.envelope.payload.submission_id,
        "submission_id",
        96,
      );
      conversationId = id(
        claim.envelope.payload.conversation_id,
        "conversation_id",
        512,
      );
      if (
        claim.envelope.external_event_id !== submissionId
        || claim.envelope.partition_key !== conversationId
      ) {
        throw new TypeError("debug ingress correlation mismatch");
      }
      message = normalizeDebugMessage({
        idempotency_key: claim.envelope.payload.idempotency_key,
        participant_ref: claim.envelope.payload.participant_ref,
        content: claim.envelope.payload.content,
      }, this.options.limits);
    } catch {
      return {
        kind: "rejected",
        reason_code: "invalid_debug_message",
        retryable: false,
      };
    }
    let participant: DebugParticipantResolution;
    try {
      participant = await this.options.participant_resolver.resolve({
        participant_ref: message.participant_ref,
        ingress_id: claim.ingress_id,
        idempotency_key: `debug:${this.options.connector_id}:${submissionId}`,
      });
    } catch {
      return {
        kind: "rejected",
        reason_code: "participant_resolution_unavailable",
        retryable: true,
      };
    }
    if (participant.kind !== "resolved") {
      return participantFailure(participant);
    }
    const now = this.options.clock.now();
    const reference =
      `debug://${encodeURIComponent(this.options.external_tenant_id)}`
      + `/conversations/${encodeURIComponent(conversationId)}`
      + `/messages/${encodeURIComponent(submissionId)}`;
    const resultDueAt = addSeconds(
      now,
      this.options.result_due_within_seconds,
    );
    const input: JsonObject = {
      work_reference: {
        uri: reference,
        extensions: {
          "workfabric.dev/connector_id": this.options.connector_id,
          "workfabric.dev/provider_family": "workfabric-debug",
          "workfabric.dev/external_tenant_id": this.options.external_tenant_id,
          "workfabric.dev/conversation_id": conversationId,
          "workfabric.dev/submission_id": submissionId,
          "workfabric.dev/occurred_at": claim.envelope.occurred_at,
        },
      },
      target: { actor_id: this.options.target.actor_id },
      intent: structuredClone(message.content),
      authority_scope: {
        delegation_id: `debug-intake-${submissionId}`,
        scopes: [...this.options.delegation.scopes],
        resource_refs: [reference],
        expires_at: resultDueAt,
        may_redelegate: this.options.delegation.may_redelegate,
      },
      acceptance_criteria: [{
        criterion_id: "intake_outcome_reported",
        description: "The external intake participant reports an outcome",
        required: true,
        result_schema_ref: null,
        required_evidence_types: [],
      }],
      verifier: {
        actor_id: participant.identity.actor_id,
        actor_type: participant.identity.actor_type,
      },
      priority: "normal",
      accept_by: addSeconds(now, this.options.accept_within_seconds),
      result_due_at: resultDueAt,
    };
    return {
      kind: "command",
      command: {
        operation: "handoff.offer",
        idempotency_key: `debug:${this.options.connector_id}:${submissionId}`,
        identity: participant.identity,
        ...(participant.representation_grant === undefined
          ? {}
          : {
              authentication: {
                kind: "bearer" as const,
                credential: participant.representation_grant,
              },
            }),
        input,
      },
    };
  }
}
