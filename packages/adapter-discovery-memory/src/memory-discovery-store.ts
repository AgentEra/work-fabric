import { isDeepStrictEqual } from "node:util";

import type { CapabilityManifest } from "@work-fabric/exchange-spi";
import {
  DISCOVERY_REQUIRED_STORE_CAPABILITIES,
  isDiscoveryTombstone,
  type DiscoveryApplyResult,
  type DiscoveryChangePage,
  type DiscoveryPage,
  type DiscoveryRecord,
  type DiscoveryScope,
  type DiscoveryStore,
  type DiscoveryStoredValue,
  type DiscoveryStoreQuery,
  type DiscoveryStoreStatus,
} from "@work-fabric/discovery-spi";

const manifest: CapabilityManifest = {
  profile: "workfabric.discovery-store.v1",
  adapter: "memory",
  capabilities: Object.fromEntries(
    DISCOVERY_REQUIRED_STORE_CAPABILITIES.map((item) => [item, true]),
  ),
};

interface Entry {
  readonly value: DiscoveryStoredValue;
  readonly source_peer_id: string | null;
  readonly sequence: number;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function identity(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError(`${label} is invalid`);
  }
}

function scopeKey(scope: DiscoveryScope): string {
  identity(scope.tenant_id, "tenant_id");
  identity(scope.tenant_view_id, "tenant_view_id");
  return JSON.stringify([scope.tenant_id, scope.tenant_view_id]);
}

function recordKey(scope: DiscoveryScope, value: { readonly origin_exchange_id: string; readonly record_id: string }): string {
  return JSON.stringify([scope.tenant_id, scope.tenant_view_id, value.origin_exchange_id, value.record_id]);
}

function revision(value: DiscoveryStoredValue): number {
  return value.revision;
}

function cursorSignature(input: DiscoveryStoreQuery): unknown {
  const { cursor: _cursor, now: _now, limit: _limit, ...signature } = input;
  return signature;
}

function encodeCursor(input: DiscoveryStoreQuery, after: string): string {
  return Buffer.from(JSON.stringify({ signature: cursorSignature(input), after })).toString("base64url");
}

function decodeCursor(input: DiscoveryStoreQuery): string | null {
  if (input.cursor === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as {
      signature?: unknown;
      after?: unknown;
    };
    if (!isDeepStrictEqual(parsed.signature, cursorSignature(input)) || typeof parsed.after !== "string") {
      throw new Error("cursor mismatch");
    }
    return parsed.after;
  } catch {
    throw new TypeError("discovery_cursor_invalid");
  }
}

function changeCursor(scope: DiscoveryScope, peerId: string, sequence: number): string {
  return Buffer.from(JSON.stringify({ ...scope, peer_id: peerId, sequence })).toString("base64url");
}

function decodeChangeCursor(scope: DiscoveryScope, peerId: string, cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      value.tenant_id !== scope.tenant_id || value.tenant_view_id !== scope.tenant_view_id ||
      value.peer_id !== peerId || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0
    ) throw new Error("cursor mismatch");
    return value.sequence as number;
  } catch {
    throw new TypeError("discovery_cursor_invalid");
  }
}

function matchesVersion(version: string, constraint: string | undefined): boolean {
  if (constraint === undefined || constraint === "") return true;
  if (constraint.startsWith(">=")) return version.localeCompare(constraint.slice(2)) >= 0;
  if (constraint.startsWith("^")) return version.split(".")[0] === constraint.slice(1).split(".")[0];
  return version === constraint;
}

function live(entry: Entry, now: string): entry is Entry & { readonly value: DiscoveryRecord } {
  return !isDiscoveryTombstone(entry.value) && Date.parse(entry.value.expires_at) > Date.parse(now);
}

export interface MemoryDiscoveryStoreOptions {
  readonly max_records_per_origin: number;
  readonly tombstone_retention_seconds: number;
}

export class MemoryDiscoveryStore implements DiscoveryStore {
  readonly manifest = clone(manifest);
  private readonly entries = new Map<string, Entry>();
  private sequence = 0;
  private conflicts = 0;

  constructor(private readonly options: MemoryDiscoveryStoreOptions) {
    if (!Number.isSafeInteger(options.max_records_per_origin) || options.max_records_per_origin < 1) {
      throw new RangeError("max_records_per_origin must be positive");
    }
    if (!Number.isSafeInteger(options.tombstone_retention_seconds) || options.tombstone_retention_seconds < 1) {
      throw new RangeError("tombstone_retention_seconds must be positive");
    }
  }

  async apply(input: DiscoveryScope & {
    readonly source_peer_id: string | null;
    readonly value: DiscoveryStoredValue;
  }): Promise<DiscoveryApplyResult> {
    scopeKey(input);
    const key = recordKey(input, input.value);
    const current = this.entries.get(key);
    if (current !== undefined) {
      if (revision(input.value) < revision(current.value)) {
        return { outcome: "stale", sequence: current.sequence };
      }
      if (revision(input.value) === revision(current.value)) {
        if (!isDeepStrictEqual(input.value, current.value)) {
          this.conflicts += 1;
          throw new Error("discovery_record_conflict");
        }
        return { outcome: "duplicate", sequence: current.sequence };
      }
    }
    this.sequence += 1;
    this.entries.set(key, {
      value: clone(input.value),
      source_peer_id: input.source_peer_id,
      sequence: this.sequence,
    });
    this.enforceCapacity(input, input.value.origin_exchange_id);
    return { outcome: "applied", sequence: this.sequence };
  }

  async get(input: DiscoveryScope & {
    readonly origin_exchange_id: string;
    readonly record_id: string;
    readonly now: string;
  }): Promise<DiscoveryRecord | null> {
    scopeKey(input);
    const entry = this.entries.get(recordKey(input, input));
    return entry !== undefined && live(entry, input.now) ? clone(entry.value) : null;
  }

  async query(input: DiscoveryStoreQuery): Promise<DiscoveryPage> {
    scopeKey(input);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new RangeError("limit is invalid");
    const after = decodeCursor(input);
    const prefix = scopeKey(input);
    const records = [...this.entries.entries()]
      .filter(([key, entry]) => key.startsWith(prefix.slice(0, -1)) && live(entry, input.now))
      .map(([, entry]) => entry.value as DiscoveryRecord)
      .filter((record) => {
        if (input.record_kinds !== undefined && !input.record_kinds.includes(record.record_kind)) return false;
        if (input.record_id !== undefined && input.record_id !== record.record_id) return false;
        if (input.origin_exchange_id !== undefined && input.origin_exchange_id !== record.origin_exchange_id) return false;
        if (input.exchange_id !== undefined && (record.record_kind !== "exchange" || record.payload.exchange_id !== input.exchange_id)) return false;
        if (input.actor_id !== undefined && (record.record_kind !== "participant" || record.payload.actor.actor_id !== input.actor_id)) return false;
        if (input.endpoint_id !== undefined && (record.record_kind !== "endpoint" || record.payload.endpoint_id !== input.endpoint_id)) return false;
        const hasCapabilityFilter = input.capability_id !== undefined || input.version_constraint !== undefined ||
          input.input_media_types !== undefined || input.output_media_types !== undefined ||
          input.interaction_modes !== undefined || input.binding_types !== undefined;
        if (hasCapabilityFilter) {
          if (record.record_kind === "capability_route") {
            if (input.capability_id !== undefined && record.payload.capability_id !== input.capability_id) return false;
            if (!record.payload.versions.some((version) => matchesVersion(version, input.version_constraint))) return false;
            if (input.input_media_types?.some((item) => !record.payload.input_media_types.includes(item))) return false;
            if (input.output_media_types?.some((item) => !record.payload.output_media_types.includes(item))) return false;
            if (input.interaction_modes?.some((item) => !record.payload.interaction_modes.includes(item as never))) return false;
            if (input.binding_types?.some((item) => !record.payload.binding_types.includes(item))) return false;
          } else if (record.record_kind === "endpoint" && input.capability_id !== undefined) {
            if (!record.payload.capabilities.some((capability) => capability.capability_id === input.capability_id)) return false;
          } else return false;
        }
        return true;
      })
      .sort((left, right) => `${left.origin_exchange_id}\u0000${left.record_id}`.localeCompare(`${right.origin_exchange_id}\u0000${right.record_id}`));
    const afterIndex = after === null ? 0 : records.findIndex((record) => `${record.origin_exchange_id}\u0000${record.record_id}` === after) + 1;
    if (after !== null && afterIndex === 0) throw new TypeError("discovery_cursor_invalid");
    const page = records.slice(afterIndex, afterIndex + input.limit);
    const hasMore = afterIndex + page.length < records.length;
    return {
      coverage: "complete",
      items: clone(page),
      warnings: [],
      ...(hasMore ? { next_cursor: encodeCursor(input, `${page.at(-1)!.origin_exchange_id}\u0000${page.at(-1)!.record_id}`) } : {}),
    };
  }

  async changes(input: DiscoveryScope & {
    readonly peer_id: string;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<DiscoveryChangePage> {
    scopeKey(input);
    identity(input.peer_id, "peer_id");
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new RangeError("limit is invalid");
    const after = decodeChangeCursor(input, input.peer_id, input.cursor);
    const prefix = scopeKey(input);
    const changes = [...this.entries.entries()]
      .filter(([key, entry]) => key.startsWith(prefix.slice(0, -1)) && entry.sequence > after)
      .map(([, entry]) => entry)
      .sort((left, right) => left.sequence - right.sequence);
    const page = changes.slice(0, input.limit);
    const last = page.at(-1)?.sequence ?? after;
    return {
      items: clone(page.map((entry) => entry.value)),
      etag: `W/\"${this.sequence}\"`,
      ...(page.length > 0 ? { next_cursor: changeCursor(input, input.peer_id, last) } : {}),
    };
  }

  async prune(input: DiscoveryScope & { readonly now: string }): Promise<number> {
    scopeKey(input);
    const prefix = scopeKey(input);
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix.slice(0, -1))) continue;
      const expired = isDiscoveryTombstone(entry.value)
        ? Date.parse(entry.value.retain_until) <= Date.parse(input.now)
        : Date.parse(entry.value.expires_at) <= Date.parse(input.now);
      if (expired) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async status(input: DiscoveryScope & { readonly now: string }): Promise<DiscoveryStoreStatus> {
    scopeKey(input);
    const prefix = scopeKey(input);
    let liveCount = 0;
    let expired = 0;
    let withdrawn = 0;
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix.slice(0, -1))) continue;
      if (isDiscoveryTombstone(entry.value)) withdrawn += 1;
      else if (Date.parse(entry.value.expires_at) <= Date.parse(input.now)) expired += 1;
      else liveCount += 1;
    }
    return { live: liveCount, expired, withdrawn, conflicts: this.conflicts, capacity: this.options.max_records_per_origin };
  }

  private enforceCapacity(scope: DiscoveryScope, originExchangeId: string): void {
    const prefix = scopeKey(scope);
    const candidates = [...this.entries.entries()]
      .filter(([key, entry]) => key.startsWith(prefix.slice(0, -1)) && entry.value.origin_exchange_id === originExchangeId)
      .sort((left, right) => left[1].sequence - right[1].sequence);
    while (candidates.length > this.options.max_records_per_origin) {
      const oldest = candidates.shift();
      if (oldest !== undefined) this.entries.delete(oldest[0]);
    }
  }
}
