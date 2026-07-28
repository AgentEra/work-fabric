import { createHash } from "node:crypto";
import type {
  ConversationContextMaterializer,
  ConversationContextMaterialization,
} from "@work-fabric/channel-spi";
import type { ConnectorIngressClaim, ConnectorMappingOutcome } from "@work-fabric/connector-spi";
import { feishuCommandIdempotencyKey, parseFeishuParticipantResolution, type FeishuMessageMappingPolicy, type FeishuParticipantResolver } from "@work-fabric/connector-feishu";
import type { JsonObject } from "@work-fabric/exchange-spi";

export interface FeishuIntakeTarget { readonly actor_id: string; readonly endpoint_id: string; }
export interface FeishuIntakeMessagePolicyOptions {
  readonly bot_open_id: string;
  readonly participant_resolver: FeishuParticipantResolver;
  readonly target: FeishuIntakeTarget;
  readonly clock: { now(): string };
  readonly accept_within_seconds: number;
  readonly result_due_within_seconds: number;
  readonly max_intent_length: number;
  readonly delegation: {
    readonly scopes: readonly string[];
    readonly may_redelegate: boolean;
  };
  readonly conversation_context?: {
    readonly materializer: ConversationContextMaterializer;
    readonly policy: {
      readonly lookback_seconds: number;
      readonly maximum_messages: number;
      readonly maximum_bytes: number;
    };
  };
}

function bounded(value: unknown, field: string, maximum = 2048): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new TypeError(`${field} is invalid`);
  return value;
}
function addSeconds(timestamp: string, seconds: number): string {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time) || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 31_536_000) throw new TypeError("Intake timing is invalid");
  return new Date(time + seconds * 1000).toISOString();
}
function messageText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum * 2) throw new TypeError("content is invalid");
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || typeof (parsed as { text?: unknown }).text !== "string") throw new TypeError("content is invalid");
  return bounded((parsed as { text: string }).text, "content.text", maximum);
}
function mentionList(value: unknown): readonly { readonly key: string; readonly open_id: string }[] {
  if (!Array.isArray(value) || value.length > 100) return [];
  return value.flatMap((item) => typeof item === "object" && item !== null && !Array.isArray(item) && typeof (item as { key?: unknown }).key === "string" && typeof (item as { open_id?: unknown }).open_id === "string"
    ? [{ key: (item as { key: string }).key, open_id: (item as { open_id: string }).open_id }]
    : []);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(object[key])}`
  ).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function unavailableBundle(input: {
  readonly tenant_id: string;
  readonly message_id: string;
  readonly code: string;
  readonly created_at: string;
  readonly recipient_actor_id: string;
  readonly recipient_endpoint_id: string;
  readonly expires_at: string;
}): JsonObject {
  const body: JsonObject = {
    context_id: `context_unavailable_${digest({
      tenant_id: input.tenant_id,
      message_id: input.message_id,
      code: input.code,
      recipient_actor_id: input.recipient_actor_id,
      recipient_endpoint_id: input.recipient_endpoint_id,
      expires_at: input.expires_at,
    })}`,
    version: 1,
    created_at: input.created_at,
    items: [{
      kind: "data",
      schema_ref: "urn:work-fabric:schema:context-availability-fact:1",
      data: {
        fact: "context_unavailable",
        code: input.code,
      },
    }],
    visibility_scope: {
      actor_ids: [input.recipient_actor_id],
      endpoint_ids: [input.recipient_endpoint_id],
      expires_at: input.expires_at,
    },
    extensions: {
      "workfabric.dev/context_kind": "conversation_history",
      "workfabric.dev/availability": "unavailable",
    },
  };
  return {
    ...body,
    digest: { algorithm: "sha-256", value: digest(body) },
  };
}

function validMaterializedBundle(
  result: ConversationContextMaterialization,
  actorId: string,
  endpointId: string,
  maximumBytes: number,
): result is Extract<
  ConversationContextMaterialization,
  { readonly kind: "materialized" }
> {
  if (result.kind !== "materialized") return false;
  const bundle = result.bundle;
  const visibility =
    bundle.visibility_scope !== null &&
    typeof bundle.visibility_scope === "object" &&
    !Array.isArray(bundle.visibility_scope)
      ? bundle.visibility_scope
      : null;
  const digestValue =
    bundle.digest !== null &&
    typeof bundle.digest === "object" &&
    !Array.isArray(bundle.digest)
      ? bundle.digest
      : null;
  const visibilityObject = visibility as JsonObject | null;
  const digestObject = digestValue as JsonObject | null;
  return (
    typeof bundle.context_id === "string" &&
    bundle.context_id.length > 0 &&
    Number.isSafeInteger(bundle.version) &&
    (bundle.version as number) > 0 &&
    visibilityObject !== null &&
    Array.isArray(visibilityObject.actor_ids) &&
    visibilityObject.actor_ids.includes(actorId) &&
    Array.isArray(visibilityObject.endpoint_ids) &&
    visibilityObject.endpoint_ids.includes(endpointId) &&
    digestObject !== null &&
    digestObject.algorithm === "sha-256" &&
    typeof digestObject.value === "string" &&
    new TextEncoder().encode(JSON.stringify(bundle)).byteLength <= maximumBytes
  );
}

export class FeishuIntakeMessagePolicy implements FeishuMessageMappingPolicy {
  constructor(private readonly options: FeishuIntakeMessagePolicyOptions) {
    bounded(options.bot_open_id, "bot_open_id", 255); bounded(options.target.actor_id, "target.actor_id", 128); bounded(options.target.endpoint_id, "target.endpoint_id", 128);
  }
  async mapMessage(claim: ConnectorIngressClaim): Promise<ConnectorMappingOutcome> {
    const payload = claim.envelope.payload;
    if (payload.message_type !== "text") return { kind: "ignored", reason_code: "unsupported_message_type" };
    const botMention = mentionList(payload.mentions).find((item) => item.open_id === this.options.bot_open_id);
    if (botMention === undefined) return { kind: "ignored", reason_code: "bot_not_mentioned" };
    let text: string;
    try { text = messageText(payload.content, this.options.max_intent_length).split(botMention.key).join("").trim(); }
    catch { return { kind: "rejected", reason_code: "invalid_message_content", retryable: false }; }
    if (text.length === 0) return { kind: "ignored", reason_code: "empty_intent" };
    const sender = bounded(payload.sender_open_id, "sender_open_id", 255);
    const commandIdempotencyKey = feishuCommandIdempotencyKey(claim);
    let participant;
    try {
      participant = parseFeishuParticipantResolution(
        await this.options.participant_resolver.resolve({
          claim,
          external_subject_id: sender,
          external_subject_type: "human",
          idempotency_key: commandIdempotencyKey,
        }),
      );
    } catch {
      return { kind: "rejected", reason_code: "participant_resolution_unavailable", retryable: true };
    }
    if (participant.kind !== "resolved") return {
      kind: "rejected",
      reason_code: participant.reason_code,
      retryable: participant.kind === "temporarily_unavailable",
    };
    const identity = participant.identity;
    if (identity.endpoint_id === undefined) return { kind: "rejected", reason_code: "participant_endpoint_missing", retryable: false };
    const now = this.options.clock.now();
    const messageId = bounded(payload.message_id, "message_id", 255);
    const reference = `feishu://${encodeURIComponent(claim.envelope.external_tenant_id)}/message/${encodeURIComponent(messageId)}`;
    const delegationId = `intake-${createHash("sha256").update(messageId).digest("hex").slice(0, 24)}`;
    const delegationExpiresAt = addSeconds(
      now,
      this.options.result_due_within_seconds,
    );
    let contextBundle: JsonObject | undefined;
    if (this.options.conversation_context !== undefined) {
      let materialized: ConversationContextMaterialization;
      try {
        materialized = await this.options.conversation_context.materializer
          .materialize({
            tenant_id: claim.envelope.tenant_id,
            provider_family: "feishu",
            external_tenant_id: claim.envelope.external_tenant_id,
            conversation_id: bounded(payload.chat_id, "chat_id", 255),
            trigger_message_id: messageId,
            ...(typeof payload.thread_id === "string"
              ? { thread_id: bounded(payload.thread_id, "thread_id", 255) }
              : {}),
            ...(typeof payload.root_id === "string"
              ? { root_message_id: bounded(payload.root_id, "root_id", 255) }
              : {}),
            triggered_at: claim.envelope.occurred_at,
            represented_actor_id: identity.actor_id,
            recipient_actor_id: this.options.target.actor_id,
            recipient_endpoint_id: this.options.target.endpoint_id,
            delegation_id: delegationId,
            delegation_scopes: [...this.options.delegation.scopes],
            delegation_expires_at: delegationExpiresAt,
            policy: { ...this.options.conversation_context.policy },
          }, new AbortController().signal);
      } catch {
        return {
          kind: "rejected",
          reason_code: "conversation_context_temporarily_unavailable",
          retryable: true,
        };
      }
      if (materialized.kind === "temporarily_unavailable") {
        return {
          kind: "rejected",
          reason_code: "conversation_context_temporarily_unavailable",
          retryable: true,
        };
      }
      if (materialized.kind === "permanently_unavailable") {
        contextBundle = unavailableBundle({
          tenant_id: claim.envelope.tenant_id,
          message_id: messageId,
          code: materialized.code,
          created_at: claim.envelope.occurred_at,
          recipient_actor_id: this.options.target.actor_id,
          recipient_endpoint_id: this.options.target.endpoint_id,
          expires_at: delegationExpiresAt,
        });
      } else if (validMaterializedBundle(
        materialized,
        this.options.target.actor_id,
        this.options.target.endpoint_id,
        this.options.conversation_context.policy.maximum_bytes,
      )) {
        contextBundle = materialized.bundle;
      } else {
        return {
          kind: "rejected",
          reason_code: "conversation_context_temporarily_unavailable",
          retryable: true,
        };
      }
    }
    const input: JsonObject = {
      work_reference: { uri: reference, extensions: {
        "workfabric.dev/connector_id": claim.envelope.connector_id,
        "workfabric.dev/external_event_id": claim.envelope.external_event_id,
        ...(typeof payload.root_id === "string" ? { "workfabric.dev/root_id": payload.root_id } : {}),
        ...(typeof payload.parent_id === "string" ? { "workfabric.dev/parent_id": payload.parent_id } : {}),
        ...(typeof payload.thread_id === "string" ? { "workfabric.dev/thread_id": payload.thread_id } : {}),
      } },
      target: { actor_id: this.options.target.actor_id },
      intent: [{ kind: "text", media_type: "text/plain", text }],
      authority_scope: {
        delegation_id: delegationId,
        scopes: [...this.options.delegation.scopes], resource_refs: [reference],
        expires_at: delegationExpiresAt,
        may_redelegate: this.options.delegation.may_redelegate,
      },
      ...(contextBundle === undefined ? {} : { context_bundle: contextBundle }),
      acceptance_criteria: [{
        criterion_id: "intake_outcome_reported",
        description: "The external intake participant reports an outcome",
        required: true,
        result_schema_ref: null,
        required_evidence_types: [],
      }],
      verifier: { actor_id: identity.actor_id, actor_type: identity.actor_type },
      priority: "normal",
      accept_by: addSeconds(now, this.options.accept_within_seconds),
      result_due_at: addSeconds(now, this.options.result_due_within_seconds),
    };
    return { kind: "command", command: {
      operation: "handoff.offer",
      idempotency_key: commandIdempotencyKey,
      identity,
      ...(participant.representation_grant === undefined ? {} : {
        authentication: { kind: "bearer" as const, credential: participant.representation_grant },
      }),
      input,
    } };
  }
}
