import { describe, expect, it } from "vitest";

import {
  createTenantSession,
  type PostgresClient,
  type PostgresPool,
} from "../src/index.js";

class FakeClient implements PostgresClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  readonly results: Array<{ rows: readonly Record<string, unknown>[]; rowCount: number }> = [];
  released: Error | undefined;
  releaseCalls = 0;
  errorOn: string | undefined;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: readonly Row[]; rowCount: number }> {
    this.calls.push(values === undefined ? { text } : { text, values });
    if (this.errorOn === text) throw new Error(`query failed: ${text}`);
    return (this.results.shift() ?? { rows: [], rowCount: 0 }) as {
      rows: readonly Row[];
      rowCount: number;
    };
  }

  release(error?: Error): void {
    this.releaseCalls += 1;
    this.released = error;
  }
}

class FakePool implements PostgresPool {
  readonly client: FakeClient;
  connects = 0;

  constructor(client = new FakeClient()) {
    this.client = client;
  }

  async connect(): Promise<PostgresClient> {
    this.connects += 1;
    return this.client;
  }

  async end(): Promise<void> {}
}

describe("tenant session", () => {
  it("sets a transaction-local tenant context and commits", async () => {
    const pool = new FakePool();
    const session = createTenantSession(pool, "tenant_01");
    const result = await session.withTransaction(async (client) => {
      await client.query("SELECT 42");
      return "done";
    });

    expect(result).toBe("done");
    expect(pool.client.calls).toEqual([
      { text: "BEGIN", values: undefined },
      {
        text: "SELECT set_config('app.tenant_id', $1, true)",
        values: ["tenant_01"],
      },
      { text: "SELECT 42", values: undefined },
      { text: "COMMIT", values: undefined },
    ]);
    expect(pool.client.releaseCalls).toBe(1);
    expect(pool.client.released).toBeUndefined();
  });

  it("rolls back and releases the original callback error", async () => {
    const pool = new FakePool();
    const session = createTenantSession(pool, "tenant_01");
    const failure = new Error("callback failed");

    await expect(
      session.withTransaction(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(pool.client.calls.map(({ text }) => text)).toEqual([
      "BEGIN",
      "SELECT set_config('app.tenant_id', $1, true)",
      "ROLLBACK",
    ]);
    expect(pool.client.released).toBe(failure);
  });

  it("rolls back when commit fails", async () => {
    const pool = new FakePool();
    pool.client.errorOn = "COMMIT";
    const session = createTenantSession(pool, "tenant_01");

    await expect(session.withTransaction(async () => undefined)).rejects.toThrow(
      "query failed: COMMIT",
    );
    expect(pool.client.calls.map(({ text }) => text)).toEqual([
      "BEGIN",
      "SELECT set_config('app.tenant_id', $1, true)",
      "COMMIT",
      "ROLLBACK",
    ]);
    expect(pool.client.released).toBeInstanceOf(Error);
  });

  it("rejects invalid tenants before acquiring a connection", async () => {
    const pool = new FakePool();
    expect(() => createTenantSession(pool, " ")).toThrow();
    expect(pool.connects).toBe(0);
  });
});
