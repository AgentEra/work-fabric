import { cpus, platform, release } from "node:os";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  MemoryDiscoveryPeerBindingStore,
  MemoryDiscoveryStore,
} from "@work-fabric/adapter-discovery-memory";
import {
  DiscoveryCacheService,
  DiscoveryExportCoordinator,
  DiscoveryGateway,
  DiscoveryMessageCodec,
  DiscoveryQueryService,
  DiscoveryRecordCodec,
  discoveryCanonicalSha256,
} from "@work-fabric/discovery-runtime";
import type {
  DiscoveryPeerBinding,
  DiscoverySigner,
  DiscoveryTrustResolver,
} from "@work-fabric/discovery-spi";

const scope = {
  tenant_id: "tenant_benchmark",
  tenant_view_id: "view_benchmark",
};
const timestamp = "2026-08-01T00:00:00.000Z";
const clock = { now: () => timestamp };
const signer: DiscoverySigner = {
  key_id: "benchmark-key",
  async sign(canonical) {
    return createHash("sha512").update(canonical).digest("base64url");
  },
};
const trust: DiscoveryTrustResolver = {
  async verify(input) {
    return createHash("sha512").update(input.canonical).digest("base64url") === input.signature;
  },
};

function bounded(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new RangeError(`${field} must be between 1 and 10000`);
  }
  return value;
}

function percentile(values: readonly number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1));
  return ordered[index] ?? 0;
}

function latency(values: readonly number[]) {
  return {
    p50_ms: Number(percentile(values, 0.5).toFixed(3)),
    p95_ms: Number(percentile(values, 0.95).toFixed(3)),
  };
}

function binding(local: string, remote: string): DiscoveryPeerBinding {
  return {
    ...scope,
    peer_id: `peer_${remote}`,
    exchange_id: remote,
    state: "active",
    allow_import: true,
    allow_export: true,
    allow_query: true,
    allow_transit: true,
    max_page_size: 20,
    max_response_bytes: 65_536,
    version: 1,
  };
}

async function signedRoute(
  codec: DiscoveryRecordCodec,
  originExchangeId: string,
  recordId: string,
  expiresAt = "2026-08-01T00:05:00.000Z",
) {
  const bytes = await codec.sign({
    record_id: recordId,
    record_kind: "capability_route",
    origin_exchange_id: originExchangeId,
    revision: 1,
    issued_at: timestamp,
    expires_at: expiresAt,
    visibility: "public",
    audiences: [],
    transitive: true,
    max_hops: 2,
    payload: {
      capability_id: "software.implementation",
      versions: ["1.0.0"],
      input_media_types: ["application/json"],
      output_media_types: ["application/json"],
      input_schema_refs: [],
      output_schema_refs: [],
      interaction_modes: ["asynchronous"],
      binding_types: ["http_sse"],
      security_schemes: ["bearer"],
      availability: "available",
    },
  });
  return JSON.parse(new TextDecoder().decode(bytes));
}

interface NodeFixture {
  readonly store: MemoryDiscoveryStore;
  readonly peers: MemoryDiscoveryPeerBindingStore;
  readonly codec: DiscoveryRecordCodec;
  readonly gateway: DiscoveryGateway;
}

async function network() {
  const exchanges = ["exchange_a", "exchange_b", "exchange_c"] as const;
  const nodes = new Map<string, NodeFixture>();
  const calls = new Map<string, number>();
  let id = 0;

  for (const exchangeId of exchanges) {
    const store = new MemoryDiscoveryStore({
      max_records_per_origin: 100,
      tombstone_retention_seconds: 300,
    });
    const peers = new MemoryDiscoveryPeerBindingStore();
    for (const remote of exchanges) {
      if (remote !== exchangeId) {
        await peers.put({ binding: binding(exchangeId, remote), expected_version: null });
      }
    }
    const codec = new DiscoveryRecordCodec({
      local_exchange_id: exchangeId,
      signer,
      trust,
      clock,
    });
    nodes.set(exchangeId, { store, peers, codec, gateway: undefined as never });
  }

  for (const exchangeId of exchanges) {
    const node = nodes.get(exchangeId)!;
    const gateway = new DiscoveryGateway({
      ...scope,
      local_exchange_id: exchangeId,
      message_codec: new DiscoveryMessageCodec({
        local_exchange_id: exchangeId,
        signer,
        trust,
        clock,
      }),
      record_codec: node.codec,
      cache: new DiscoveryCacheService({
        local_exchange_id: exchangeId,
        codec: node.codec,
        store: node.store,
        peers: node.peers,
        clock,
      }),
      store: node.store,
      peers: node.peers,
      export_policy: { async exportRecord({ record }) { return record; } },
      clock,
      id_generator: { nextId: (kind) => `${exchangeId}_${kind}_${++id}` },
      query_transport: (peer) => ({
        async exchange(request) {
          calls.set(peer.exchange_id, (calls.get(peer.exchange_id) ?? 0) + 1);
          return nodes.get(peer.exchange_id)!.gateway.receiveQuery(request);
        },
      }),
      query_max_in_flight: 8,
      query_max_entries: 100,
    });
    nodes.set(exchangeId, { ...node, gateway });
  }
  for (const exchangeId of exchanges) {
    const node = nodes.get(exchangeId)!;
    await node.store.apply({
      ...scope,
      source_peer_id: null,
      value: await signedRoute(node.codec, exchangeId, `route_${exchangeId}`),
    });
  }
  return { nodes, calls };
}

export interface DiscoveryBenchmarkOptions {
  readonly query_samples: number;
  readonly sync_samples: number;
}

export async function runDiscoveryBenchmark(candidate: DiscoveryBenchmarkOptions) {
  const options = {
    query_samples: bounded(candidate.query_samples, "query_samples"),
    sync_samples: bounded(candidate.sync_samples, "sync_samples"),
  };

  const stablePublicPayload = {
    capability_id: "software.implementation",
    versions: ["1.0.0"],
    availability: "available",
  };
  const stableDigest = discoveryCanonicalSha256(stablePublicPayload);
  let heartbeatPeerUpdates = 0;
  for (let index = 0; index < 10_000; index += 1) {
    if (discoveryCanonicalSha256(stablePublicPayload) !== stableDigest) heartbeatPeerUpdates += 1;
  }

  const scheduled: Array<() => void> = [];
  let refreshTurns = 0;
  const coordinator = new DiscoveryExportCoordinator({
    coalescing_window_ms: 100,
    schedule(_delay, callback) { scheduled.push(callback); },
    async refresh() { refreshTurns += 1; },
  });
  for (let index = 0; index < 1_000; index += 1) coordinator.requestRefresh();
  scheduled.shift()?.();
  await coordinator.idle();

  const { nodes, calls } = await network();
  const nodeA = nodes.get("exchange_a")!;
  const nodeB = nodes.get("exchange_b")!;
  const localQuery = new DiscoveryQueryService({
    store: nodeA.store,
    policy: { async canRead() { return true; } },
    clock,
    cursor_secret: "0123456789abcdef0123456789abcdef",
    default_page_limit: 20,
    max_page_limit: 100,
    max_scan_results: 100,
  });
  const queryTimes: number[] = [];
  for (let sample = 0; sample < options.query_samples; sample += 1) {
    const started = performance.now();
    const page = await localQuery.findCapabilities({
      ...scope,
      principal_id: "benchmark_agent",
    }, {
      capability_id: "software.implementation",
      limit: 10,
    });
    if (page.items.length !== 1) throw new Error("benchmark local query invariant failed");
    queryTimes.push(performance.now() - started);
  }

  const syncTimes: number[] = [];
  let syncBytes = 0;
  let cursor: string | undefined;
  let etag: string | undefined;
  for (let sample = 0; sample < options.sync_samples; sample += 1) {
    const prepared = await nodeB.gateway.prepareSync({
      peer_id: "peer_exchange_a",
      ...(cursor === undefined ? {} : { cursor }),
      ...(etag === undefined ? {} : { etag }),
    });
    const started = performance.now();
    const result = await nodeB.gateway.deliverSync(prepared, {
      async exchange(request) {
        const response = await nodeA.gateway.receiveSync(request);
        syncBytes += request.byteLength + response.byteLength;
        return response;
      },
    });
    if (result.outcome !== "applied") throw new Error("benchmark sync invariant failed");
    cursor = result.next_cursor;
    etag = result.etag;
    syncTimes.push(performance.now() - started);
  }

  calls.clear();
  const preparedQuery = await nodeA.gateway.prepareQuery({
    peer_id: "peer_exchange_b",
    query_id: "benchmark_cycle",
    query: {
      record_kinds: ["capability_route"],
      capability_id: "software.implementation",
      limit: 10,
    },
    budget: {
      deadline: "2026-08-01T00:00:30.000Z",
      remaining_hops: 2,
      remaining_fanout: 3,
      remaining_results: 10,
      remaining_bytes: 65_536,
    },
  });
  const cycleResponse = await nodeB.gateway.receiveQuery(preparedQuery.bytes);
  await nodeA.gateway.deliverQuery(preparedQuery, { exchange: async () => cycleResponse });
  const processedByExchange = {
    exchange_a: 1,
    exchange_b: 1,
    exchange_c: calls.get("exchange_c") ?? 0,
  };

  const pruneStore = new MemoryDiscoveryStore({
    max_records_per_origin: 32,
    tombstone_retention_seconds: 300,
  });
  const pruneCodec = new DiscoveryRecordCodec({
    local_exchange_id: "exchange_prune",
    signer,
    trust,
    clock,
  });
  for (let index = 0; index < 64; index += 1) {
    await pruneStore.apply({
      ...scope,
      source_peer_id: null,
      value: await signedRoute(
        pruneCodec,
        "exchange_prune",
        `expired_${index}`,
        "2026-08-01T00:00:01.000Z",
      ),
    });
  }
  const before = await pruneStore.status({ ...scope, now: timestamp });
  const pruneStarted = performance.now();
  await pruneStore.prune({ ...scope, now: "2026-08-01T00:10:00.000Z" });
  const pruneElapsed = performance.now() - pruneStarted;
  const after = await pruneStore.status({ ...scope, now: "2026-08-01T00:10:00.000Z" });
  const retainedBefore = before.live + before.expired + before.withdrawn;
  const retainedAfter = after.live + after.expired + after.withdrawn;

  return {
    environment: {
      node: process.version,
      platform: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model ?? "unknown",
      cpu_count: cpus().length,
    },
    configuration: options,
    heartbeat_churn: {
      local_heartbeats: 10_000,
      peer_updates: heartbeatPeerUpdates,
    },
    coalescing: {
      input_changes: 1_000,
      refresh_turns: refreshTurns,
      peer_updates: refreshTurns,
    },
    local_query: { samples: options.query_samples, ...latency(queryTimes) },
    direct_sync: {
      samples: options.sync_samples,
      ...latency(syncTimes),
      total_bytes: syncBytes,
    },
    cycle: {
      processed_by_exchange: processedByExchange,
      max_processes_per_exchange: Math.max(...Object.values(processedByExchange)),
    },
    pruning: {
      retained_before_prune: retainedBefore,
      retained_after_prune: retainedAfter,
      elapsed_ms: Number(pruneElapsed.toFixed(3)),
    },
  };
}

function argument(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : Number(process.argv[index + 1]);
}

const invoked = process.argv[1] === undefined
  ? null
  : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) {
  const report = await runDiscoveryBenchmark({
    query_samples: argument("query-samples", 200),
    sync_samples: argument("sync-samples", 20),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
