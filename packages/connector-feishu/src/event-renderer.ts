import type { ProtocolEvent } from "@work-fabric/exchange-spi";
import { addUtcTimestampSeconds } from "@work-fabric/exchange-spi";

import type { FeishuActionReferenceCodec } from "./action-token.js";
import {
  assertSafeMarkdownLinks,
  FeishuMarkdownError,
} from "./markdown-content.js";
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
  readonly msg_type: "text" | "post" | "interactive";
  readonly content: string;
}

export class FeishuRenderError extends Error {
  constructor(
    readonly code:
      | "unsupported_media_type"
      | "unsafe_link"
      | "rendering_failed",
  ) {
    super(code);
    this.name = "FeishuRenderError";
  }
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

function object(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) throw new TypeError(`${label} is invalid`);
  return value as Record<string, unknown>;
}

interface AgentResultContent {
  readonly media_type: string;
  readonly text: string;
  readonly recipients: readonly {
    readonly user_id: string;
    readonly display_text: string;
  }[];
}

const FEISHU_OPEN_ID = /^[A-Za-z0-9_-]{1,255}$/;

function exactKeys(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === fields.length &&
    keys.every((key) => fields.includes(key))
  );
}

function delegatedResourceRefs(
  snapshot: Record<string, unknown>,
): ReadonlySet<string> {
  if (
    snapshot.package === undefined ||
    snapshot.package === null ||
    typeof snapshot.package !== "object" ||
    Array.isArray(snapshot.package)
  ) return new Set();
  const handoffPackage = object(snapshot.package, "result snapshot package");
  if (
    handoffPackage.authority_scope === undefined ||
    handoffPackage.authority_scope === null ||
    typeof handoffPackage.authority_scope !== "object" ||
    Array.isArray(handoffPackage.authority_scope)
  ) return new Set();
  const authority = object(
    handoffPackage.authority_scope,
    "result snapshot authority",
  );
  if (!Array.isArray(authority.resource_refs)) return new Set();
  const refs = authority.resource_refs;
  if (
    refs.length > 256 ||
    refs.some((ref) =>
      typeof ref !== "string" ||
      ref.length === 0 ||
      ref.length > 2_048 ||
      ref.trim() !== ref
    )
  ) {
    throw new FeishuRenderError("rendering_failed");
  }
  return new Set(refs as string[]);
}

function recipientReference(
  value: unknown,
  allowed: ReadonlySet<string>,
): { readonly user_id: string; readonly display_text: string } {
  try {
    const recipient = object(value, "result recipient reference");
    if (
      !exactKeys(
        recipient,
        ["kind", "resource_uri", "display_text"],
      ) ||
      recipient.kind !== "mention" ||
      typeof recipient.resource_uri !== "string" ||
      !allowed.has(recipient.resource_uri) ||
      typeof recipient.display_text !== "string" ||
      recipient.display_text.length === 0 ||
      recipient.display_text.length > 128 ||
      recipient.display_text.trim() !== recipient.display_text ||
      /[\u0000-\u001f\u007f]/u.test(recipient.display_text)
    ) {
      throw new FeishuRenderError("rendering_failed");
    }
    const prefix = "feishu://user/open-id/";
    if (!recipient.resource_uri.startsWith(prefix)) {
      throw new FeishuRenderError("rendering_failed");
    }
    const encoded = recipient.resource_uri.slice(prefix.length);
    let userId: string;
    try {
      userId = decodeURIComponent(encoded);
    } catch {
      throw new FeishuRenderError("rendering_failed");
    }
    if (
      userId === "all" ||
      !FEISHU_OPEN_ID.test(userId) ||
      encodeURIComponent(userId) !== encoded
    ) {
      throw new FeishuRenderError("rendering_failed");
    }
    return {
      user_id: userId,
      display_text: recipient.display_text,
    };
  } catch (error) {
    if (error instanceof FeishuRenderError) throw error;
    throw new FeishuRenderError("rendering_failed");
  }
}

function agentResultContent(event: ProtocolEvent): AgentResultContent {
  const snapshot = object(event.data.snapshot, "result snapshot");
  const result = object(snapshot.result, "result snapshot result");
  if (!Array.isArray(result.summary)) {
    throw new TypeError("result summary is invalid");
  }
  const texts: string[] = [];
  const recipients: {
    readonly user_id: string;
    readonly display_text: string;
  }[] = [];
  const recipientIds = new Set<string>();
  const allowedRecipients = delegatedResourceRefs(snapshot);
  let mediaType: string | undefined;
  for (const [index, value] of result.summary.entries()) {
    const part = object(value, `result summary ${index}`);
    if (part.kind !== "text") continue;
    if (
      typeof part.media_type !== "string" ||
      !/^text\/[^/\s]+$/.test(part.media_type) ||
      typeof part.text !== "string" ||
      part.text.length === 0
    ) throw new TypeError(`result summary ${index} is invalid`);
    if (mediaType !== undefined && part.media_type !== mediaType) {
      throw new FeishuRenderError("unsupported_media_type");
    }
    mediaType = part.media_type;
    texts.push(part.text);
    const contentExtensions = part.extensions === undefined
      ? undefined
      : object(
        part.extensions,
        `result summary ${index} extensions`,
      );
    const recipientReferences =
      contentExtensions?.["workfabric.dev/recipient_references"];
    if (recipientReferences !== undefined) {
      if (!Array.isArray(recipientReferences)) {
        throw new FeishuRenderError("rendering_failed");
      }
      for (const value of recipientReferences) {
        if (recipients.length >= 16) {
          throw new FeishuRenderError("rendering_failed");
        }
        const recipient = recipientReference(value, allowedRecipients);
        if (recipientIds.has(recipient.user_id)) {
          throw new FeishuRenderError("rendering_failed");
        }
        recipientIds.add(recipient.user_id);
        recipients.push(recipient);
      }
    }
  }
  if (texts.length === 0 || mediaType === undefined) {
    throw new TypeError("result summary has no text content");
  }
  if (mediaType !== "text/plain" && mediaType !== "text/markdown") {
    throw new FeishuRenderError("unsupported_media_type");
  }
  return {
    media_type: mediaType,
    text: texts.join("\n"),
    recipients: Object.freeze(recipients),
  };
}

function escapeFeishuMarkup(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]!);
}

function markdownMentions(
  recipients: AgentResultContent["recipients"],
): string {
  return recipients.map((recipient) =>
    `<at user_id="${recipient.user_id}">${
      escapeFeishuMarkup(recipient.display_text)
    }</at>`
  ).join(" ");
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
    if (event.type === "workfabric.handoff.result_returned.v1") {
      const reply = agentResultContent(event);
      if (
        reply.media_type === "text/plain" &&
        reply.recipients.length === 0
      ) {
        const content = JSON.stringify({ text: reply.text });
        if (encodedSize(content) > this.options.max_text_bytes) {
          throw new FeishuRenderError("rendering_failed");
        }
        return { msg_type: "text", content };
      }
      if (reply.media_type === "text/plain") {
        const content = JSON.stringify({
          zh_cn: {
            title: "",
            content: [[
              ...reply.recipients.map((recipient) => ({
                tag: "at",
                user_id: recipient.user_id,
                user_name: recipient.display_text,
              })),
              { tag: "text", text: reply.text },
            ]],
          },
        });
        if (encodedSize(content) > this.options.max_card_bytes) {
          throw new FeishuRenderError("rendering_failed");
        }
        return { msg_type: "post", content };
      }
      try {
        assertSafeMarkdownLinks(reply.text);
      } catch (error) {
        if (error instanceof FeishuMarkdownError) {
          throw new FeishuRenderError("unsafe_link");
        }
        throw error;
      }
      const content = JSON.stringify({
        zh_cn: {
          title: "",
          content: [[{
            tag: "md",
            text: reply.recipients.length === 0
              ? reply.text
              : `${markdownMentions(reply.recipients)}\n${reply.text}`,
          }]],
        },
      });
      if (encodedSize(content) > this.options.max_card_bytes) {
        throw new FeishuRenderError("rendering_failed");
      }
      return { msg_type: "post", content };
    }
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
