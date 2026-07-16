import type { PartitionJournalPositionSource } from "@work-fabric/operations-spi";
import { identity, run, type SessionFactory } from "./postgres-operability-common.js";

export class PostgresPartitionJournalPositionSource
implements PartitionJournalPositionSource {
  constructor(
    private readonly sessions: SessionFactory,
    private readonly tenantId: string,
  ) {
    identity(tenantId, "tenantId");
  }

  async load(tenantId: string, partitionId: string): Promise<number | null> {
    identity(tenantId, "tenantId");
    identity(partitionId, "partitionId");
    if (tenantId !== this.tenantId) return null;
    return run(this.sessions, this.tenantId, async (client) => {
      const result = await client.query<{ position: number | string | null }>(
        "SELECT MAX(partition_position) AS position FROM work_fabric_events WHERE tenant_id=$1 AND partition_id=$2",
        [this.tenantId, partitionId],
      );
      const value = result.rows[0]?.position;
      if (value === null || value === undefined) return null;
      const position = Number(value);
      if (!Number.isSafeInteger(position) || position <= 0) {
        throw new Error("partition journal position is invalid");
      }
      return position;
    });
  }
}
