import { isDeepStrictEqual } from "node:util";

import {
  ChannelRouteStoreError,
  assertChannelRoute,
  channelRouteManifest,
  type ChannelRoute,
  type ChannelRouteScope,
  type ChannelRouteStore,
  type ListChannelRoutes,
  type PutChannelRoute,
} from "@work-fabric/channel-spi";

const key = (scope: ChannelRouteScope) => `${scope.tenant_id}\0${scope.plugin_instance_id}\0${scope.handoff_id}`;

export class MemoryChannelRouteStore implements ChannelRouteStore {
  readonly manifest = channelRouteManifest("memory");
  private readonly routes = new Map<string, ChannelRoute>();

  async put(input: PutChannelRoute): Promise<void> {
    assertChannelRoute(input.route);
    const candidate = structuredClone(input.route);
    const current = this.routes.get(key(candidate));
    if (current === undefined) {
      if (input.expected_version !== 0 || candidate.version !== 1) throw new ChannelRouteStoreError("version_conflict");
      this.routes.set(key(candidate), candidate);
      return;
    }
    if (isDeepStrictEqual(current, candidate)) return;
    if (current.external_conversation_id !== candidate.external_conversation_id) throw new ChannelRouteStoreError("route_conflict");
    if (input.expected_version !== current.version || candidate.version !== current.version + 1 || Date.parse(candidate.updated_at) <= Date.parse(current.updated_at)) {
      throw new ChannelRouteStoreError("version_conflict");
    }
    this.routes.set(key(candidate), candidate);
  }

  async get(scope: ChannelRouteScope): Promise<ChannelRoute | null> {
    return structuredClone(this.routes.get(key(scope)) ?? null);
  }

  async list(query: ListChannelRoutes): Promise<readonly ChannelRoute[]> {
    if (!Number.isSafeInteger(query.limit) || query.limit <= 0 || query.limit > 1000) throw new RangeError("limit is invalid");
    return [...this.routes.values()]
      .filter((route) => route.tenant_id === query.tenant_id && route.plugin_instance_id === query.plugin_instance_id && (query.after_handoff_id === undefined || route.handoff_id > query.after_handoff_id))
      .sort((a, b) => a.handoff_id.localeCompare(b.handoff_id))
      .slice(0, query.limit)
      .map((route) => structuredClone(route));
  }
}
