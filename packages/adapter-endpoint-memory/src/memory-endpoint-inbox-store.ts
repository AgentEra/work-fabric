import { isDeepStrictEqual } from "node:util";

import {
  ENDPOINT_INBOX_REQUIRED_CAPABILITIES,
  assertCapabilities,
  type CapabilityManifest,
  type EndpointClaimableHandoffPage,
  type EndpointClaimableHandoffQuery,
  type EndpointInboxPartitionPage,
  type EndpointInboxPartitionQuery,
  type EndpointInboxRoutingFact,
  type EndpointInboxStore,
  type EndpointExpiredClaimPage,
  type EndpointExpiredClaimQuery,
} from "@work-fabric/exchange-spi";
import {
  compareUtcTimestamps,
  parseUtcTimestamp,
} from "@work-fabric/exchange-spi";

const manifest: CapabilityManifest = {
  profile: "exchange.endpoint-inbox.v1",
  adapter: "memory",
  capabilities: Object.fromEntries(
    ENDPOINT_INBOX_REQUIRED_CAPABILITIES.map((capability) => [
      capability,
      true,
    ]),
  ),
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function factKey(fact: EndpointInboxRoutingFact): string {
  return JSON.stringify([fact.tenant_id, fact.handoff_id]);
}

function encodeCursor(
  query: EndpointInboxPartitionQuery,
  partitionId: string,
): string {
  return Buffer.from(
    JSON.stringify({
      tenant_id: query.tenant_id,
      actor_id: query.actor_id,
      endpoint_id: query.endpoint_id,
      partition_id: partitionId,
    }),
  ).toString("base64url");
}

function decodeCursor(query: EndpointInboxPartitionQuery): string | null {
  if (query.cursor === undefined) return null;
  try {
    const value = JSON.parse(
      Buffer.from(query.cursor, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      value.tenant_id !== query.tenant_id ||
      value.actor_id !== query.actor_id ||
      value.endpoint_id !== query.endpoint_id ||
      typeof value.partition_id !== "string"
    ) {
      throw new Error("cursor audience mismatch");
    }
    return value.partition_id;
  } catch {
    throw new TypeError("invalid cursor");
  }
}

function normalizedCapabilities(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function encodeClaimableCursor(
  query: EndpointClaimableHandoffQuery,
  handoffId: string,
): string {
  return Buffer.from(
    JSON.stringify({
      tenant_id: query.tenant_id,
      endpoint_id: query.endpoint_id,
      capability_ids: normalizedCapabilities(query.capability_ids),
      handoff_id: handoffId,
    }),
  ).toString("base64url");
}

function decodeClaimableCursor(
  query: EndpointClaimableHandoffQuery,
): string | null {
  if (query.cursor === undefined) return null;
  try {
    const value = JSON.parse(
      Buffer.from(query.cursor, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      value.tenant_id !== query.tenant_id ||
      value.endpoint_id !== query.endpoint_id ||
      JSON.stringify(value.capability_ids) !==
        JSON.stringify(normalizedCapabilities(query.capability_ids)) ||
      typeof value.handoff_id !== "string"
    ) {
      throw new Error("cursor query mismatch");
    }
    return value.handoff_id;
  } catch {
    throw new TypeError("invalid cursor");
  }
}

function encodeExpiredCursor(
  query: EndpointExpiredClaimQuery,
  expiresAt: string,
  handoffId: string,
): string {
  return Buffer.from(JSON.stringify({
    tenant_id: query.tenant_id,
    expires_at_or_before: query.expires_at_or_before,
    expires_at: expiresAt,
    handoff_id: handoffId,
  })).toString("base64url");
}

function decodeExpiredCursor(
  query: EndpointExpiredClaimQuery,
): { readonly expires_at: string; readonly handoff_id: string } | null {
  if (query.cursor === undefined) return null;
  try {
    const value = JSON.parse(
      Buffer.from(query.cursor, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      value.tenant_id !== query.tenant_id ||
      value.expires_at_or_before !== query.expires_at_or_before ||
      typeof value.expires_at !== "string" ||
      typeof value.handoff_id !== "string"
    ) throw new Error("cursor query mismatch");
    parseUtcTimestamp(value.expires_at, "cursor expires_at");
    return { expires_at: value.expires_at, handoff_id: value.handoff_id };
  } catch {
    throw new TypeError("invalid cursor");
  }
}

export class MemoryEndpointInboxStore implements EndpointInboxStore {
  private readonly facts = new Map<string, EndpointInboxRoutingFact>();

  get manifest(): CapabilityManifest {
    const value = clone(manifest);
    assertCapabilities(value, ENDPOINT_INBOX_REQUIRED_CAPABILITIES);
    return value;
  }

  async upsertRoutingFact(fact: EndpointInboxRoutingFact): Promise<void> {
    const candidate = clone(fact);
    const key = factKey(candidate);
    const existing = this.facts.get(key);
    if (existing !== undefined) {
      if (
        candidate.resource_version < existing.resource_version ||
        candidate.observed_position < existing.observed_position
      ) {
        throw new Error("Endpoint inbox projection must be monotonic");
      }
      if (candidate.resource_version === existing.resource_version) {
        if (isDeepStrictEqual(existing, candidate)) return;
        throw new Error("Endpoint inbox projection version conflicts");
      }
    }
    this.facts.set(key, candidate);
  }

  async listPartitions(
    input: EndpointInboxPartitionQuery,
  ): Promise<EndpointInboxPartitionPage> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new TypeError("limit must be a positive safe integer");
    }
    const after = decodeCursor(input);
    const grouped = new Map<
      string,
      { latest_position: number; active_handoff_count: number }
    >();
    for (const fact of this.facts.values()) {
      if (fact.tenant_id !== input.tenant_id || !fact.active) continue;
      if (
        !fact.visible_actor_ids.includes(input.actor_id) &&
        !fact.visible_endpoint_ids.includes(input.endpoint_id)
      ) {
        continue;
      }
      if (after !== null && fact.partition_id <= after) continue;
      const current = grouped.get(fact.partition_id) ?? {
        latest_position: 0,
        active_handoff_count: 0,
      };
      current.latest_position = Math.max(
        current.latest_position,
        fact.observed_position,
      );
      current.active_handoff_count += 1;
      grouped.set(fact.partition_id, current);
    }
    const values = [...grouped.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const items = values
      .slice(0, input.limit)
      .map(([partition_id, value]) => ({ partition_id, ...value }));
    return {
      items: clone(items),
      ...(values.length > input.limit
        ? {
            next_cursor: encodeCursor(
              input,
              items.at(-1)!.partition_id,
            ),
          }
        : {}),
    };
  }

  async listClaimableHandoffs(
    input: EndpointClaimableHandoffQuery,
  ): Promise<EndpointClaimableHandoffPage> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new TypeError("limit must be a positive safe integer");
    }
    const capabilities = new Set(normalizedCapabilities(input.capability_ids));
    const after = decodeClaimableCursor(input);
    const values = [...this.facts.values()]
      .filter((fact) =>
        fact.tenant_id === input.tenant_id &&
        fact.active &&
        fact.lifecycle_state === "claimable" &&
        (after === null || fact.handoff_id > after) &&
        fact.capability_ids.some((capabilityId) =>
          capabilities.has(capabilityId)
        ),
      )
      .sort((left, right) =>
        left.handoff_id < right.handoff_id
          ? -1
          : left.handoff_id > right.handoff_id
            ? 1
            : 0
      );
    const items = values.slice(0, input.limit).map((fact) => ({
      partition_id: fact.partition_id,
      handoff_id: fact.handoff_id,
      resource_version: fact.resource_version,
      lifecycle_state: "claimable" as const,
      capability_ids: [...fact.capability_ids],
      last_event_id: fact.last_event_id,
      observed_position: fact.observed_position,
    }));
    return {
      items: clone(items),
      ...(values.length > input.limit
        ? {
            next_cursor: encodeClaimableCursor(
              input,
              items.at(-1)!.handoff_id,
            ),
          }
        : {}),
    };
  }

  async listExpiredClaims(
    input: EndpointExpiredClaimQuery,
  ): Promise<EndpointExpiredClaimPage> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new TypeError("limit must be a positive safe integer");
    }
    parseUtcTimestamp(input.expires_at_or_before, "expires_at_or_before");
    const after = decodeExpiredCursor(input);
    const values = [...this.facts.values()]
      .filter((fact) => {
        const claim = fact.active_claim;
        if (
          fact.tenant_id !== input.tenant_id ||
          !fact.active ||
          fact.lifecycle_state !== "claimed" ||
          claim === undefined ||
          claim === null ||
          compareUtcTimestamps(claim.expires_at, input.expires_at_or_before) > 0
        ) return false;
        if (after === null) return true;
        const order = compareUtcTimestamps(claim.expires_at, after.expires_at);
        return order > 0 || (order === 0 && fact.handoff_id > after.handoff_id);
      })
      .sort((left, right) => {
        const expiry = compareUtcTimestamps(
          left.active_claim!.expires_at,
          right.active_claim!.expires_at,
        );
        return expiry !== 0
          ? expiry
          : left.handoff_id < right.handoff_id
            ? -1
            : left.handoff_id > right.handoff_id ? 1 : 0;
      });
    const items = values.slice(0, input.limit).map((fact) => ({
      partition_id: fact.partition_id,
      handoff_id: fact.handoff_id,
      resource_version: fact.resource_version,
      claim_id: fact.active_claim!.claim_id,
      fencing_token: fact.active_claim!.fencing_token,
      expires_at: fact.active_claim!.expires_at,
    }));
    const last = items.at(-1);
    return {
      items: clone(items),
      ...(values.length > input.limit && last !== undefined
        ? {
            next_cursor: encodeExpiredCursor(
              input,
              last.expires_at,
              last.handoff_id,
            ),
          }
        : {}),
    };
  }

  async clearTenantProjection(tenantId: string): Promise<void> {
    for (const [key, fact] of this.facts) {
      if (fact.tenant_id === tenantId) this.facts.delete(key);
    }
  }

  async clearPartitionProjection(tenantId: string, partitionId: string): Promise<void> {
    for (const [key, fact] of this.facts) {
      if (fact.tenant_id === tenantId && fact.partition_id === partitionId) {
        this.facts.delete(key);
      }
    }
  }
}
