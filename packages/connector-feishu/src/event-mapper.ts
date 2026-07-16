import { createHash } from "node:crypto";

import type {
  ConnectorEventMapper,
  ConnectorIdentityResolver,
  ConnectorIngressClaim,
  ConnectorMappingOutcome,
} from "@work-fabric/connector-spi";

import {
  FeishuActionReferenceError,
  type FeishuActionReferenceCodec,
} from "./action-token.js";

export interface FeishuEventMapperClock {
  now(): string;
}

export interface FeishuMessageMappingPolicy {
  mapMessage(claim: ConnectorIngressClaim): Promise<ConnectorMappingOutcome>;
}

export interface FeishuEventMapperOptions {
  readonly identity_resolver: ConnectorIdentityResolver;
  readonly action_codec: FeishuActionReferenceCodec;
  readonly clock: FeishuEventMapperClock;
  readonly message_policy?: FeishuMessageMappingPolicy;
}

function stringField(
  payload: ConnectorIngressClaim["envelope"]["payload"],
  field: string,
): string {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new TypeError(`Feishu event ${field} is invalid`);
  }
  return value;
}

function idempotencyKey(claim: ConnectorIngressClaim): string {
  const digest = createHash("sha256")
    .update(claim.envelope.tenant_id)
    .update("\0")
    .update(claim.envelope.connector_id)
    .update("\0")
    .update(claim.envelope.dedupe_key)
    .digest("base64url");
  return `feishu:${digest}`;
}

function sameIdentity(
  left: {
    readonly actor_id: string;
    readonly endpoint_id?: string;
    readonly delegation_id?: string;
  },
  right: {
    readonly actor_id: string;
    readonly endpoint_id?: string;
    readonly delegation_id?: string;
  },
): boolean {
  return left.actor_id === right.actor_id &&
    left.endpoint_id === right.endpoint_id &&
    left.delegation_id === right.delegation_id;
}

export class FeishuEventMapper implements ConnectorEventMapper {
  readonly manifest = {
    profile: "connector.mapper.v1",
    adapter: "feishu",
    capabilities: {
      explicit_actions: true,
      identity_resolution: true,
      inert_messages_by_default: true,
    },
  } as const;

  constructor(private readonly options: FeishuEventMapperOptions) {}

  async map(claim: ConnectorIngressClaim): Promise<ConnectorMappingOutcome> {
    if (
      claim.envelope.source_system !== "feishu" ||
      claim.envelope.event_type === "im.message.receive_v1"
    ) {
      if (claim.envelope.source_system !== "feishu") {
        return {
          kind: "rejected",
          reason_code: "source_mismatch",
          retryable: false,
        };
      }
      return this.options.message_policy === undefined
        ? { kind: "ignored", reason_code: "unconfigured_message" }
        : this.options.message_policy.mapMessage(claim);
    }
    if (claim.envelope.event_type !== "card.action.trigger") {
      return {
        kind: "rejected",
        reason_code: "unsupported_event_type",
        retryable: false,
      };
    }

    let operator: string;
    let actionReference: string;
    try {
      operator = stringField(claim.envelope.payload, "operator_open_id");
      actionReference = stringField(claim.envelope.payload, "action_ref");
    } catch {
      return {
        kind: "rejected",
        reason_code: "invalid_card_action",
        retryable: false,
      };
    }
    const identity = await this.options.identity_resolver.resolve({
      tenant_id: claim.envelope.tenant_id,
      connector_id: claim.envelope.connector_id,
      source_system: "feishu",
      external_tenant_id: claim.envelope.external_tenant_id,
      external_subject_type: "user",
      external_subject_id: operator,
    });
    if (identity === null) {
      return {
        kind: "rejected",
        reason_code: "identity_unmapped",
        retryable: false,
      };
    }

    try {
      const action = this.options.action_codec.resolve(actionReference, {
        tenant_id: claim.envelope.tenant_id,
        connector_id: claim.envelope.connector_id,
        external_tenant_id: claim.envelope.external_tenant_id,
        external_subject_id: operator,
        now: this.options.clock.now(),
      });
      if (!sameIdentity(identity, action.identity)) {
        return {
          kind: "rejected",
          reason_code: "identity_mapping_changed",
          retryable: false,
        };
      }
      return {
        kind: "command",
        command: {
          operation: action.operation,
          idempotency_key: idempotencyKey(claim),
          expected_version: action.expected_version,
          identity: action.identity,
          input: action.input,
        },
      };
    } catch (error) {
      return {
        kind: "rejected",
        reason_code:
          error instanceof FeishuActionReferenceError && error.code === "expired"
            ? "action_expired"
            : "invalid_action_reference",
        retryable: false,
      };
    }
  }
}
