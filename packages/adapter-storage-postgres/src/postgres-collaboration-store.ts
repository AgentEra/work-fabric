import { isDeepStrictEqual } from "node:util";

import type { CapabilityManifest, JsonObject } from "@work-fabric/exchange-spi";
import {
  assertSafeOperationsJson,
  COLLABORATION_VIEW_REQUIRED_CAPABILITIES,
  normalizePageLimit,
  type CollaborationViewStore,
  type CursorPage,
  type OpaqueCursorCodec,
  type RelationshipQuery,
  type RelationshipView,
  type ResponsibilityQuery,
  type ResponsibilityView,
  type TimelineEntry,
  type TimelineQuery,
} from "@work-fabric/operations-spi";
import {
  clone,
  cursorCodec,
  filterJson,
  identity,
  json,
  positionNumber,
  positionString,
  positive,
  run,
  timestamp,
  type SessionFactory,
} from "./postgres-operability-common.js";

export interface PostgresOperabilityStoreOptions {
  readonly cursor_secret: string;
  readonly max_page_limit?: number;
  readonly max_cursor_length?: number;
}

const manifest: CapabilityManifest = {
  profile: "workfabric.collaboration-view.v1",
  adapter: "postgres",
  capabilities: Object.fromEntries(
    COLLABORATION_VIEW_REQUIRED_CAPABILITIES.map((capability) => [capability, true]),
  ),
};

function validateResponsibility(view: ResponsibilityView): void {
  identity(view.tenant_id, "tenant_id");
  identity(view.partition_id, "partition_id");
  identity(view.thread_id, "thread_id");
  identity(view.handoff_id, "handoff_id");
  positive(view.stream_version, "stream_version");
  timestamp(view.accept_by, "accept_by");
  timestamp(view.result_due_at, "result_due_at");
  timestamp(view.created_at, "created_at");
  timestamp(view.updated_at, "updated_at");
  assertSafeOperationsJson(view.work_reference, "work_reference");
  if (view.latest_status !== null) {
    assertSafeOperationsJson(view.latest_status, "latest_status");
  }
}

function validateTimeline(entry: TimelineEntry): void {
  identity(entry.tenant_id, "tenant_id");
  identity(entry.partition_id, "partition_id");
  identity(entry.event_id, "event_id");
  identity(entry.handoff_id, "handoff_id");
  identity(entry.thread_id, "thread_id");
  positive(entry.partition_position, "partition_position");
  positive(entry.stream_version, "stream_version");
  timestamp(entry.occurred_at, "occurred_at");
  assertSafeOperationsJson(entry.change, "timeline change");
}

function validateRelationship(view: RelationshipView): void {
  identity(view.tenant_id, "tenant_id");
  identity(view.partition_id, "partition_id");
  identity(view.thread_id, "thread_id");
  identity(view.handoff_id, "handoff_id");
  identity(view.relationship_id, "relationship_id");
  identity(view.source_id, "source_id");
  identity(view.target_id, "target_id");
  positive(view.stream_version, "stream_version");
  timestamp(view.observed_at, "observed_at");
}

function add(
  where: string[],
  values: unknown[],
  clause: string,
  value: unknown,
): void {
  values.push(value);
  where.push(clause.replace("?", `$${values.length}`));
}

export class PostgresCollaborationViewStore implements CollaborationViewStore {
  readonly manifest = clone(manifest);
  private readonly cursor: OpaqueCursorCodec;
  private readonly maxPageLimit: number;

  constructor(
    private readonly sessions: SessionFactory,
    private readonly tenantId: string,
    options: PostgresOperabilityStoreOptions,
  ) {
    identity(tenantId, "tenantId");
    this.maxPageLimit = options.max_page_limit ?? 100;
    positive(this.maxPageLimit, "max_page_limit");
    this.cursor = cursorCodec(options.cursor_secret, options.max_cursor_length);
  }

  async putResponsibility(input: ResponsibilityView): Promise<void> {
    const view = clone(input);
    validateResponsibility(view);
    if (view.tenant_id !== this.tenantId) throw new Error("tenant context mismatch");
    await run(this.sessions, this.tenantId, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))",
        [this.tenantId, `responsibility:${view.handoff_id}`],
      );
      const existingResult = await client.query<{ payload: unknown }>(
        "SELECT payload FROM work_fabric_responsibility_views WHERE tenant_id=$1 AND handoff_id=$2 FOR UPDATE",
        [this.tenantId, view.handoff_id],
      );
      const row = existingResult.rows[0];
      if (row !== undefined) {
        const existing = json<ResponsibilityView>(row.payload);
        validateResponsibility(existing);
        if (view.stream_version < existing.stream_version) {
          throw new Error("stale responsibility version");
        }
        if (view.stream_version === existing.stream_version) {
          if (isDeepStrictEqual(view, existing)) return;
          throw new Error("responsibility same version conflict");
        }
        if (
          view.partition_id !== existing.partition_id ||
          view.thread_id !== existing.thread_id ||
          view.handoff_id !== existing.handoff_id
        ) throw new Error("responsibility identity cannot change");
      }
      await client.query(
        "INSERT INTO work_fabric_responsibility_views (tenant_id,partition_id,thread_id,handoff_id,stream_version,responsible_actor_id,lifecycle_state,priority,result_due_at,updated_at,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT (tenant_id,handoff_id) DO UPDATE SET stream_version=EXCLUDED.stream_version,responsible_actor_id=EXCLUDED.responsible_actor_id,lifecycle_state=EXCLUDED.lifecycle_state,priority=EXCLUDED.priority,result_due_at=EXCLUDED.result_due_at,updated_at=EXCLUDED.updated_at,payload=EXCLUDED.payload",
        [
          this.tenantId, view.partition_id, view.thread_id, view.handoff_id,
          view.stream_version, view.current_responsible_actor?.actor_id ?? null,
          view.lifecycle_state, view.priority, view.result_due_at, view.updated_at,
          JSON.stringify(view),
        ],
      );
    });
  }

  async putTimeline(input: TimelineEntry): Promise<void> {
    const entry = clone(input);
    validateTimeline(entry);
    if (entry.tenant_id !== this.tenantId) throw new Error("tenant context mismatch");
    await run(this.sessions, this.tenantId, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2 || ':' || $3, 0))",
        [this.tenantId, entry.partition_id, `timeline:${entry.event_id}`],
      );
      const existingResult = await client.query<{ payload: unknown }>(
        "SELECT payload FROM work_fabric_timeline_entries WHERE tenant_id=$1 AND partition_id=$2 AND event_id=$3 FOR UPDATE",
        [this.tenantId, entry.partition_id, entry.event_id],
      );
      const row = existingResult.rows[0];
      if (row !== undefined) {
        const existing = json<TimelineEntry>(row.payload);
        validateTimeline(existing);
        if (isDeepStrictEqual(entry, existing)) return;
        throw new Error("timeline event conflict");
      }
      await client.query(
        "INSERT INTO work_fabric_timeline_entries (tenant_id,partition_id,partition_position,event_id,handoff_id,thread_id,occurred_at,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
        [
          this.tenantId, entry.partition_id, entry.partition_position,
          entry.event_id, entry.handoff_id, entry.thread_id, entry.occurred_at,
          JSON.stringify(entry),
        ],
      );
    });
  }

  async replaceHandoffRelationships(
    tenantId: string,
    partitionId: string,
    handoffId: string,
    streamVersion: number,
    input: readonly RelationshipView[],
  ): Promise<void> {
    identity(tenantId, "tenantId");
    identity(partitionId, "partitionId");
    identity(handoffId, "handoffId");
    positive(streamVersion, "streamVersion");
    if (tenantId !== this.tenantId) throw new Error("tenant context mismatch");
    const views = [...clone(input)].sort((left, right) =>
      left.relationship_id.localeCompare(right.relationship_id),
    );
    const ids = new Set<string>();
    for (const view of views) {
      validateRelationship(view);
      if (
        view.tenant_id !== tenantId || view.partition_id !== partitionId ||
        view.handoff_id !== handoffId || view.stream_version !== streamVersion
      ) throw new Error("replacement relationship identity or version is inconsistent");
      if (ids.has(view.relationship_id)) throw new Error("relationship identity is duplicated");
      ids.add(view.relationship_id);
    }
    await run(this.sessions, this.tenantId, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2 || ':' || $3, 0))",
        [this.tenantId, partitionId, `relationships:${handoffId}`],
      );
      const versionResult = await client.query<{ stream_version: number | string }>(
        "SELECT stream_version FROM work_fabric_relationship_versions WHERE tenant_id=$1 AND partition_id=$2 AND handoff_id=$3 FOR UPDATE",
        [this.tenantId, partitionId, handoffId],
      );
      const existingVersion = versionResult.rows[0] === undefined
        ? null
        : Number(versionResult.rows[0].stream_version);
      if (existingVersion !== null && streamVersion < existingVersion) {
        throw new Error("stale relationship version");
      }
      if (existingVersion === streamVersion) {
        const existingResult = await client.query<{ payload: unknown }>(
          "SELECT payload FROM work_fabric_relationship_views WHERE tenant_id=$1 AND partition_id=$2 AND handoff_id=$3 ORDER BY relationship_id",
          [this.tenantId, partitionId, handoffId],
        );
        const existing = existingResult.rows.map((row) => json<RelationshipView>(row.payload));
        if (isDeepStrictEqual(existing, views)) return;
        throw new Error("relationship same version conflict");
      }
      await client.query(
        "INSERT INTO work_fabric_relationship_versions (tenant_id,partition_id,handoff_id,stream_version) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id,partition_id,handoff_id) DO UPDATE SET stream_version=EXCLUDED.stream_version",
        [this.tenantId, partitionId, handoffId, streamVersion],
      );
      await client.query(
        "DELETE FROM work_fabric_relationship_views WHERE tenant_id=$1 AND partition_id=$2 AND handoff_id=$3",
        [this.tenantId, partitionId, handoffId],
      );
      for (const view of views) {
        await client.query(
          "INSERT INTO work_fabric_relationship_views (tenant_id,partition_id,thread_id,handoff_id,relationship_id,relationship_kind,stream_version,observed_at,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
          [
            this.tenantId, partitionId, view.thread_id, handoffId,
            view.relationship_id, view.relationship_kind, streamVersion, view.observed_at,
            JSON.stringify(view),
          ],
        );
      }
    });
  }

  async getResponsibility(
    tenantId: string,
    handoffId: string,
  ): Promise<ResponsibilityView | null> {
    identity(tenantId, "tenantId");
    identity(handoffId, "handoffId");
    if (tenantId !== this.tenantId) return null;
    return run(this.sessions, this.tenantId, async (client) => {
      const result = await client.query<{ payload: unknown }>(
        "SELECT payload FROM work_fabric_responsibility_views WHERE tenant_id=$1 AND handoff_id=$2",
        [this.tenantId, handoffId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const view = json<ResponsibilityView>(row.payload);
      validateResponsibility(view);
      if (view.tenant_id !== this.tenantId || view.handoff_id !== handoffId) {
        throw new Error("responsibility identity mismatch");
      }
      return clone(view);
    });
  }

  async listResponsibilities(
    query: ResponsibilityQuery,
  ): Promise<CursorPage<ResponsibilityView>> {
    if (query.tenant_id !== this.tenantId) return { items: [], next_cursor: null };
    identity(query.partition_id, "partition_id");
    const limit = normalizePageLimit(query.limit, {
      default_limit: 25,
      max_limit: this.maxPageLimit,
    });
    const context = {
      kind: "responsibility" as const,
      sort: "updated_desc_handoff_asc",
      filters: filterJson({
        partition_id: query.partition_id, thread_id: query.thread_id,
        responsible_actor_id: query.responsible_actor_id,
        lifecycle_states: query.lifecycle_states, priorities: query.priorities,
        due_before: query.due_before,
      }),
    };
    const position = query.cursor === undefined
      ? null
      : await this.cursor.decode(query.cursor, context);
    return run(this.sessions, this.tenantId, async (client) => {
      const values: unknown[] = [this.tenantId, query.partition_id];
      const where = ["tenant_id=$1", "partition_id=$2"];
      if (query.thread_id !== undefined) add(where, values, "thread_id=?", query.thread_id);
      if (query.responsible_actor_id !== undefined) add(where, values, "responsible_actor_id=?", query.responsible_actor_id);
      if (query.lifecycle_states !== undefined) add(where, values, "lifecycle_state=ANY(?::text[])", query.lifecycle_states);
      if (query.priorities !== undefined) add(where, values, "priority=ANY(?::text[])", query.priorities);
      if (query.due_before !== undefined) add(where, values, "result_due_at<=?::timestamptz", query.due_before);
      if (position !== null) {
        const updated = positionString(position, "updated_at");
        const handoff = positionString(position, "handoff_id");
        values.push(updated, handoff);
        where.push(`(updated_at < $${values.length - 1}::timestamptz OR (updated_at = $${values.length - 1}::timestamptz AND handoff_id > $${values.length}))`);
      }
      values.push(limit + 1);
      const result = await client.query<{ payload: unknown }>(
        `SELECT payload FROM work_fabric_responsibility_views WHERE ${where.join(" AND ")} ORDER BY updated_at DESC,handoff_id ASC LIMIT $${values.length}`,
        values,
      );
      const items = result.rows.map((row) => json<ResponsibilityView>(row.payload));
      for (const item of items) {
        validateResponsibility(item);
        if (item.tenant_id !== this.tenantId || item.partition_id !== query.partition_id) {
          throw new Error("responsibility list identity mismatch");
        }
      }
      return this.page(items, limit, context, (last) => ({
        updated_at: last.updated_at,
        handoff_id: last.handoff_id,
      }));
    });
  }

  async listTimeline(query: TimelineQuery): Promise<CursorPage<TimelineEntry>> {
    if (query.tenant_id !== this.tenantId) return { items: [], next_cursor: null };
    identity(query.partition_id, "partition_id");
    const limit = normalizePageLimit(query.limit, { default_limit: 25, max_limit: this.maxPageLimit });
    const context = {
      kind: "timeline" as const,
      sort: "position_asc_event_asc",
      filters: filterJson({ partition_id: query.partition_id, handoff_id: query.handoff_id, thread_id: query.thread_id }),
    };
    const position = query.cursor === undefined ? null : await this.cursor.decode(query.cursor, context);
    return run(this.sessions, this.tenantId, async (client) => {
      const values: unknown[] = [this.tenantId, query.partition_id];
      const where = ["tenant_id=$1", "partition_id=$2"];
      if (query.handoff_id !== undefined) add(where, values, "handoff_id=?", query.handoff_id);
      if (query.thread_id !== undefined) add(where, values, "thread_id=?", query.thread_id);
      if (position !== null) {
        const number = positionNumber(position, "partition_position");
        const event = positionString(position, "event_id");
        values.push(number, event);
        where.push(`(partition_position > $${values.length - 1} OR (partition_position = $${values.length - 1} AND event_id > $${values.length}))`);
      }
      values.push(limit + 1);
      const result = await client.query<{ payload: unknown }>(
        `SELECT payload FROM work_fabric_timeline_entries WHERE ${where.join(" AND ")} ORDER BY partition_position ASC,event_id ASC LIMIT $${values.length}`,
        values,
      );
      const items = result.rows.map((row) => json<TimelineEntry>(row.payload));
      for (const item of items) {
        validateTimeline(item);
        if (item.tenant_id !== this.tenantId || item.partition_id !== query.partition_id) {
          throw new Error("timeline list identity mismatch");
        }
      }
      return this.page(items, limit, context, (last) => ({ partition_position: last.partition_position, event_id: last.event_id }));
    });
  }

  async listRelationships(query: RelationshipQuery): Promise<CursorPage<RelationshipView>> {
    if (query.tenant_id !== this.tenantId) return { items: [], next_cursor: null };
    identity(query.partition_id, "partition_id");
    const limit = normalizePageLimit(query.limit, { default_limit: 25, max_limit: this.maxPageLimit });
    const context = {
      kind: "relationship" as const,
      sort: "observed_desc_relationship_asc",
      filters: filterJson({ partition_id: query.partition_id, handoff_id: query.handoff_id, thread_id: query.thread_id }),
    };
    const position = query.cursor === undefined ? null : await this.cursor.decode(query.cursor, context);
    return run(this.sessions, this.tenantId, async (client) => {
      const values: unknown[] = [this.tenantId, query.partition_id];
      const where = ["tenant_id=$1", "partition_id=$2"];
      if (query.handoff_id !== undefined) add(where, values, "handoff_id=?", query.handoff_id);
      if (query.thread_id !== undefined) add(where, values, "thread_id=?", query.thread_id);
      if (position !== null) {
        const observed = positionString(position, "observed_at");
        const relationship = positionString(position, "relationship_id");
        values.push(observed, relationship);
        where.push(`(observed_at < $${values.length - 1}::timestamptz OR (observed_at = $${values.length - 1}::timestamptz AND relationship_id > $${values.length}))`);
      }
      values.push(limit + 1);
      const result = await client.query<{ payload: unknown }>(
        `SELECT payload FROM work_fabric_relationship_views WHERE ${where.join(" AND ")} ORDER BY observed_at DESC,relationship_id ASC LIMIT $${values.length}`,
        values,
      );
      const items = result.rows.map((row) => json<RelationshipView>(row.payload));
      for (const item of items) {
        validateRelationship(item);
        if (item.tenant_id !== this.tenantId || item.partition_id !== query.partition_id) {
          throw new Error("relationship list identity mismatch");
        }
      }
      return this.page(items, limit, context, (last) => ({ observed_at: last.observed_at, relationship_id: last.relationship_id }));
    });
  }

  async clearPartition(tenantId: string, partitionId: string): Promise<void> {
    identity(tenantId, "tenantId");
    identity(partitionId, "partitionId");
    if (tenantId !== this.tenantId) throw new Error("tenant context mismatch");
    await run(this.sessions, this.tenantId, async (client) => {
      await client.query("DELETE FROM work_fabric_responsibility_views WHERE tenant_id=$1 AND partition_id=$2", [this.tenantId, partitionId]);
      await client.query("DELETE FROM work_fabric_timeline_entries WHERE tenant_id=$1 AND partition_id=$2", [this.tenantId, partitionId]);
      await client.query("DELETE FROM work_fabric_relationship_versions WHERE tenant_id=$1 AND partition_id=$2", [this.tenantId, partitionId]);
    });
  }

  private async page<T>(
    values: readonly T[],
    limit: number,
    context: Parameters<OpaqueCursorCodec["decode"]>[1],
    position: (value: T) => JsonObject,
  ): Promise<CursorPage<T>> {
    const items = values.slice(0, limit);
    const last = items.at(-1);
    return {
      items: clone(items),
      next_cursor: values.length > limit && last !== undefined
        ? await this.cursor.encode({ ...context, position: position(last) })
        : null,
    };
  }
}
