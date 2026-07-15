import { describe, expect, it } from "vitest";
import type { PostgresClient, PostgresQueryResult, TenantSession } from "@work-fabric/adapter-postgres-common";
import { PostgresContextRepository } from "../src/index.js";

class FakeClient implements PostgresClient {
  readonly calls: string[] = [];
  responses: Array<PostgresQueryResult<Record<string, unknown>>> = [];
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string): Promise<PostgresQueryResult<Row>> { this.calls.push(text); return (this.responses.shift() ?? { rows: [], rowCount: 0 }) as PostgresQueryResult<Row>; }
  release(): void {}
}
class Session implements TenantSession { readonly tenant_id = "tenant_01"; constructor(readonly client: FakeClient) {} withTransaction<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T> { return operation(this.client); } }
const bundle = { context_id: "context_01", version: 1, digest: { algorithm: "sha-256", value: "abc" }, visibility_scope: { actor_ids: ["actor_01"], endpoint_ids: ["endpoint_01"], expires_at: null }, extensions: { state: "draft" } } as const;

describe("PostgresContextRepository", () => {
  it("writes immutable bundles and returns canonical references", async () => {
    const client = new FakeClient(); client.responses = [{ rows: [], rowCount: 0 }, { rows: [], rowCount: 1 }];
    const repository = new PostgresContextRepository(() => new Session(client));
    const input = structuredClone(bundle);
    await expect(repository.putBundle("tenant_01", input)).resolves.toEqual({ context_id: "context_01", version: 1, digest: "sha-256:abc" });
    (input.extensions as { state: string }).state = "mutated";
    expect(client.calls.some((query) => query.includes("INSERT INTO work_fabric_context_bundles"))).toBe(true);
    client.responses = [{ rows: [{ bundle, digest: "sha-256:abc" }], rowCount: 1 }];
    await expect(repository.putBundle("tenant_01", bundle)).resolves.toEqual({ context_id: "context_01", version: 1, digest: "sha-256:abc" });
    client.responses = [{ rows: [{ bundle: { ...bundle, extensions: { state: "changed" } }, digest: "sha-256:abc" }], rowCount: 1 }];
    await expect(repository.putBundle("tenant_01", bundle)).rejects.toThrow("immutable");
  });

  it("checks digest, audience and tenant-scoped availability", async () => {
    const client = new FakeClient(); const repository = new PostgresContextRepository(() => new Session(client));
    await expect(repository.checkAvailability({ tenant_id: "tenant_01", actor_id: "actor_01", endpoint_id: "endpoint_01", reference: null })).resolves.toEqual({ kind: "available" });
    client.responses = [{ rows: [{ digest: "sha-256:abc", actor_ids: ["actor_01"], endpoint_ids: ["endpoint_01"] }], rowCount: 1 }];
    await expect(repository.checkAvailability({ tenant_id: "tenant_01", actor_id: "actor_01", endpoint_id: "endpoint_01", reference: { context_id: "context_01", version: 1, digest: "sha-256:abc" } })).resolves.toEqual({ kind: "available" });
    client.responses = [{ rows: [{ digest: "sha-256:abc", actor_ids: ["actor_01"], endpoint_ids: ["endpoint_01"] }], rowCount: 1 }];
    await expect(repository.checkAvailability({ tenant_id: "tenant_01", actor_id: "other", endpoint_id: "endpoint_01", reference: { context_id: "context_01", version: 1, digest: "sha-256:abc" } })).resolves.toMatchObject({ kind: "unavailable" });
    client.responses = [{ rows: [{ digest: "sha-256:abc", actor_ids: ["actor_01"], endpoint_ids: ["endpoint_01"] }], rowCount: 1 }];
    await expect(repository.checkAvailability({ tenant_id: "tenant_01", actor_id: "actor_01", endpoint_id: "endpoint_01", reference: { context_id: "context_01", version: 1, digest: "sha-384:wrong" } })).resolves.toMatchObject({ kind: "unavailable" });
  });
});
