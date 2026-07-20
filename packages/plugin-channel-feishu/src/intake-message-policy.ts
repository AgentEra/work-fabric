import { createHash } from "node:crypto";
import type { ConnectorIdentityResolver, ConnectorIngressClaim, ConnectorMappingOutcome } from "@work-fabric/connector-spi";
import type { FeishuMessageMappingPolicy } from "@work-fabric/connector-feishu";
import type { JsonObject } from "@work-fabric/exchange-spi";

export interface FeishuIntakeTarget { readonly actor_id: string; readonly endpoint_id: string; }
export interface FeishuIntakeMessagePolicyOptions {
  readonly bot_open_id: string;
  readonly identity_resolver: ConnectorIdentityResolver;
  readonly target: FeishuIntakeTarget;
  readonly clock: { now(): string };
  readonly accept_within_seconds: number;
  readonly result_due_within_seconds: number;
  readonly max_intent_length: number;
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
function idempotency(claim: ConnectorIngressClaim): string {
  const digest = createHash("sha256").update(claim.envelope.tenant_id).update("\0").update(claim.envelope.connector_id).update("\0").update(bounded(claim.envelope.payload.message_id, "message_id")).digest("base64url");
  return `feishu-intake:${digest}`;
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
    const identity = await this.options.identity_resolver.resolve({
      tenant_id: claim.envelope.tenant_id, connector_id: claim.envelope.connector_id,
      source_system: "feishu", external_tenant_id: claim.envelope.external_tenant_id,
      external_subject_type: "user", external_subject_id: sender,
    });
    if (identity === null || identity.endpoint_id === undefined) return { kind: "rejected", reason_code: "identity_unmapped", retryable: false };
    const now = this.options.clock.now();
    const messageId = bounded(payload.message_id, "message_id", 255);
    const reference = `feishu://${encodeURIComponent(claim.envelope.external_tenant_id)}/message/${encodeURIComponent(messageId)}`;
    const input: JsonObject = {
      work_reference: { uri: reference, extensions: {
        "workfabric.dev/connector_id": claim.envelope.connector_id,
        "workfabric.dev/external_event_id": claim.envelope.external_event_id,
        ...(typeof payload.root_id === "string" ? { "workfabric.dev/root_id": payload.root_id } : {}),
        ...(typeof payload.parent_id === "string" ? { "workfabric.dev/parent_id": payload.parent_id } : {}),
      } },
      target: { actor_id: this.options.target.actor_id },
      intent: [{ kind: "text", media_type: "text/plain", text }],
      authority_scope: {
        delegation_id: `intake-${createHash("sha256").update(messageId).digest("hex").slice(0, 24)}`,
        scopes: ["work:read"], resource_refs: [reference],
        expires_at: addSeconds(now, this.options.result_due_within_seconds), may_redelegate: false,
      },
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
    return { kind: "command", command: { operation: "handoff.offer", idempotency_key: idempotency(claim), identity, input } };
  }
}
