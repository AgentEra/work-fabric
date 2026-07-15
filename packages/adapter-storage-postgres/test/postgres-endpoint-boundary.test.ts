import { afterEach, describe, expect, it } from "vitest";

import {
  createPgPool,
  createTenantSession,
  runMigrations,
  TENANT_CONTEXT_MIGRATION,
  type PostgresClient,
  type PostgresPool,
  type PostgresQueryResult,
  type TenantSession,
} from "@work-fabric/adapter-postgres-common";
import {
  verifyEndpointDirectoryProfile,
  verifyEndpointInboxProfile,
} from "@work-fabric/exchange-conformance";
import {
  ENDPOINT_DIRECTORY_REQUIRED_CAPABILITIES,
  ENDPOINT_INBOX_REQUIRED_CAPABILITIES,
  assertCapabilities,
} from "@work-fabric/exchange-spi";

import {
  ENDPOINT_BOUNDARY_MIGRATION,
  PostgresEndpointDirectoryStore,
  PostgresEndpointInboxStore,
} from "../src/index.js";

class FakeClient implements PostgresClient {
  readonly calls: string[] = [];

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    _values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push(text);
    return { rows: [], rowCount: 0 };
  }

  release(): void {}
}

class FakeSession implements TenantSession {
  readonly tenant_id = "tenant_01";
  readonly client = new FakeClient();

  withTransaction<T>(
    operation: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    return operation(this.client);
  }
}

const connectionString = process.env.PG_TEST_URL;
const live = connectionString !== undefined && connectionString.trim().length > 0;
let pool: PostgresPool | undefined;

afterEach(async () => {
  await pool?.end();
  pool = undefined;
});

describe("PostgreSQL Endpoint boundary", () => {
  it("advertises the same technology-neutral profiles as Memory", () => {
    const session = new FakeSession();
    const directory = new PostgresEndpointDirectoryStore(
      () => session,
      "tenant_01",
    );
    const inbox = new PostgresEndpointInboxStore(
      () => session,
      "tenant_01",
    );

    assertCapabilities(
      directory.manifest,
      ENDPOINT_DIRECTORY_REQUIRED_CAPABILITIES,
    );
    assertCapabilities(inbox.manifest, ENDPOINT_INBOX_REQUIRED_CAPABILITIES);
    expect(ENDPOINT_BOUNDARY_MIGRATION.id).toBe("004_endpoint_boundary");
    expect(ENDPOINT_BOUNDARY_MIGRATION.sql).toContain(
      "work_fabric_endpoint_active_sessions",
    );
    expect(ENDPOINT_BOUNDARY_MIGRATION.sql).toContain(
      "work_fabric_endpoint_inbox_facts",
    );
    expect(ENDPOINT_BOUNDARY_MIGRATION.sql).toContain(
      "FORCE ROW LEVEL SECURITY",
    );
    expect(ENDPOINT_BOUNDARY_MIGRATION.sql).toContain(
      "work_fabric_semver_satisfies",
    );
  });

  it.skipIf(!live)("satisfies Directory and inbox profiles with RLS", async () => {
    if (connectionString === undefined) return;
    pool = createPgPool(connectionString);
    const schema = `wf_endpoint_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const setup = await pool.connect();
    await setup.query(`CREATE SCHEMA "${schema}"`);
    await setup.query(`SET search_path TO "${schema}"`);
    await runMigrations(setup, [
      TENANT_CONTEXT_MIGRATION,
      ENDPOINT_BOUNDARY_MIGRATION,
    ]);
    setup.release();

    const sessionFactory = (tenantId: string): TenantSession => {
      const base = createTenantSession(pool as PostgresPool, tenantId);
      return {
        tenant_id: tenantId,
        withTransaction: (operation) =>
          base.withTransaction(async (client) => {
            await client.query(`SET LOCAL search_path TO "${schema}"`);
            return operation(client);
          }),
      };
    };

    try {
      await verifyEndpointDirectoryProfile(
        () => new PostgresEndpointDirectoryStore(
          sessionFactory,
          "tenant_profile_01",
        ),
      );
      await verifyEndpointInboxProfile(
        () => new PostgresEndpointInboxStore(
          sessionFactory,
          "tenant_profile_01",
        ),
      );
      const other = new PostgresEndpointDirectoryStore(
        sessionFactory,
        "tenant_other",
      );
      await expect(
        other.getRegistration("tenant_other", "endpoint_profile_01"),
      ).resolves.toBeNull();
    } finally {
      const cleanup = await pool.connect();
      await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
      cleanup.release();
    }
  });
});
