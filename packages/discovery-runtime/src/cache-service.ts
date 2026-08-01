import {
  DISCOVERY_PROFILE,
  type DiscoveryApplyResult,
  type DiscoveryClock,
  type DiscoveryPeerBindingStore,
  type DiscoveryStore,
  type DiscoveryTombstone,
} from "@work-fabric/discovery-spi";

import { DiscoveryError } from "./errors.js";
import type { DiscoveryRecordCodec } from "./record-codec.js";

function identity(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new DiscoveryError("discovery_record_invalid");
  }
}

function timestamp(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result) || !value.endsWith("Z") || new Date(result).toISOString() !== value) {
    throw new DiscoveryError("discovery_record_invalid");
  }
  return result;
}

export interface DiscoveryCacheServiceOptions {
  readonly local_exchange_id: string;
  readonly codec: DiscoveryRecordCodec;
  readonly store: DiscoveryStore;
  readonly peers: DiscoveryPeerBindingStore;
  readonly clock: DiscoveryClock;
}

export class DiscoveryCacheService {
  constructor(private readonly options: DiscoveryCacheServiceOptions) {
    identity(options.local_exchange_id);
    timestamp(options.clock.now());
  }

  async accept(input: {
    readonly tenant_id: string;
    readonly tenant_view_id: string;
    readonly source_peer_id: string;
    readonly audience_exchange_id: string;
    readonly bytes: Uint8Array;
  }): Promise<DiscoveryApplyResult> {
    if (input.audience_exchange_id !== this.options.local_exchange_id) {
      throw new DiscoveryError("discovery_wrong_audience");
    }
    const record = await this.options.codec.verify(input.bytes, {
      audience: input.audience_exchange_id,
    });
    const scope = {
      tenant_id: input.tenant_id,
      tenant_view_id: input.tenant_view_id,
    };
    const peer = await this.options.peers.get(scope, input.source_peer_id);
    if (peer === null || peer.state !== "active" || !peer.allow_import) {
      throw new DiscoveryError("discovery_wrong_audience");
    }
    const direct = peer.exchange_id === record.origin_exchange_id;
    if (!direct && !(peer.allow_transit && record.transitive && record.max_hops > 0)) {
      throw new DiscoveryError("discovery_wrong_audience");
    }
    return this.options.store.apply({
      ...scope,
      source_peer_id: input.source_peer_id,
      value: record,
    });
  }

  async withdrawLocal(input: {
    readonly tenant_id: string;
    readonly tenant_view_id: string;
    readonly tombstone: DiscoveryTombstone;
  }): Promise<DiscoveryApplyResult> {
    const value = input.tombstone;
    if (
      value.profile !== DISCOVERY_PROFILE || value.revision < 1 ||
      timestamp(value.retain_until) <= timestamp(value.withdrawn_at) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(value.key_id) ||
      !/^[A-Za-z0-9_-]{86}$/.test(value.signature)
    ) {
      throw new DiscoveryError("discovery_record_invalid");
    }
    identity(value.origin_exchange_id);
    identity(value.record_id);
    return this.options.store.apply({
      tenant_id: input.tenant_id,
      tenant_view_id: input.tenant_view_id,
      source_peer_id: null,
      value: structuredClone(value),
    });
  }

  prune(tenantId: string, tenantViewId: string): Promise<number> {
    return this.options.store.prune({
      tenant_id: tenantId,
      tenant_view_id: tenantViewId,
      now: this.options.clock.now(),
    });
  }
}
