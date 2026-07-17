import { describe, expect, it } from "vitest";
import type { PostgresClient, PostgresQueryResult, TenantSession } from "@work-fabric/adapter-postgres-common";
import { PostgresChannelRouteStore } from "../src/index.js";

class Client implements PostgresClient {
  calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  responses: Array<PostgresQueryResult<Record<string, unknown>>> = [];
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ text, ...(values === undefined ? {} : { values }) });
    return (this.responses.shift() ?? { rows: [], rowCount: 0 }) as PostgresQueryResult<Row>;
  }
  release(): void {}
}
class Session implements TenantSession {
  readonly tenant_id = "tenant_profile";
  constructor(readonly client: Client) {}
  withTransaction<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T> { return operation(this.client); }
}

describe("PostgresChannelRouteStore", () => {
  it("binds reads to tenant, plugin instance, and handoff", async () => {
    const client = new Client();
    client.responses.push({ rows: [{ payload: { tenant_id: "tenant_profile", plugin_instance_id: "channel_profile", handoff_id: "handoff_01", external_conversation_id: "oc_1", external_message_id: "om_1", version: 1, created_at: "2026-07-17T00:00:00.000Z", updated_at: "2026-07-17T00:00:00.000Z" } }], rowCount: 1 });
    const store = new PostgresChannelRouteStore(() => new Session(client), "tenant_profile");
    await expect(store.get({ tenant_id: "tenant_profile", plugin_instance_id: "channel_profile", handoff_id: "handoff_01" })).resolves.toMatchObject({ external_conversation_id: "oc_1" });
    expect(client.calls[0]?.values).toEqual(["tenant_profile", "channel_profile", "handoff_01"]);
    await expect(store.get({ tenant_id: "other", plugin_instance_id: "channel_profile", handoff_id: "handoff_01" })).rejects.toThrow("tenant context mismatch");
  });
});
