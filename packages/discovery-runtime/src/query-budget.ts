import type {
  DiscoveryClock,
  DiscoveryQueryBudget,
} from "@work-fabric/discovery-spi";
import type { JsonValue } from "@work-fabric/exchange-spi";

import { DiscoveryError } from "./errors.js";
import { discoveryCanonicalSha256 } from "./canonical-json.js";

function timestamp(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result) || !value.endsWith("Z") || new Date(result).toISOString() !== value) {
    throw new DiscoveryError("discovery_record_invalid");
  }
  return result;
}

function natural(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} is invalid`);
}

export function consumeQueryBudget(
  budget: DiscoveryQueryBudget,
  cost: {
    readonly now: string;
    readonly hops: number;
    readonly fanout: number;
    readonly results: number;
    readonly bytes: number;
  },
): DiscoveryQueryBudget {
  for (const [label, value] of [
    ["remaining_hops", budget.remaining_hops],
    ["remaining_fanout", budget.remaining_fanout],
    ["remaining_results", budget.remaining_results],
    ["remaining_bytes", budget.remaining_bytes],
    ["hops", cost.hops],
    ["fanout", cost.fanout],
    ["results", cost.results],
    ["bytes", cost.bytes],
  ] as const) natural(value, label);
  if (timestamp(cost.now) >= timestamp(budget.deadline) ||
      cost.hops > budget.remaining_hops || cost.fanout > budget.remaining_fanout ||
      cost.results > budget.remaining_results || cost.bytes > budget.remaining_bytes) {
    throw new DiscoveryError("discovery_budget_exhausted");
  }
  return {
    deadline: budget.deadline,
    remaining_hops: budget.remaining_hops - cost.hops,
    remaining_fanout: budget.remaining_fanout - cost.fanout,
    remaining_results: budget.remaining_results - cost.results,
    remaining_bytes: budget.remaining_bytes - cost.bytes,
  };
}

export interface DiscoveryQueryDeduplicatorOptions {
  readonly clock: DiscoveryClock;
  readonly max_entries: number;
  readonly max_in_flight: number;
  readonly max_cache_seconds: number;
}

interface Cached<T> {
  readonly value: T;
  readonly expires_at: number;
}

export class DiscoveryQueryDeduplicator<T> {
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly cache = new Map<string, Cached<T>>();

  constructor(private readonly options: DiscoveryQueryDeduplicatorOptions) {
    for (const [label, value, maximum] of [
      ["max_entries", options.max_entries, 100_000],
      ["max_in_flight", options.max_in_flight, 10_000],
      ["max_cache_seconds", options.max_cache_seconds, 60],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(`${label} is invalid`);
    }
    timestamp(options.clock.now());
  }

  async execute(key: string, expiresAt: string, work: () => Promise<T>): Promise<T> {
    if (key.length < 1 || key.length > 1024) throw new TypeError("deduplication key is invalid");
    const now = timestamp(this.options.clock.now());
    const requestExpiry = timestamp(expiresAt);
    this.prune(now);
    if (now >= requestExpiry) throw new DiscoveryError("discovery_budget_exhausted");
    const cached = this.cache.get(key);
    if (cached !== undefined) return structuredClone(cached.value);
    const active = this.inFlight.get(key);
    if (active !== undefined) return active;
    if (this.inFlight.size >= this.options.max_in_flight) throw new DiscoveryError("discovery_rate_limited");
    const promise = work().then((value) => {
      const completedAt = timestamp(this.options.clock.now());
      const cacheExpiry = Math.min(requestExpiry, completedAt + this.options.max_cache_seconds * 1_000);
      this.cache.set(key, { value: structuredClone(value), expires_at: cacheExpiry });
      while (this.cache.size > this.options.max_entries) {
        const oldest = this.cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
      return value;
    }).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.expires_at <= now) this.cache.delete(key);
    }
  }
}

export function discoveryBackoffDelay(input: {
  readonly attempt: number;
  readonly min_ms: number;
  readonly max_ms: number;
  readonly random: number;
}): number {
  natural(input.attempt, "attempt");
  if (!Number.isSafeInteger(input.min_ms) || input.min_ms < 1 ||
      !Number.isSafeInteger(input.max_ms) || input.max_ms < input.min_ms ||
      !Number.isFinite(input.random) || input.random < 0 || input.random > 1) {
    throw new RangeError("backoff input is invalid");
  }
  const exponential = Math.min(input.max_ms, input.min_ms * 2 ** Math.min(input.attempt, 30));
  return Math.min(input.max_ms, Math.round(exponential * (0.5 + input.random)));
}

export function discoveryQueryFingerprint(query: JsonValue): string {
  return discoveryCanonicalSha256(query);
}

export interface DiscoveryNegativeQueryCacheOptions {
  readonly clock: DiscoveryClock;
  readonly max_entries: number;
  readonly ttl_seconds: number;
}

export class DiscoveryNegativeQueryCache {
  private readonly entries = new Map<string, number>();

  constructor(private readonly options: DiscoveryNegativeQueryCacheOptions) {
    if (!Number.isSafeInteger(options.max_entries) || options.max_entries < 1 || options.max_entries > 100_000 ||
        !Number.isSafeInteger(options.ttl_seconds) || options.ttl_seconds < 1 || options.ttl_seconds > 60) {
      throw new RangeError("negative cache options are invalid");
    }
    timestamp(options.clock.now());
  }

  has(fingerprint: string): boolean {
    const now = timestamp(this.options.clock.now());
    this.prune(now);
    return (this.entries.get(fingerprint) ?? 0) > now;
  }

  put(fingerprint: string, sourceExpiresAt: string): void {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new TypeError("query fingerprint is invalid");
    const now = timestamp(this.options.clock.now());
    const expiresAt = Math.min(timestamp(sourceExpiresAt), now + this.options.ttl_seconds * 1_000);
    if (expiresAt <= now) return;
    this.entries.delete(fingerprint);
    this.entries.set(fingerprint, expiresAt);
    while (this.entries.size > this.options.max_entries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private prune(now: number): void {
    for (const [fingerprint, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(fingerprint);
    }
  }
}
