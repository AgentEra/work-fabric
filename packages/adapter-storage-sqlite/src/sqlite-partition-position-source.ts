import type { PartitionJournalPositionSource } from "@work-fabric/operations-spi";

import type { SqliteSession } from "./sqlite-session.js";

function identity(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
}

export class SqlitePartitionJournalPositionSource
implements PartitionJournalPositionSource {
  constructor(
    private readonly session: SqliteSession,
    private readonly tenantId: string,
  ) {
    identity(tenantId, "tenantId");
  }

  async load(tenantId: string, partitionId: string): Promise<number | null> {
    identity(tenantId, "tenantId");
    identity(partitionId, "partitionId");
    if (tenantId !== this.tenantId) return null;
    const row = this.session.prepare(
      "SELECT MAX(partition_position) AS position FROM work_fabric_events WHERE tenant_id=? AND partition_id=?",
    ).get(this.tenantId, partitionId) as { position: number | null } | undefined;
    const value = row?.position;
    if (value === null || value === undefined) return null;
    const position = Number(value);
    if (!Number.isSafeInteger(position) || position <= 0) {
      throw new Error("partition journal position is invalid");
    }
    return position;
  }
}
