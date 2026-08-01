import { DatabaseSync, type StatementSync } from "node:sqlite";

export interface SqliteSessionOptions {
  readonly location: string;
  readonly busy_timeout_ms?: number;
  readonly database?: never;
}

export interface CallerOwnedSqliteSessionOptions {
  readonly database: DatabaseSync;
  readonly location?: never;
  readonly busy_timeout_ms?: number;
}

function busyTimeout(value: number | undefined): number {
  const normalized = value ?? 5_000;
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > 60_000) {
    throw new RangeError("busy_timeout_ms must be between 0 and 60000");
  }
  return normalized;
}

export class SqliteSession {
  readonly database: DatabaseSync;
  private readonly ownsDatabase: boolean;
  private readonly fileBacked: boolean;

  constructor(options: SqliteSessionOptions | CallerOwnedSqliteSessionOptions) {
    const timeout = busyTimeout(options.busy_timeout_ms);
    if ("database" in options && options.database !== undefined) {
      this.database = options.database;
      this.ownsDatabase = false;
      this.fileBacked = false;
    } else {
      if (typeof options.location !== "string" || options.location.length === 0) throw new TypeError("SQLite location must be non-empty");
      this.database = new DatabaseSync(options.location, { enableForeignKeyConstraints: true, timeout });
      this.ownsDatabase = true;
      this.fileBacked = options.location !== ":memory:";
    }
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec(`PRAGMA busy_timeout = ${timeout}`);
    if (this.fileBacked) this.database.exec("PRAGMA journal_mode = WAL");
  }

  prepare(sql: string): StatementSync { return this.database.prepare(sql); }
  exec(sql: string): void { this.database.exec(sql); }
  transaction<T>(operation: () => T, mode: "IMMEDIATE" | "EXCLUSIVE" = "IMMEDIATE"): T {
    this.database.exec(`BEGIN ${mode}`);
    try { const result = operation(); this.database.exec("COMMIT"); return result; }
    catch (error) { try { this.database.exec("ROLLBACK"); } catch { /* preserve original */ } throw error; }
  }
  close(): void { if (this.ownsDatabase && this.database.isOpen) this.database.close(); }
}
