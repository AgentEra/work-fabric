import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  PostgresClient,
  TenantSession,
} from "@work-fabric/adapter-postgres-common";
import { parseUtcTimestamp, type JsonObject } from "@work-fabric/exchange-spi";
import {
  createOpaqueCursorCodec,
  type CursorAuthenticator,
  type OpaqueCursorCodec,
} from "@work-fabric/operations-spi";

export type SessionFactory = (tenantId: string) => TenantSession;

export function clone<T>(value: T): T { return structuredClone(value); }

export function identity(value: unknown, field: string, maxLength = 255): string {
  if (
    typeof value !== "string" || value.length === 0 ||
    value.length > maxLength || value.trim() !== value
  ) throw new TypeError(`${field} is invalid`);
  return value;
}

export function positive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value as number;
}

export function timestamp(value: string, field: string): string {
  parseUtcTimestamp(value, field);
  return value;
}

export function json<T>(value: unknown): T {
  return typeof value === "string" ? JSON.parse(value) as T : clone(value as T);
}

export function run<T>(
  sessions: SessionFactory,
  tenantId: string,
  operation: (client: PostgresClient) => Promise<T>,
): Promise<T> {
  return sessions(tenantId).withTransaction(operation);
}

function authenticator(secret: string): CursorAuthenticator {
  const sign = (payload: string) =>
    createHmac("sha256", secret).update(payload).digest("base64url");
  return {
    async sign(payload) { return sign(payload); },
    async verify(payload, signature) {
      const expected = Buffer.from(sign(payload));
      const actual = Buffer.from(signature);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    },
  };
}

export function cursorCodec(secret: string, maxLength = 2048): OpaqueCursorCodec {
  identity(secret, "cursor_secret", 512);
  return createOpaqueCursorCodec(authenticator(secret), { max_length: maxLength });
}

export function filterJson(values: Readonly<Record<string, unknown>>): JsonObject {
  const result: Record<string, JsonObject[string]> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) result[key] = null;
    else if (Array.isArray(value)) result[key] = [...value].sort() as readonly string[];
    else result[key] = value as string | number | boolean | null;
  }
  return result;
}

export function positionString(value: JsonObject, field: string): string {
  return identity(value[field], `cursor ${field}`);
}

export function positionNumber(value: JsonObject, field: string): number {
  return positive(value[field], `cursor ${field}`);
}
