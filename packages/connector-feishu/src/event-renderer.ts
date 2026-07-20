import type { ProtocolEvent } from "@work-fabric/exchange-spi";
import { addUtcTimestampSeconds } from "@work-fabric/exchange-spi";

import type { FeishuActionReferenceCodec } from "./action-token.js";
import type { FeishuReceiveIdType } from "./open-api-client.js";

const ALLOWED_DESTINATION_KEYS = new Set([
  "credential_ref",
  "connector_id",
  "external_tenant_id",
  "actor_id",
  "actor_type",
  "endpoint_id",
  "delegation_id",
  "receive_id_type",
  "receive_id",
  "render_mode",
  "action_ttl_seconds",
]);
const SECRET_KEY = /(?:secret|password|token|private[_-]?key|credential(?!_ref))/i;

export interface FeishuDestinationConfiguration {
  readonly credential_ref: string;
  readonly connector_id: string;
  readonly external_tenant_id: string;
  readonly actor_id: string;
  readonly actor_type: "human" | "agent" | "system";
  readonly endpoint_id?: string;
  readonly delegation_id?: string;
  readonly receive_id_type: FeishuReceiveIdType;
  readonly receive_id: string;
  readonly render_mode: "text" | "card";
  readonly action_ttl_seconds: number;
}

export interface FeishuRenderedMessage {
  readonly msg_type: "text" | "interactive";
  readonly content: string;
}

export interface FeishuEventRendererOptions {
  readonly action_codec: FeishuActionReferenceCodec;
  readonly clock: { now(): string };
  readonly max_text_bytes: number;
  readonly max_card_bytes: number;
}

function bounded(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value.trim() !== value
  ) throw new TypeError(`${label} is invalid`);
  return value;
}

export function parseFeishuDestination(
  value: Record<string, unknown>,
): FeishuDestinationConfiguration {
  if (
    Object.keys(value).some(
      (key) => SECRET_KEY.test(key) || !ALLOWED_DESTINATION_KEYS.has(key),
    )
  ) throw new TypeError("Feishu destination contains a forbidden field");
  const receiveIdType = value.receive_id_type;
  if (
    receiveIdType !== "open_id" &&
    receiveIdType !== "user_id" &&
    receiveIdType !== "union_id" &&
    receiveIdType !== "email" &&
    receiveIdType !== "chat_id"
  ) throw new TypeError("receive_id_type is invalid");
  const renderMode = value.render_mode;
  if (renderMode !== "text" && renderMode !== "card") {
    throw new TypeError("render_mode is invalid");
  }
  if (
    value.actor_type !== "human" &&
    value.actor_type !== "agent" &&
    value.actor_type !== "system"
  ) throw new TypeError("actor_type is invalid");
  if (
    !Number.isSafeInteger(value.action_ttl_seconds) ||
    (value.action_ttl_seconds as number) <= 0 ||
    (value.action_ttl_seconds as number) > 86_400
  ) throw new RangeError("action_ttl_seconds is invalid");
  return {
    credential_ref: bounded(value.credential_ref, "credential_ref"),
    connector_id: bounded(value.connector_id, "connector_id"),
    external_tenant_id: bounded(value.external_tenant_id, "external_tenant_id"),
    actor_id: bounded(value.actor_id, "actor_id"),
    actor_type: value.actor_type,
    ...(value.endpoint_id === undefined
      ? {} : { endpoint_id: bounded(value.endpoint_id, "endpoint_id") }),
    ...(value.delegation_id === undefined
      ? {} : { delegation_id: bounded(value.delegation_id, "delegation_id") }),
    receive_id_type: receiveIdType,
    receive_id: bounded(value.receive_id, "receive_id"),
    render_mode: renderMode,
    action_ttl_seconds: value.action_ttl_seconds as number,
  };
}

function encodedSize(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export class FeishuEventRenderer {
  constructor(private readonly options: FeishuEventRendererOptions) {
    if (
      !Number.isSafeInteger(options.max_text_bytes) ||
      options.max_text_bytes <= 0 ||
      !Number.isSafeInteger(options.max_card_bytes) ||
      options.max_card_bytes <= 0
    ) throw new RangeError("Feishu renderer limits must be positive integers");
  }

  render(
    event: ProtocolEvent,
    destination: FeishuDestinationConfiguration,
  ): FeishuRenderedMessage {
    const handoffId = bounded(event.wfhandoff ?? event.subject, "handoff_id");
    const change = event.data.change as
      | { readonly [key: string]: unknown }
      | undefined;
    const state =
      change !== null &&
      typeof change === "object" &&
      !Array.isArray(change) &&
      typeof change.to_state === "string"
        ? change.to_state
        : "updated";
    if (destination.render_mode === "text") {
      const content = JSON.stringify({
        text: `Work Fabric · ${event.type}\nHandoff: ${handoffId}\nState: ${state}`,
      });
      if (encodedSize(content) > this.options.max_text_bytes) {
        throw new RangeError("Feishu text exceeds its configured limit");
      }
      return { msg_type: "text", content };
    }

    const elements: unknown[] = [{
      tag: "div",
      text: {
        tag: "plain_text",
        content: `Handoff ${handoffId}\nState: ${state}`,
      },
    }];
    if (
      event.type === "workfabric.handoff.offered.v1" &&
      destination.receive_id_type === "open_id" &&
      event.wftenant !== undefined
    ) {
      const now = this.options.clock.now();
      const expiresAt = addUtcTimestampSeconds(
        now,
        destination.action_ttl_seconds,
      );
      const version =
        Number.isSafeInteger(event.data.resource_version) &&
        (event.data.resource_version as number) > 0
          ? event.data.resource_version as number
          : event.wfsequence;
      const action = (operation: "handoff.accept" | "handoff.decline") =>
        this.options.action_codec.issue({
          tenant_id: event.wftenant!,
          connector_id: destination.connector_id,
          external_tenant_id: destination.external_tenant_id,
          external_subject_id: destination.receive_id,
          identity: {
            actor_id: destination.actor_id,
            actor_type: destination.actor_type,
            ...(destination.endpoint_id === undefined
              ? {} : { endpoint_id: destination.endpoint_id }),
            ...(destination.delegation_id === undefined
              ? {} : { delegation_id: destination.delegation_id }),
          },
          operation,
          expected_version: version,
          input: { handoff_id: handoffId },
          expires_at: expiresAt,
        });
      elements.push({
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "Accept" },
            type: "primary",
            value: { action_ref: action("handoff.accept") },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "Decline" },
            type: "default",
            value: { action_ref: action("handoff.decline") },
          },
        ],
      });
    }
    const content = JSON.stringify({
      schema: "2.0",
      config: { update_multi: true },
      header: { title: { tag: "plain_text", content: "Work Fabric" } },
      body: { elements },
    });
    if (encodedSize(content) > this.options.max_card_bytes) {
      throw new RangeError("Feishu card exceeds its configured limit");
    }
    return { msg_type: "interactive", content };
  }
}
