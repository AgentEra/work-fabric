import { describe, expect, it } from "vitest";

import { MemoryDiscoveryStore } from "@work-fabric/adapter-discovery-memory";
import {
  DISCOVERY_PROFILE,
  type DiscoveryDisclosurePolicy,
  type DiscoveryRecord,
} from "@work-fabric/discovery-spi";

import {
  DiscoveryError,
  DiscoveryQueryService,
} from "../src/index.js";

const scope = { tenant_id: "tenant-a", tenant_view_id: "view-a" };
const context = {
  ...scope,
  principal_id: "principal-a",
  represented_actor: { actor_id: "actor-caller", actor_type: "agent" as const },
  represented_endpoint_id: "endpoint-caller",
};

function route(origin: string, id: string, expiresAt = "2026-08-01T00:01:00.000Z"): DiscoveryRecord<"capability_route"> {
  return {
    profile: DISCOVERY_PROFILE,
    record_id: id,
    record_kind: "capability_route",
    origin_exchange_id: origin,
    revision: 1,
    issued_at: "2026-08-01T00:00:00.000Z",
    expires_at: expiresAt,
    visibility: "public",
    audiences: [],
    transitive: false,
    max_hops: 0,
    payload: {
      capability_id: "software.implementation",
      versions: ["1.0.0"],
      input_media_types: ["application/json"],
      output_media_types: ["application/json"],
      input_schema_refs: [],
      output_schema_refs: [],
      interaction_modes: ["asynchronous"],
      binding_types: ["http_sse"],
      security_schemes: ["oauth2"],
      availability: "available",
    },
    payload_digest: "a".repeat(64),
    key_id: "key-1",
    signature: "A".repeat(86),
  };
}

function endpoint(id: string): DiscoveryRecord<"endpoint"> {
  return {
    profile: DISCOVERY_PROFILE,
    record_id: `endpoint:${id}`,
    record_kind: "endpoint",
    origin_exchange_id: "exchange-remote",
    revision: 2,
    issued_at: "2026-08-01T00:00:00.000Z",
    expires_at: "2026-08-01T00:01:00.000Z",
    visibility: "peer",
    audiences: ["exchange-local"],
    transitive: false,
    max_hops: 0,
    payload: {
      endpoint_id: id,
      actor: { actor_id: "actor-remote", actor_type: "agent" },
      endpoint_type: "native_agent",
      display_name: "Remote Agent",
      protocol_versions: ["1.0"],
      bindings: [{ binding_type: "http_sse", uri: "https://remote.example.test", security_schemes: ["oauth2"] }],
      capabilities: [],
      availability: "available",
      limits: { max_inline_content_bytes: 65_536 },
    },
    payload_digest: "b".repeat(64),
    key_id: "key-1",
    signature: "B".repeat(86),
  };
}

function exchange(): DiscoveryRecord<"exchange"> {
  return {
    profile: DISCOVERY_PROFILE,
    record_id: "exchange:exchange-remote",
    record_kind: "exchange",
    origin_exchange_id: "exchange-remote",
    revision: 1,
    issued_at: "2026-08-01T00:00:00.000Z",
    expires_at: "2026-08-01T00:01:00.000Z",
    visibility: "public",
    audiences: [],
    transitive: false,
    max_hops: 0,
    payload: {
      exchange_id: "exchange-remote",
      display_name: "Remote Exchange",
      discovery_profiles: [DISCOVERY_PROFILE],
      federation_profiles: [],
      bindings: [],
      security_schemes: ["oauth2"],
    },
    payload_digest: "c".repeat(64),
    key_id: "key-1",
    signature: "C".repeat(86),
  };
}

function participant(): DiscoveryRecord<"participant"> {
  return {
    profile: DISCOVERY_PROFILE,
    record_id: "participant:actor-remote",
    record_kind: "participant",
    origin_exchange_id: "exchange-remote",
    revision: 1,
    issued_at: "2026-08-01T00:00:00.000Z",
    expires_at: "2026-08-01T00:01:00.000Z",
    visibility: "peer",
    audiences: ["exchange-local"],
    transitive: false,
    max_hops: 0,
    payload: {
      actor: { actor_id: "actor-remote", actor_type: "agent" },
      display_name: "Remote Actor",
      endpoint_ids: ["endpoint-visible"],
    },
    payload_digest: "d".repeat(64),
    key_id: "key-1",
    signature: "D".repeat(86),
  };
}

async function service(deniedRecordIds: readonly string[] = []) {
  const store = new MemoryDiscoveryStore({ max_records_per_origin: 20, tombstone_retention_seconds: 300 });
  for (const record of [
    route("exchange-z", "route-z"),
    route("exchange-a", "route-a"),
    route("exchange-expired", "route-expired", "2026-08-01T00:00:01.000Z"),
    endpoint("endpoint-visible"),
    endpoint("endpoint-hidden"),
    exchange(),
    participant(),
  ]) await store.apply({ ...scope, source_peer_id: "peer", value: record });
  const policy: DiscoveryDisclosurePolicy = {
    async canRead(input) { return !deniedRecordIds.includes(input.record.record_id); },
  };
  return new DiscoveryQueryService({
    store,
    policy,
    clock: { now: () => "2026-08-01T00:00:30.000Z" },
    cursor_secret: "x".repeat(32),
    default_page_limit: 10,
    max_page_limit: 100,
    max_scan_results: 1_000,
  });
}

describe("DiscoveryQueryService", () => {
  it("returns fresh authorized and deterministically unranked facts", async () => {
    const query = await service();
    const page = await query.findCapabilities(context, {
      capability_id: "software.implementation",
      binding_types: ["http_sse"],
    });

    expect(page.items.map((item) => item.origin_exchange_id)).toEqual([
      "exchange-a",
      "exchange-z",
    ]);
    expect(page.items.every((item) => Date.parse(item.expires_at) > Date.parse("2026-08-01T00:00:30.000Z"))).toBe(true);
    expect(JSON.stringify(page)).not.toMatch(/score|rank|preferred_target/);
  });

  it("applies route filters even when capability_id is omitted", async () => {
    const query = await service();

    const page = await query.findCapabilities(context, { binding_types: ["mqtt"] });

    expect(page.items).toEqual([]);
  });

  it("does not distinguish a hidden Endpoint from a nonexistent Endpoint", async () => {
    const query = await service(["endpoint:endpoint-hidden"]);
    let hidden: unknown;
    let absent: unknown;
    try { await query.getEndpoint(context, "endpoint-hidden"); } catch (error) { hidden = error; }
    try { await query.getEndpoint(context, "endpoint-missing"); } catch (error) { absent = error; }

    expect(hidden).toBeInstanceOf(DiscoveryError);
    expect(absent).toBeInstanceOf(DiscoveryError);
    expect((hidden as DiscoveryError).code).toBe("discovery_not_found");
    expect((absent as DiscoveryError).code).toBe("discovery_not_found");
    expect((hidden as Error).message).toBe((absent as Error).message);
  });

  it("resolves fresh authorized Exchange, Participant, and Endpoint facts", async () => {
    const query = await service();

    await expect(query.getExchange(context, "exchange-remote"))
      .resolves.toMatchObject({ record_kind: "exchange", payload: { exchange_id: "exchange-remote" } });
    await expect(query.getParticipant(context, "actor-remote"))
      .resolves.toMatchObject({ record_kind: "participant", payload: { actor: { actor_id: "actor-remote" } } });
    await expect(query.getEndpoint(context, "endpoint-visible"))
      .resolves.toMatchObject({ record_kind: "endpoint", payload: { endpoint_id: "endpoint-visible" } });
  });

  it("binds pagination cursors to the caller and query", async () => {
    const query = await service();
    const first = await query.findCapabilities(context, { limit: 1 });
    expect(first.next_cursor).toBeDefined();
    await expect(query.findCapabilities({ ...context, principal_id: "principal-b" }, {
      limit: 1,
      cursor: first.next_cursor!,
    })).rejects.toMatchObject({ code: "discovery_cursor_invalid" });
  });

  it("re-applies caller disclosure to federated facts", async () => {
    const query = await service(["route-a"]);

    const page = await query.filterFederated(context, {
      coverage: "partial",
      items: [route("exchange-a", "route-a"), route("exchange-z", "route-z")],
      warnings: ["remote_partial"],
    });

    expect(page).toEqual({
      coverage: "partial",
      items: [expect.objectContaining({ record_id: "route-z" })],
      warnings: ["remote_partial"],
    });
  });
});
