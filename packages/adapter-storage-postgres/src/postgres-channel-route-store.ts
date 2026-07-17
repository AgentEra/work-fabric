import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { PostgresClient, TenantSession } from "@work-fabric/adapter-postgres-common";
import { ChannelRouteStoreError, assertChannelRoute, channelRouteManifest, type ChannelRoute, type ChannelRouteScope, type ChannelRouteStore, type ListChannelRoutes, type PutChannelRoute } from "@work-fabric/channel-spi";

export const CHANNEL_ROUTES_MIGRATION = { id: "009_channel_routes", sql: readFileSync(new URL("../migrations/009_channel_routes.sql", import.meta.url), "utf8") } as const;
type SessionFactory = () => TenantSession | Promise<TenantSession>;

export class PostgresChannelRouteStore implements ChannelRouteStore {
  readonly manifest = channelRouteManifest("postgres");
  constructor(private readonly sessions: SessionFactory, private readonly tenantId: string) {}
  private bind(tenant: string): void { if (tenant !== this.tenantId) throw new Error("tenant context mismatch"); }
  private async run<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T> { const session = await this.sessions(); return session.withTransaction(operation); }
  async put(input: PutChannelRoute): Promise<void> {
    assertChannelRoute(input.route); this.bind(input.route.tenant_id); const route = structuredClone(input.route);
    await this.run(async (client) => {
      const existing = await client.query<{ payload: unknown }>("SELECT payload FROM work_fabric_channel_routes WHERE tenant_id=$1 AND plugin_instance_id=$2 AND handoff_id=$3 FOR UPDATE", [route.tenant_id, route.plugin_instance_id, route.handoff_id]);
      const row = existing.rows[0];
      if (row === undefined) {
        if (input.expected_version !== 0 || route.version !== 1) throw new ChannelRouteStoreError("version_conflict");
        await client.query("INSERT INTO work_fabric_channel_routes (tenant_id,plugin_instance_id,handoff_id,payload) VALUES ($1,$2,$3,$4::jsonb)", [route.tenant_id, route.plugin_instance_id, route.handoff_id, JSON.stringify(route)]); return;
      }
      const current = (typeof row.payload === "string" ? JSON.parse(row.payload) : structuredClone(row.payload)) as ChannelRoute; assertChannelRoute(current);
      if (isDeepStrictEqual(current, route)) return;
      if (current.external_conversation_id !== route.external_conversation_id) throw new ChannelRouteStoreError("route_conflict");
      if (input.expected_version !== current.version || route.version !== current.version + 1 || Date.parse(route.updated_at) <= Date.parse(current.updated_at)) throw new ChannelRouteStoreError("version_conflict");
      const updated = await client.query("UPDATE work_fabric_channel_routes SET payload=$1::jsonb WHERE tenant_id=$2 AND plugin_instance_id=$3 AND handoff_id=$4 AND (payload->>'version')::bigint=$5", [JSON.stringify(route), route.tenant_id, route.plugin_instance_id, route.handoff_id, input.expected_version]);
      if (updated.rowCount !== 1) throw new ChannelRouteStoreError("version_conflict");
    });
  }
  async get(scope: ChannelRouteScope): Promise<ChannelRoute | null> { this.bind(scope.tenant_id); return this.run(async (client) => { const result = await client.query<{ payload: unknown }>("SELECT payload FROM work_fabric_channel_routes WHERE tenant_id=$1 AND plugin_instance_id=$2 AND handoff_id=$3", [scope.tenant_id, scope.plugin_instance_id, scope.handoff_id]); const payload = result.rows[0]?.payload; if (payload === undefined) return null; const route = (typeof payload === "string" ? JSON.parse(payload) : structuredClone(payload)) as ChannelRoute; assertChannelRoute(route); return route; }); }
  async list(query: ListChannelRoutes): Promise<readonly ChannelRoute[]> { this.bind(query.tenant_id); if (!Number.isSafeInteger(query.limit) || query.limit <= 0 || query.limit > 1000) throw new RangeError("limit is invalid"); return this.run(async (client) => { const result = await client.query<{ payload: unknown }>("SELECT payload FROM work_fabric_channel_routes WHERE tenant_id=$1 AND plugin_instance_id=$2 AND handoff_id>$3 ORDER BY handoff_id LIMIT $4", [query.tenant_id, query.plugin_instance_id, query.after_handoff_id ?? "", query.limit]); return result.rows.map((row) => { const route = (typeof row.payload === "string" ? JSON.parse(row.payload) : structuredClone(row.payload)) as ChannelRoute; assertChannelRoute(route); return route; }); }); }
}
