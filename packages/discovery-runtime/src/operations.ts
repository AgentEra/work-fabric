import type {
  DiscoveryClock,
  DiscoveryPeerBindingStore,
  DiscoveryScope,
  DiscoveryStore,
} from "@work-fabric/discovery-spi";

export interface DiscoveryOperationalCounterSnapshot {
  readonly coalesced_updates: number;
  readonly prevented_forwards: number;
  readonly sync_failures: number;
  readonly query_rejections: number;
}

export interface DiscoveryOperationalCounterSource {
  snapshot(): DiscoveryOperationalCounterSnapshot;
}

export interface DiscoveryOperationsSnapshot {
  readonly observed_at: string;
  readonly health: "healthy" | "unhealthy";
  readonly dependency_failures: number;
  readonly records: {
    readonly fresh: number;
    readonly expired: number;
    readonly withdrawn: number;
    readonly conflicts: number;
    readonly capacity: number;
    readonly utilization: number;
  };
  readonly peers: {
    readonly total: number;
    readonly active: number;
    readonly disabled: number;
    readonly samples: readonly {
      readonly state: "active" | "disabled";
      readonly import_enabled: boolean;
      readonly export_enabled: boolean;
      readonly query_enabled: boolean;
      readonly transit_enabled: boolean;
    }[];
    readonly samples_truncated: boolean;
  };
  readonly counters: DiscoveryOperationalCounterSnapshot;
}

export interface DiscoveryOperationsServiceOptions {
  readonly store: DiscoveryStore;
  readonly peers: DiscoveryPeerBindingStore;
  readonly clock: DiscoveryClock;
  readonly max_peer_samples: number;
  readonly counters?: DiscoveryOperationalCounterSource;
}

const zeroCounters: DiscoveryOperationalCounterSnapshot = {
  coalesced_updates: 0,
  prevented_forwards: 0,
  sync_failures: 0,
  query_rejections: 0,
};

function safeCount(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

export class DiscoveryOperationsService {
  constructor(private readonly options: DiscoveryOperationsServiceOptions) {
    if (!Number.isSafeInteger(options.max_peer_samples) || options.max_peer_samples < 1 || options.max_peer_samples > 1_000) {
      throw new RangeError("max_peer_samples is invalid");
    }
    if (!Number.isFinite(Date.parse(options.clock.now()))) throw new TypeError("clock is invalid");
  }

  async snapshot(scope: DiscoveryScope): Promise<DiscoveryOperationsSnapshot> {
    const now = this.options.clock.now();
    let dependencyFailures = 0;
    const status = await this.options.store.status({ ...scope, now }).catch(() => {
      dependencyFailures += 1;
      return { live: 0, expired: 0, withdrawn: 0, conflicts: 0, capacity: 0 };
    });
    const peerBindings = await this.options.peers.list(scope).catch(() => {
      dependencyFailures += 1;
      return [];
    });
    let counters = zeroCounters;
    try {
      const value = this.options.counters?.snapshot() ?? zeroCounters;
      counters = {
        coalesced_updates: safeCount(value.coalesced_updates),
        prevented_forwards: safeCount(value.prevented_forwards),
        sync_failures: safeCount(value.sync_failures),
        query_rejections: safeCount(value.query_rejections),
      };
    } catch { dependencyFailures += 1; }
    const samples = peerBindings.slice(0, this.options.max_peer_samples).map((peer) => ({
      state: peer.state,
      import_enabled: peer.allow_import,
      export_enabled: peer.allow_export,
      query_enabled: peer.allow_query,
      transit_enabled: peer.allow_transit,
    }));
    const fresh = safeCount(status.live);
    const capacity = safeCount(status.capacity);
    return Object.freeze({
      observed_at: now,
      health: dependencyFailures === 0 ? "healthy" : "unhealthy",
      dependency_failures: dependencyFailures,
      records: Object.freeze({
        fresh,
        expired: safeCount(status.expired),
        withdrawn: safeCount(status.withdrawn),
        conflicts: safeCount(status.conflicts),
        capacity,
        utilization: capacity === 0 ? 0 : Math.min(1, fresh / capacity),
      }),
      peers: Object.freeze({
        total: peerBindings.length,
        active: peerBindings.filter((peer) => peer.state === "active").length,
        disabled: peerBindings.filter((peer) => peer.state === "disabled").length,
        samples: Object.freeze(samples.map((sample) => Object.freeze(sample))),
        samples_truncated: peerBindings.length > samples.length,
      }),
      counters: Object.freeze(counters),
    });
  }
}
