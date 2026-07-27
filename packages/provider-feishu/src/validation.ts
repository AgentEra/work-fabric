import { createHash } from "node:crypto";

import type {
  FeishuCapabilityExecutionRequest,
  FeishuMessageTarget,
  SimpleDocumentContent,
} from "./contracts.js";

const CAPABILITIES = new Set([
  "feishu.message.send",
  "feishu.document.create",
  "feishu.document.read",
  "feishu.document.update",
  "feishu.document.append",
  "feishu.document.delete",
]);

function plain(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(`${path} is invalid`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      ["__proto__", "prototype", "constructor"].includes(key)
    ) {
      throw new TypeError(`${path} is unsafe`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function exact(
  value: unknown,
  fields: readonly string[],
  optional: readonly string[] = [],
  path = "input",
): Record<string, unknown> {
  const object = plain(value, path);
  const allowed = new Set([...fields, ...optional]);
  if (
    fields.some((field) => !Object.hasOwn(object, field)) ||
    Object.keys(object).some((field) => !allowed.has(field))
  ) {
    throw new TypeError(`${path} fields are invalid`);
  }
  return object;
}

function string(value: unknown, path: string, maximum = 8_192): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`${path} is invalid`);
  }
  return value;
}

function content(value: unknown): SimpleDocumentContent {
  const object = exact(value, ["media_type", "text"], [], "content");
  if (
    object.media_type !== "text/plain" &&
    object.media_type !== "text/markdown"
  ) {
    throw new TypeError("content.media_type is invalid");
  }
  if (
    typeof object.text !== "string" ||
    object.text.length === 0 ||
    new TextEncoder().encode(object.text).byteLength > 131_072 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(object.text)
  ) {
    throw new TypeError("content.text is invalid");
  }
  const text = object.text;
  if (
    object.media_type === "text/markdown" &&
    /(?:^|\n)\s*\|.*\|\s*(?:\n|$)|!\[[^\]]*\]\(|<[^>]+>/.test(text)
  ) {
    throw new TypeError("unsupported_document_shape");
  }
  return { media_type: object.media_type, text };
}

function document(value: unknown): string {
  const object = exact(value, ["kind", "token"], [], "document");
  if (object.kind !== "docx") throw new TypeError("document.kind is invalid");
  return string(object.token, "document.token", 128);
}

function target(value: unknown):
  | { readonly kind: "current_conversation" }
  | FeishuMessageTarget {
  const object = plain(value, "target");
  if (object.kind === "current_conversation") {
    exact(object, ["kind"], [], "target");
    return { kind: "current_conversation" };
  }
  exact(object, ["kind", "id"], [], "target");
  if (object.kind !== "open_id" && object.kind !== "chat_id") {
    throw new TypeError("target.kind is invalid");
  }
  return { kind: object.kind, id: string(object.id, "target.id", 255) };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(object[key])}`
  ).join(",")}}`;
}

export function inputDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

export type NormalizedFeishuInput =
  | {
      readonly kind: "message_send";
      readonly target:
        | { readonly kind: "current_conversation" }
        | FeishuMessageTarget;
      readonly content: SimpleDocumentContent;
    }
  | {
      readonly kind: "document_create";
      readonly title: string;
      readonly content: SimpleDocumentContent;
    }
  | {
      readonly kind: "document_read";
      readonly document_token: string;
      readonly max_bytes: number;
    }
  | {
      readonly kind: "document_update";
      readonly document_token: string;
      readonly expected_revision: string;
      readonly title?: string;
      readonly content: SimpleDocumentContent;
    }
  | {
      readonly kind: "document_append";
      readonly document_token: string;
      readonly expected_revision: string;
      readonly content: SimpleDocumentContent;
    }
  | {
      readonly kind: "document_delete";
      readonly document_token: string;
      readonly expected_revision: string;
      readonly confirmation_proof: string;
    };

export function normalizeFeishuInput(
  request: FeishuCapabilityExecutionRequest,
): NormalizedFeishuInput {
  if (!CAPABILITIES.has(request.capability_id)) {
    throw new TypeError("capability_id is unsupported");
  }
  switch (request.capability_id) {
    case "feishu.message.send": {
      const value = exact(request.input, ["target", "content"]);
      const normalized = content(value.content);
      if (normalized.media_type !== "text/plain") {
        throw new TypeError("message content must be text/plain");
      }
      return {
        kind: "message_send",
        target: target(value.target),
        content: normalized,
      };
    }
    case "feishu.document.create": {
      const value = exact(request.input, ["title", "content"]);
      return {
        kind: "document_create",
        title: string(value.title, "title", 512),
        content: content(value.content),
      };
    }
    case "feishu.document.read": {
      const value = exact(request.input, ["document", "max_bytes"]);
      if (
        !Number.isSafeInteger(value.max_bytes) ||
        (value.max_bytes as number) < 1 ||
        (value.max_bytes as number) > 131_072
      ) throw new TypeError("max_bytes is invalid");
      return {
        kind: "document_read",
        document_token: document(value.document),
        max_bytes: value.max_bytes as number,
      };
    }
    case "feishu.document.update": {
      const value = exact(
        request.input,
        ["document", "expected_revision", "content"],
        ["title"],
      );
      return {
        kind: "document_update",
        document_token: document(value.document),
        expected_revision: string(
          value.expected_revision,
          "expected_revision",
          128,
        ),
        ...(value.title === undefined
          ? {}
          : { title: string(value.title, "title", 512) }),
        content: content(value.content),
      };
    }
    case "feishu.document.append": {
      const value = exact(
        request.input,
        ["document", "expected_revision", "content"],
      );
      return {
        kind: "document_append",
        document_token: document(value.document),
        expected_revision: string(
          value.expected_revision,
          "expected_revision",
          128,
        ),
        content: content(value.content),
      };
    }
    default: {
      const value = exact(
        request.input,
        ["document", "expected_revision", "confirmation_proof"],
      );
      return {
        kind: "document_delete",
        document_token: document(value.document),
        expected_revision: string(
          value.expected_revision,
          "expected_revision",
          128,
        ),
        confirmation_proof: string(
          value.confirmation_proof,
          "confirmation_proof",
          256,
        ),
      };
    }
  }
}
