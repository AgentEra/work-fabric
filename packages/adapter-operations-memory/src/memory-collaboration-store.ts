import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  COLLABORATION_VIEW_REQUIRED_CAPABILITIES,
  assertSafeOperationsJson,
  createOpaqueCursorCodec,
  normalizePageLimit,
  type CollaborationViewStore,
  type CursorAuthenticator,
  type CursorPage,
  type OpaqueCursorCodec,
  type RelationshipQuery,
  type RelationshipView,
  type ResponsibilityQuery,
  type ResponsibilityView,
  type TimelineEntry,
  type TimelineQuery,
} from "@work-fabric/operations-spi";
import type { JsonObject } from "@work-fabric/exchange-spi";

export interface MemoryCollaborationViewStoreOptions {
  readonly cursor_secret?: string;
  readonly max_page_limit?: number;
  readonly max_cursor_length?: number;
}

function key(...parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function bounded(value: string, field: string, maxLength = 128): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value
  ) throw new TypeError(`${field} is invalid`);
}

function positive(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}

function timestamp(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${field} is invalid`);
}

function authenticator(secret: string): CursorAuthenticator {
  const signature = (payload: string) =>
    createHmac("sha256", secret).update(payload).digest("base64url");
  return {
    async sign(payload) {
      return signature(payload);
    },
    async verify(payload, candidate) {
      const expected = Buffer.from(signature(payload));
      const actual = Buffer.from(candidate);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    },
  };
}

function filters(values: Readonly<Record<string, unknown>>): JsonObject {
  const result: Record<string, JsonObject[keyof JsonObject]> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) {
      result[name] = null;
    } else if (Array.isArray(value)) {
      result[name] = [...value].sort() as readonly string[];
    } else {
      result[name] = value as string | number | boolean | null;
    }
  }
  return result;
}

function compareDescTimeId(
  leftTime: string,
  leftId: string,
  rightTime: string,
  rightId: string,
): number {
  const time = rightTime.localeCompare(leftTime);
  return time === 0 ? leftId.localeCompare(rightId) : time;
}

function afterDescTimeId(
  time: string,
  id: string,
  positionTime: string,
  positionId: string,
): boolean {
  return time < positionTime || (time === positionTime && id > positionId);
}

function stringPosition(position: JsonObject, field: string): string {
  const value = position[field];
  if (typeof value !== "string") throw new TypeError(`cursor ${field} is invalid`);
  return value;
}

function numberPosition(position: JsonObject, field: string): number {
  const value = position[field];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`cursor ${field} is invalid`);
  }
  return value as number;
}

export class MemoryCollaborationViewStore implements CollaborationViewStore {
  readonly manifest = {
    profile: "workfabric.collaboration-view.v1",
    adapter: "memory",
    capabilities: Object.fromEntries(
      COLLABORATION_VIEW_REQUIRED_CAPABILITIES.map((capability) => [capability, true]),
    ),
  } as const;

  private readonly responsibilities = new Map<string, ResponsibilityView>();
  private readonly timeline = new Map<string, TimelineEntry>();
  private readonly relationships = new Map<string, RelationshipView>();
  private readonly relationshipVersions = new Map<string, number>();
  private readonly cursor: OpaqueCursorCodec;
  private readonly maxPageLimit: number;

  constructor(options: MemoryCollaborationViewStoreOptions = {}) {
    this.maxPageLimit = options.max_page_limit ?? 100;
    positive(this.maxPageLimit, "max_page_limit");
    const secret = options.cursor_secret ?? randomBytes(32).toString("base64url");
    bounded(secret, "cursor_secret");
    this.cursor = createOpaqueCursorCodec(authenticator(secret), {
      max_length: options.max_cursor_length ?? 2048,
    });
  }

  async putResponsibility(input: ResponsibilityView): Promise<void> {
    const view = structuredClone(input);
    this.validateResponsibility(view);
    const storageKey = key(view.tenant_id, view.handoff_id);
    const existing = this.responsibilities.get(storageKey);
    if (existing !== undefined) {
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
    this.responsibilities.set(storageKey, view);
  }

  async putTimeline(input: TimelineEntry): Promise<void> {
    const entry = structuredClone(input);
    bounded(entry.tenant_id, "tenant_id");
    bounded(entry.partition_id, "partition_id");
    bounded(entry.event_id, "event_id");
    bounded(entry.handoff_id, "handoff_id");
    bounded(entry.thread_id, "thread_id");
    positive(entry.partition_position, "partition_position");
    positive(entry.stream_version, "stream_version");
    timestamp(entry.occurred_at, "occurred_at");
    assertSafeOperationsJson(entry.change, "timeline change");
    const storageKey = key(entry.tenant_id, entry.partition_id, entry.event_id);
    const existing = this.timeline.get(storageKey);
    if (existing !== undefined) {
      if (isDeepStrictEqual(entry, existing)) return;
      throw new Error("timeline event conflict");
    }
    this.timeline.set(storageKey, entry);
  }

  async putRelationship(input: RelationshipView): Promise<void> {
    const view = structuredClone(input);
    bounded(view.tenant_id, "tenant_id");
    bounded(view.partition_id, "partition_id");
    bounded(view.thread_id, "thread_id");
    bounded(view.relationship_id, "relationship_id", 255);
    bounded(view.handoff_id, "handoff_id");
    positive(view.stream_version, "stream_version");
    timestamp(view.observed_at, "observed_at");
    const storageKey = key(view.tenant_id, view.partition_id, view.relationship_id);
    const existing = this.relationships.get(storageKey);
    if (existing !== undefined) {
      if (view.stream_version < existing.stream_version) {
        throw new Error("stale relationship version");
      }
      if (view.stream_version === existing.stream_version) {
        if (isDeepStrictEqual(view, existing)) return;
        throw new Error("relationship same version conflict");
      }
    }
    this.relationships.set(storageKey, view);
  }

  async replaceHandoffRelationships(
    tenantId: string,
    partitionId: string,
    handoffId: string,
    streamVersion: number,
    input: readonly RelationshipView[],
  ): Promise<void> {
    bounded(tenantId, "tenantId");
    bounded(partitionId, "partitionId");
    bounded(handoffId, "handoffId");
    positive(streamVersion, "streamVersion");
    const views = structuredClone(input);
    const ids = new Set<string>();
    for (const view of views) {
      if (
        view.tenant_id !== tenantId ||
        view.partition_id !== partitionId ||
        view.handoff_id !== handoffId ||
        view.stream_version !== streamVersion
      ) throw new Error("replacement relationship identity or version is inconsistent");
      bounded(view.thread_id, "thread_id");
      bounded(view.relationship_id, "relationship_id", 255);
      bounded(view.source_id, "source_id", 255);
      bounded(view.target_id, "target_id", 255);
      timestamp(view.observed_at, "observed_at");
      if (ids.has(view.relationship_id)) {
        throw new Error("replacement relationship identity is duplicated");
      }
      ids.add(view.relationship_id);
    }
    const versionKey = key(tenantId, partitionId, handoffId);
    const existingVersion = this.relationshipVersions.get(versionKey);
    const existing = [...this.relationships.values()]
      .filter((view) =>
        view.tenant_id === tenantId &&
        view.partition_id === partitionId &&
        view.handoff_id === handoffId,
      )
      .sort((left, right) => left.relationship_id.localeCompare(right.relationship_id));
    const sorted = [...views].sort((left, right) =>
      left.relationship_id.localeCompare(right.relationship_id),
    );
    if (existingVersion !== undefined) {
      if (streamVersion < existingVersion) throw new Error("stale relationship version");
      if (streamVersion === existingVersion) {
        if (isDeepStrictEqual(existing, sorted)) return;
        throw new Error("relationship same version conflict");
      }
    }
    for (const [storageKey, view] of this.relationships) {
      if (
        view.tenant_id === tenantId &&
        view.partition_id === partitionId &&
        view.handoff_id === handoffId
      ) this.relationships.delete(storageKey);
    }
    for (const view of sorted) {
      this.relationships.set(
        key(view.tenant_id, view.partition_id, view.relationship_id),
        view,
      );
    }
    this.relationshipVersions.set(versionKey, streamVersion);
  }

  async getResponsibility(tenantId: string, handoffId: string) {
    bounded(tenantId, "tenantId");
    bounded(handoffId, "handoffId");
    const view = this.responsibilities.get(key(tenantId, handoffId));
    return view === undefined ? null : structuredClone(view);
  }

  async listResponsibilities(
    query: ResponsibilityQuery,
  ): Promise<CursorPage<ResponsibilityView>> {
    bounded(query.tenant_id, "tenant_id");
    const limit = normalizePageLimit(query.limit, {
      default_limit: 25,
      max_limit: this.maxPageLimit,
    });
    const context = {
      kind: "responsibility" as const,
      sort: "updated_desc_handoff_asc",
      filters: filters({
        partition_id: query.partition_id,
        thread_id: query.thread_id,
        responsible_actor_id: query.responsible_actor_id,
        lifecycle_states: query.lifecycle_states,
        priorities: query.priorities,
        due_before: query.due_before,
      }),
    };
    const position = query.cursor === undefined
      ? null
      : await this.cursor.decode(query.cursor, context);
    const positionTime = position === null ? null : stringPosition(position, "updated_at");
    const positionId = position === null ? null : stringPosition(position, "handoff_id");
    const candidates = [...this.responsibilities.values()]
      .filter((view) =>
        view.tenant_id === query.tenant_id &&
        (query.partition_id === undefined || view.partition_id === query.partition_id) &&
        (query.thread_id === undefined || view.thread_id === query.thread_id) &&
        (query.responsible_actor_id === undefined ||
          view.current_responsible_actor?.actor_id === query.responsible_actor_id) &&
        (query.lifecycle_states === undefined ||
          query.lifecycle_states.includes(view.lifecycle_state)) &&
        (query.priorities === undefined || query.priorities.includes(view.priority)) &&
        (query.due_before === undefined || view.result_due_at <= query.due_before) &&
        (positionTime === null || positionId === null ||
          afterDescTimeId(view.updated_at, view.handoff_id, positionTime, positionId)),
      )
      .sort((left, right) =>
        compareDescTimeId(
          left.updated_at,
          left.handoff_id,
          right.updated_at,
          right.handoff_id,
        ),
      );
    return this.page(candidates, limit, context, (last) => ({
      updated_at: last.updated_at,
      handoff_id: last.handoff_id,
    }));
  }

  async listTimeline(query: TimelineQuery): Promise<CursorPage<TimelineEntry>> {
    bounded(query.tenant_id, "tenant_id");
    bounded(query.partition_id, "partition_id");
    const limit = normalizePageLimit(query.limit, {
      default_limit: 25,
      max_limit: this.maxPageLimit,
    });
    const context = {
      kind: "timeline" as const,
      sort: "position_asc_event_asc",
      filters: filters({
        partition_id: query.partition_id,
        handoff_id: query.handoff_id,
        thread_id: query.thread_id,
      }),
    };
    const position = query.cursor === undefined
      ? null
      : await this.cursor.decode(query.cursor, context);
    const partitionPosition = position === null
      ? null
      : numberPosition(position, "partition_position");
    const eventId = position === null ? null : stringPosition(position, "event_id");
    const candidates = [...this.timeline.values()]
      .filter((entry) =>
        entry.tenant_id === query.tenant_id &&
        entry.partition_id === query.partition_id &&
        (query.handoff_id === undefined || entry.handoff_id === query.handoff_id) &&
        (query.thread_id === undefined || entry.thread_id === query.thread_id) &&
        (partitionPosition === null || eventId === null ||
          entry.partition_position > partitionPosition ||
          (entry.partition_position === partitionPosition && entry.event_id > eventId)),
      )
      .sort((left, right) =>
        left.partition_position - right.partition_position ||
        left.event_id.localeCompare(right.event_id),
      );
    return this.page(candidates, limit, context, (last) => ({
      partition_position: last.partition_position,
      event_id: last.event_id,
    }));
  }

  async listRelationships(
    query: RelationshipQuery,
  ): Promise<CursorPage<RelationshipView>> {
    bounded(query.tenant_id, "tenant_id");
    bounded(query.partition_id, "partition_id");
    const limit = normalizePageLimit(query.limit, {
      default_limit: 25,
      max_limit: this.maxPageLimit,
    });
    const context = {
      kind: "relationship" as const,
      sort: "observed_desc_relationship_asc",
      filters: filters({
        partition_id: query.partition_id,
        handoff_id: query.handoff_id,
        thread_id: query.thread_id,
      }),
    };
    const position = query.cursor === undefined
      ? null
      : await this.cursor.decode(query.cursor, context);
    const observedAt = position === null ? null : stringPosition(position, "observed_at");
    const relationshipId = position === null
      ? null
      : stringPosition(position, "relationship_id");
    const candidates = [...this.relationships.values()]
      .filter((view) =>
        view.tenant_id === query.tenant_id &&
        view.partition_id === query.partition_id &&
        (query.handoff_id === undefined || view.handoff_id === query.handoff_id) &&
        (query.thread_id === undefined || view.thread_id === query.thread_id) &&
        (observedAt === null || relationshipId === null ||
          afterDescTimeId(
            view.observed_at,
            view.relationship_id,
            observedAt,
            relationshipId,
          )),
      )
      .sort((left, right) =>
        compareDescTimeId(
          left.observed_at,
          left.relationship_id,
          right.observed_at,
          right.relationship_id,
        ),
      );
    return this.page(candidates, limit, context, (last) => ({
      observed_at: last.observed_at,
      relationship_id: last.relationship_id,
    }));
  }

  async clearPartition(tenantId: string, partitionId: string): Promise<void> {
    bounded(tenantId, "tenantId");
    bounded(partitionId, "partitionId");
    for (const [storageKey, view] of this.responsibilities) {
      if (view.tenant_id === tenantId && view.partition_id === partitionId) {
        this.responsibilities.delete(storageKey);
      }
    }
    for (const [storageKey, entry] of this.timeline) {
      if (entry.tenant_id === tenantId && entry.partition_id === partitionId) {
        this.timeline.delete(storageKey);
      }
    }
    for (const [storageKey, view] of this.relationships) {
      if (view.tenant_id === tenantId && view.partition_id === partitionId) {
        this.relationships.delete(storageKey);
      }
    }
    for (const versionKey of this.relationshipVersions.keys()) {
      const [tenant, partition] = JSON.parse(versionKey) as readonly string[];
      if (tenant === tenantId && partition === partitionId) {
        this.relationshipVersions.delete(versionKey);
      }
    }
  }

  private validateResponsibility(view: ResponsibilityView): void {
    bounded(view.tenant_id, "tenant_id");
    bounded(view.partition_id, "partition_id");
    bounded(view.thread_id, "thread_id");
    bounded(view.handoff_id, "handoff_id");
    positive(view.stream_version, "stream_version");
    timestamp(view.created_at, "created_at");
    timestamp(view.updated_at, "updated_at");
    timestamp(view.accept_by, "accept_by");
    timestamp(view.result_due_at, "result_due_at");
    assertSafeOperationsJson(view.work_reference, "work_reference");
    if (view.latest_status !== null) {
      assertSafeOperationsJson(view.latest_status, "latest_status");
    }
  }

  private async page<T>(
    candidates: readonly T[],
    limit: number,
    context: Parameters<OpaqueCursorCodec["decode"]>[1],
    position: (value: T) => JsonObject,
  ): Promise<CursorPage<T>> {
    const selected = candidates.slice(0, limit);
    const last = selected.at(-1);
    return {
      items: structuredClone(selected),
      next_cursor:
        candidates.length > limit && last !== undefined
          ? await this.cursor.encode({ ...context, position: position(last) })
          : null,
    };
  }
}
