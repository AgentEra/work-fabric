import {
  SQLITE_MIGRATIONS,
  SqliteSession,
  migrateSqlite,
} from "@work-fabric/adapter-storage-sqlite";

export interface SqliteMigrateOptions {
  readonly location: string;
  readonly dry_run?: boolean;
  readonly busy_timeout_ms?: number;
}

export function migrateSqliteFile(options: SqliteMigrateOptions): {
  readonly migrations: number;
  readonly ordered_ids: readonly string[];
} {
  if (typeof options.location !== "string" || options.location.trim().length === 0) {
    throw new TypeError("location must be non-empty");
  }
  const orderedIds = [...SQLITE_MIGRATIONS]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((migration) => migration.id);
  if (options.dry_run === true) return { migrations: 0, ordered_ids: orderedIds };
  const session = new SqliteSession({
    location: options.location,
    ...(options.busy_timeout_ms === undefined
      ? {}
      : { busy_timeout_ms: options.busy_timeout_ms }),
  });
  try {
    const result = migrateSqlite(session);
    return { migrations: result.applied, ordered_ids: result.ordered_ids };
  } finally {
    session.close();
  }
}

function argumentsFrom(argv: readonly string[]): {
  readonly location: string | undefined;
  readonly dryRun: boolean;
} {
  const locationIndex = argv.indexOf("--location");
  return {
    location: locationIndex >= 0 ? argv[locationIndex + 1] : process.env.WORK_FABRIC_SQLITE,
    dryRun: argv.includes("--dry-run"),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = argumentsFrom(process.argv.slice(2));
  if (args.location === undefined) {
    throw new Error("provide --location or WORK_FABRIC_SQLITE");
  }
  try {
    const result = migrateSqliteFile({ location: args.location, dry_run: args.dryRun });
    process.stdout.write(
      `${args.dryRun ? "planned" : "applied"} ${result.migrations} migrations\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
