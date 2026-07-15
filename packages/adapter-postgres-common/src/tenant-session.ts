import {
  type PostgresClient,
  type PostgresPool,
} from "./postgres-client.js";

export interface TenantSession {
  readonly tenant_id: string;
  withTransaction<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T>;
}

function validateTenantId(tenantId: string): void {
  if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
    throw new TypeError("tenantId must be a non-empty string");
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function createTenantSession(pool: PostgresPool, tenantId: string): TenantSession {
  validateTenantId(tenantId);

  return {
    tenant_id: tenantId,
    async withTransaction<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        const result = await operation(client);
        await client.query("COMMIT");
        client.release();
        return result;
      } catch (error: unknown) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original transaction or callback error.
        }
        client.release(asError(error));
        throw error;
      }
    },
  };
}
