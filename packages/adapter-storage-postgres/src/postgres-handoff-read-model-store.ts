import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import type {
  CapabilityManifest,
  HandoffReadModel,
  HandoffReadModelStore,
} from "@work-fabric/exchange-spi";
import { PROJECTION_REQUIRED_CAPABILITIES } from "@work-fabric/exchange-spi";
import {
  clone,
  identity,
  json,
  positive,
  run,
  type SessionFactory,
} from "./postgres-operability-common.js";

export const OPERABILITY_MIGRATION = {
  id: "007_operability",
  sql: readFileSync(
    new URL("../migrations/007_operability.sql", import.meta.url),
    "utf8",
  ),
} as const;

const manifest: CapabilityManifest = {
  profile: "exchange.projection.v1",
  adapter: "postgres",
  capabilities: Object.fromEntries(
    PROJECTION_REQUIRED_CAPABILITIES.map((capability) => [capability, true]),
  ),
};

function validate(model: HandoffReadModel): void {
  identity(model.tenant_id, "tenant_id");
  identity(model.partition_id, "partition_id");
  identity(model.handoff_id, "handoff_id");
  positive(model.stream_version, "stream_version");
  if (typeof model.state !== "object" || model.state === null) {
    throw new TypeError("state is invalid");
  }
}

export class PostgresHandoffReadModelStore implements HandoffReadModelStore {
  readonly manifest = clone(manifest);

  constructor(
    private readonly sessions: SessionFactory,
    private readonly tenantId: string,
  ) {
    identity(tenantId, "tenantId");
  }

  async getHandoff(handoffId: string): Promise<HandoffReadModel | null> {
    identity(handoffId, "handoffId");
    return run(this.sessions, this.tenantId, async (client) => {
      const result = await client.query<{ payload: unknown }>(
        "SELECT payload FROM work_fabric_handoff_read_models WHERE tenant_id=$1 AND handoff_id=$2",
        [this.tenantId, handoffId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const model = json<HandoffReadModel>(row.payload);
      validate(model);
      if (model.tenant_id !== this.tenantId || model.handoff_id !== handoffId) {
        throw new Error("Handoff read model identity mismatch");
      }
      return clone(model);
    });
  }

  async putHandoff(input: HandoffReadModel): Promise<void> {
    const model = clone(input);
    validate(model);
    if (model.tenant_id !== this.tenantId) throw new Error("tenant context mismatch");
    await run(this.sessions, this.tenantId, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))",
        [this.tenantId, `handoff-view:${model.handoff_id}`],
      );
      const result = await client.query<{ payload: unknown }>(
        "SELECT payload FROM work_fabric_handoff_read_models WHERE tenant_id=$1 AND handoff_id=$2 FOR UPDATE",
        [this.tenantId, model.handoff_id],
      );
      const row = result.rows[0];
      if (row !== undefined) {
        const existing = json<HandoffReadModel>(row.payload);
        validate(existing);
        if (model.stream_version < existing.stream_version) {
          throw new Error("stale Handoff read model version");
        }
        if (model.stream_version === existing.stream_version) {
          if (isDeepStrictEqual(model, existing)) return;
          throw new Error("Handoff read model same version conflict");
        }
        if (
          model.tenant_id !== existing.tenant_id ||
          model.partition_id !== existing.partition_id ||
          model.handoff_id !== existing.handoff_id
        ) throw new Error("Handoff read model identity cannot change");
      }
      await client.query(
        "INSERT INTO work_fabric_handoff_read_models (tenant_id,partition_id,handoff_id,stream_version,payload) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (tenant_id,handoff_id) DO UPDATE SET partition_id=EXCLUDED.partition_id,stream_version=EXCLUDED.stream_version,payload=EXCLUDED.payload",
        [this.tenantId, model.partition_id, model.handoff_id, model.stream_version, JSON.stringify(model)],
      );
    });
  }

  async listHandoffs(partitionId: string): Promise<readonly HandoffReadModel[]> {
    identity(partitionId, "partitionId");
    return run(this.sessions, this.tenantId, async (client) => {
      const result = await client.query<{ payload: unknown }>(
        "SELECT payload FROM work_fabric_handoff_read_models WHERE tenant_id=$1 AND partition_id=$2 ORDER BY handoff_id",
        [this.tenantId, partitionId],
      );
      return result.rows.map((row) => {
        const model = json<HandoffReadModel>(row.payload);
        validate(model);
        if (model.tenant_id !== this.tenantId || model.partition_id !== partitionId) {
          throw new Error("Handoff read model list identity mismatch");
        }
        return clone(model);
      });
    });
  }

  async clearPartition(partitionId: string): Promise<void> {
    identity(partitionId, "partitionId");
    await run(this.sessions, this.tenantId, (client) =>
      client.query(
        "DELETE FROM work_fabric_handoff_read_models WHERE tenant_id=$1 AND partition_id=$2",
        [this.tenantId, partitionId],
      ).then(() => undefined),
    );
  }
}
