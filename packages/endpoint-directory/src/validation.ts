import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  parseUtcTimestamp,
  type CapabilityDescriptor,
  type EndpointActorRef,
  type EndpointRegistration,
} from "@work-fabric/exchange-spi";

import { EndpointDirectoryError } from "./errors.js";

const CAPABILITY_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const PROTOCOL_VERSION = /^[0-9]+\.[0-9]+$/;
const MEDIA_TYPE = /^[^/\s]+\/[^/\s]+$/;
const FORBIDDEN_KEY =
  /(?:access[_-]?token|refresh[_-]?token|password|passwd|credential|client[_-]?secret|private[_-]?key|api[_-]?key)/i;

function invalid(message: string): never {
  throw new EndpointDirectoryError("invalid_request", message);
}

export function assertOpaqueId(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    invalid(`${field} is invalid`);
  }
}

export function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) invalid(`${field} is invalid`);
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${field} is invalid`);
}

function assertSafeObject(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSafeObject(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) invalid("secret-shaped fields are forbidden");
    assertSafeObject(item);
  }
}

export function assertActor(actor: EndpointActorRef): void {
  assertOpaqueId(actor.actor_id, "actor_id");
  if (!["human", "agent", "system"].includes(actor.actor_type)) {
    invalid("actor_type is invalid");
  }
}

export function assertCapability(capability: CapabilityDescriptor): void {
  if (!CAPABILITY_ID.test(capability.capability_id)) invalid("capability_id is invalid");
  if (!VERSION.test(capability.version)) invalid("capability version is invalid");
  if (capability.name.length === 0 || capability.name.length > 256) invalid("capability name is invalid");
  if (capability.description.length === 0 || capability.description.length > 4096) invalid("capability description is invalid");
  for (const mediaType of [...capability.input_media_types, ...capability.output_media_types]) {
    if (!MEDIA_TYPE.test(mediaType) || mediaType.length > 255) invalid("capability media type is invalid");
  }
  assertSafeObject(capability.constraints);
  assertSafeObject(capability.extensions ?? {});
}

export function assertRegistration(
  registration: EndpointRegistration,
  maxBindings: number,
): void {
  assertOpaqueId(registration.endpoint_id, "endpoint_id");
  assertActor(registration.actor);
  if (registration.display_name.length === 0 || registration.display_name.length > 256) invalid("display_name is invalid");
  if (registration.protocol_versions.length === 0 || registration.protocol_versions.some((value) => !PROTOCOL_VERSION.test(value))) invalid("protocol_versions are invalid");
  if (new Set(registration.protocol_versions).size !== registration.protocol_versions.length) invalid("protocol_versions must be unique");
  if (registration.bindings.length === 0 || registration.bindings.length > maxBindings) invalid("bindings exceed the configured bound");
  for (const binding of registration.bindings) {
    if (binding.binding_type.length === 0 || binding.uri.length === 0 || binding.security_schemes.length === 0) invalid("binding is invalid");
    assertSafeObject(binding.extensions ?? {});
  }
  if (new Set(registration.allowed_capability_ids).size !== registration.allowed_capability_ids.length) invalid("allowed capability IDs must be unique");
  for (const id of registration.allowed_capability_ids) if (!CAPABILITY_ID.test(id)) invalid("allowed capability ID is invalid");
  assertNonNegativeInteger(registration.limits.max_inline_content_bytes, "max_inline_content_bytes");
  assertPositiveInteger(registration.registration_version, "registration_version");
  assertSafeObject(registration.extensions ?? {});
}

export function sameActor(left: EndpointActorRef, right: EndpointActorRef): boolean {
  return left.actor_id === right.actor_id && left.actor_type === right.actor_type;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

export function semanticDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function sameValue(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

export function assertTimestamp(value: string, field: string): void {
  try {
    parseUtcTimestamp(value, field);
  } catch {
    invalid(`${field} is invalid`);
  }
}
