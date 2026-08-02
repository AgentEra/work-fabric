import { isDeepStrictEqual } from "node:util";

import type { CapabilityManifest } from "@work-fabric/exchange-spi";
import type {
  DiscoveryPeerBinding,
  DiscoveryPeerBindingStore,
  DiscoveryScope,
} from "@work-fabric/discovery-spi";

const manifest: CapabilityManifest = {
  profile: "workfabric.discovery-peer-store.v1",
  adapter: "memory",
  capabilities: {
    tenant_view_isolation: true,
    optimistic_peer_binding: true,
    deterministic_listing: true,
  },
};

function clone<T>(value: T): T { return structuredClone(value); }
function key(scope: DiscoveryScope, peerId: string): string {
  return JSON.stringify([scope.tenant_id, scope.tenant_view_id, peerId]);
}

export class MemoryDiscoveryPeerBindingStore implements DiscoveryPeerBindingStore {
  readonly manifest = clone(manifest);
  private readonly bindings = new Map<string, DiscoveryPeerBinding>();

  async put(input: {
    readonly binding: DiscoveryPeerBinding;
    readonly expected_version: number | null;
  }): Promise<DiscoveryPeerBinding> {
    const candidate = clone(input.binding);
    const current = this.bindings.get(key(candidate, candidate.peer_id));
    if (current === undefined) {
      if (input.expected_version !== null || candidate.version !== 1) throw new Error("discovery_peer_version_conflict");
    } else {
      if (input.expected_version !== current.version || candidate.version !== current.version + 1) throw new Error("discovery_peer_version_conflict");
      if (current.exchange_id !== candidate.exchange_id) throw new Error("discovery_peer_immutable_binding");
    }
    if (current !== undefined && isDeepStrictEqual(current, candidate)) return clone(current);
    this.bindings.set(key(candidate, candidate.peer_id), candidate);
    return clone(candidate);
  }

  async get(scope: DiscoveryScope, peerId: string): Promise<DiscoveryPeerBinding | null> {
    const value = this.bindings.get(key(scope, peerId));
    return value === undefined ? null : clone(value);
  }

  async list(scope: DiscoveryScope): Promise<readonly DiscoveryPeerBinding[]> {
    const prefix = JSON.stringify([scope.tenant_id, scope.tenant_view_id]).slice(0, -1);
    return [...this.bindings.entries()]
      .filter(([stored]) => stored.startsWith(prefix))
      .map(([, value]) => clone(value))
      .sort((left, right) => left.peer_id.localeCompare(right.peer_id));
  }
}
