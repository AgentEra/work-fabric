import { isDeepStrictEqual } from "node:util";

import {
  ENDPOINT_INBOX_REQUIRED_CAPABILITIES,
  assertCapabilities,
  type CapabilityManifest,
  type EndpointInboxPartitionPage,
  type EndpointInboxPartitionQuery,
  type EndpointInboxRoutingFact,
  type EndpointInboxStore,
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

  async clearTenantProjection(tenantId: string): Promise<void> {
    for (const [key, fact] of this.facts) {
      if (fact.tenant_id === tenantId) this.facts.delete(key);
    }
  }
}
