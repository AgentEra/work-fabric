import { isDeepStrictEqual } from "node:util";
import { ChannelRouteStoreError, assertChannelRoute, channelRouteManifest, type ChannelRoute, type ChannelRouteScope, type ChannelRouteStore, type ListChannelRoutes, type PutChannelRoute } from "@work-fabric/channel-spi";
import type { SqliteSession } from "./sqlite-session.js";

export class SqliteChannelRouteStore implements ChannelRouteStore {
  readonly manifest = channelRouteManifest("sqlite");
  constructor(private readonly session: SqliteSession) {}

  async put(input: PutChannelRoute): Promise<void> {
    assertChannelRoute(input.route);
    const route = structuredClone(input.route);
    this.session.transaction(() => {
      const row = this.session.prepare("SELECT payload FROM work_fabric_channel_routes WHERE tenant_id=? AND plugin_instance_id=? AND handoff_id=?").get(route.tenant_id, route.plugin_instance_id, route.handoff_id) as { payload: string } | undefined;
      if (row === undefined) {
        if (input.expected_version !== 0 || route.version !== 1) throw new ChannelRouteStoreError("version_conflict");
        this.session.prepare("INSERT INTO work_fabric_channel_routes (tenant_id,plugin_instance_id,handoff_id,payload) VALUES (?,?,?,?)").run(route.tenant_id, route.plugin_instance_id, route.handoff_id, JSON.stringify(route));
        return;
      }
      const current = JSON.parse(row.payload) as ChannelRoute;
      assertChannelRoute(current);
      if (isDeepStrictEqual(current, route)) return;
      if (current.external_conversation_id !== route.external_conversation_id) throw new ChannelRouteStoreError("route_conflict");
      if (input.expected_version !== current.version || route.version !== current.version + 1 || Date.parse(route.updated_at) <= Date.parse(current.updated_at)) throw new ChannelRouteStoreError("version_conflict");
      const result = this.session.prepare("UPDATE work_fabric_channel_routes SET payload=? WHERE tenant_id=? AND plugin_instance_id=? AND handoff_id=? AND json_extract(payload,'$.version')=?").run(JSON.stringify(route), route.tenant_id, route.plugin_instance_id, route.handoff_id, input.expected_version);
      if (result.changes !== 1) throw new ChannelRouteStoreError("version_conflict");
    });
  }
  async get(scope: ChannelRouteScope): Promise<ChannelRoute | null> {
    const row = this.session.prepare("SELECT payload FROM work_fabric_channel_routes WHERE tenant_id=? AND plugin_instance_id=? AND handoff_id=?").get(scope.tenant_id, scope.plugin_instance_id, scope.handoff_id) as { payload: string } | undefined;
    if (row === undefined) return null;
    const route = JSON.parse(row.payload) as ChannelRoute; assertChannelRoute(route); return structuredClone(route);
  }
  async list(query: ListChannelRoutes): Promise<readonly ChannelRoute[]> {
    if (!Number.isSafeInteger(query.limit) || query.limit <= 0 || query.limit > 1000) throw new RangeError("limit is invalid");
    const rows = this.session.prepare("SELECT payload FROM work_fabric_channel_routes WHERE tenant_id=? AND plugin_instance_id=? AND handoff_id>? ORDER BY handoff_id LIMIT ?").all(query.tenant_id, query.plugin_instance_id, query.after_handoff_id ?? "", query.limit) as unknown as Array<{ payload: string }>;
    return rows.map((row) => { const route = JSON.parse(row.payload) as ChannelRoute; assertChannelRoute(route); return structuredClone(route); });
  }
}
