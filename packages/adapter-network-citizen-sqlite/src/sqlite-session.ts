import { DatabaseSync, type StatementSync } from "node:sqlite";

export type SqliteNetworkCitizenStoreOptions =
  | {
      readonly location: string;
      readonly database?: never;
      readonly busy_timeout_ms?: number;
    }
  | {
      readonly database: DatabaseSync;
      readonly location?: never;
      readonly busy_timeout_ms?: number;
    };

function timeout(value: number | undefined): number {
  const result = value ?? 5_000;
  if (!Number.isSafeInteger(result) || result < 0 || result > 60_000) {
    throw new RangeError("busy_timeout_ms must be between 0 and 60000");
  }
  return result;
}

export class NetworkCitizenSqliteSession {
  readonly database: DatabaseSync;
  private readonly ownsDatabase: boolean;

  constructor(options: SqliteNetworkCitizenStoreOptions) {
    const busyTimeout = timeout(options.busy_timeout_ms);
    if ("database" in options && options.database !== undefined) {
      this.database = options.database;
      this.ownsDatabase = false;
    } else {
      if (typeof options.location !== "string" || options.location.length === 0) {
        throw new TypeError("SQLite location must be non-empty");
      }
      this.database = new DatabaseSync(options.location, {
        enableForeignKeyConstraints: true,
        timeout: busyTimeout,
      });
      this.ownsDatabase = true;
      if (options.location !== ":memory:") {
        this.database.exec("PRAGMA journal_mode = WAL");
      }
    }
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
  }

  prepare(sql: string): StatementSync {
    return this.database.prepare(sql);
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }

  close(): void {
    if (this.ownsDatabase && this.database.isOpen) this.database.close();
  }
}
