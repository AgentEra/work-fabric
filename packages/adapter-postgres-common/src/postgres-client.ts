import { Pool, type PoolClient, type QueryResultRow } from "pg";

export interface PostgresQueryResult<Row extends Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface PostgresClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>>;
  release(error?: Error): void;
}

export interface PostgresPool {
  connect(): Promise<PostgresClient>;
  end(): Promise<void>;
}

class PgClient implements PostgresClient {
  constructor(private readonly client: PoolClient) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>> {
    const result = await this.client.query<Row & QueryResultRow>(text, values as unknown[] | undefined);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }

  release(error?: Error): void {
    this.client.release(error);
  }
}

class PgPool implements PostgresPool {
  constructor(private readonly pool: Pool) {}

  async connect(): Promise<PostgresClient> {
    return new PgClient(await this.pool.connect());
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

export function createPgPool(connectionString: string): PostgresPool {
  if (typeof connectionString !== "string" || connectionString.trim().length === 0) {
    throw new TypeError("connectionString must be a non-empty string");
  }
  return new PgPool(new Pool({ connectionString }));
}
