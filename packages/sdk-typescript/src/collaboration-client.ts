import {
  assertSafeOperationsJson,
  type CollaborationPage,
  type ProjectionFreshness,
  type RelationshipView,
  type ResponsibilityLifecycleState,
  type ResponsibilityView,
  type TimelineEntry,
} from "@work-fabric/operations-spi";
import type { JsonObject } from "@work-fabric/exchange-spi";
import type { RepresentationContext } from "./config.js";
import {
  decodeObject,
  identifier,
  positive,
  type RequestOptions,
} from "./query-client.js";
import type { SdkTransport } from "./transport.js";

const lifecycles: readonly ResponsibilityLifecycleState[] = [
  "target_resolution_pending", "target_unavailable", "offered", "accepted",
  "result_returned", "verified", "rework_requested", "closed", "declined",
  "expired", "cancelled", "transferred",
];
const priorities = ["low", "normal", "high", "critical"] as const;

export interface CollaborationPageOptions extends RequestOptions {
  readonly partitionId: string;
  readonly cursor?: string;
  readonly limit?: number;
}
export interface ResponsibilityListOptions extends CollaborationPageOptions {
  readonly threadId?: string;
  readonly responsibleActorId?: string;
  readonly lifecycleStates?: readonly ResponsibilityLifecycleState[];
  readonly priorities?: readonly ResponsibilityView["priority"][];
  readonly dueBefore?: string;
}
export interface TimelineListOptions extends CollaborationPageOptions {
  readonly handoffId?: string;
  readonly threadId?: string;
}
export type RelationshipListOptions = TimelineListOptions;

function requestOptions(
  representation: RepresentationContext,
  options: RequestOptions,
) {
  return {
    representation: options.representation ?? representation,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function optionalIdentifier(value: string | undefined, field: string) {
  return value === undefined ? undefined : identifier(value, field);
}

function boundedCursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > 2048) throw new TypeError("cursor is invalid");
  return value;
}

function enumList<T extends string>(
  value: readonly T[] | undefined,
  allowed: readonly T[],
  field: string,
): readonly T[] | undefined {
  if (value === undefined) return undefined;
  if (
    value.length === 0 ||
    value.length > 16 ||
    value.some((item) => !allowed.includes(item))
  ) throw new TypeError(`${field} is invalid`);
  return [...new Set(value)];
}

function object(value: unknown, field: string): Record<string, unknown> {
  try {
    return decodeObject<Record<string, unknown>>(value);
  } catch {
    throw new TypeError(`${field} is invalid`);
  }
}

function stringField(
  value: Record<string, unknown>,
  field: string,
  max = 255,
): string {
  const candidate = value[field];
  if (
    typeof candidate !== "string" || candidate.length === 0 ||
    candidate.length > max || candidate.trim() !== candidate
  ) throw new TypeError(`${field} is invalid`);
  return candidate;
}

function integerField(
  value: Record<string, unknown>,
  field: string,
  allowZero = false,
): number {
  const candidate = value[field];
  if (
    !Number.isSafeInteger(candidate) ||
    (allowZero ? (candidate as number) < 0 : (candidate as number) <= 0)
  ) throw new TypeError(`${field} is invalid`);
  return candidate as number;
}

function nullableString(value: Record<string, unknown>, field: string): string | null {
  return value[field] === null ? null : stringField(value, field);
}

function timestampField(value: Record<string, unknown>, field: string): string {
  const candidate = stringField(value, field);
  if (!Number.isFinite(Date.parse(candidate))) throw new TypeError(`${field} is invalid`);
  return candidate;
}

function targetBinding(value: unknown): ResponsibilityView["target_binding"] {
  if (value === null) return null;
  const candidate = object(value, "target_binding");
  const target = object(candidate.target, "target_binding.target");
  const actorId = target.actor_id;
  const endpointId = target.endpoint_id;
  if (
    (typeof actorId === "string") === (typeof endpointId === "string") ||
    Object.keys(target).length !== 1
  ) throw new TypeError("target_binding.target is invalid");
  return {
    target: typeof actorId === "string"
      ? { actor_id: stringField(target, "actor_id") }
      : { endpoint_id: stringField(target, "endpoint_id") },
    resolver_endpoint_id: stringField(candidate, "resolver_endpoint_id"),
    resolved_at: timestampField(candidate, "resolved_at"),
  };
}

function freshness(value: unknown): ProjectionFreshness {
  const candidate = object(value, "freshness");
  const projected = integerField(candidate, "projected_position", true);
  const journal = integerField(candidate, "journal_position", true);
  const observed = stringField(candidate, "observed_at");
  if (journal < projected || !Number.isFinite(Date.parse(observed))) {
    throw new TypeError("freshness is invalid");
  }
  return {
    projector_id: stringField(candidate, "projector_id"),
    partition_id: stringField(candidate, "partition_id"),
    projected_position: projected,
    journal_position: journal,
    observed_at: observed,
  };
}

function participant(value: unknown, nullable: true): ResponsibilityView["recipient"];
function participant(value: unknown, nullable?: false): ResponsibilityView["initiator"];
function participant(value: unknown, nullable = false) {
  if (nullable && value === null) return null;
  const candidate = object(value, "participant");
  const actorType = candidate.actor_type;
  if (actorType !== "human" && actorType !== "agent" && actorType !== "system") {
    throw new TypeError("participant actor_type is invalid");
  }
  return { actor_id: stringField(candidate, "actor_id"), actor_type: actorType };
}

function responsibility(value: unknown): ResponsibilityView {
  const candidate = object(value, "responsibility");
  assertSafeOperationsJson(candidate as JsonObject, "responsibility");
  const lifecycle = candidate.lifecycle_state;
  const priority = candidate.priority;
  if (!lifecycles.includes(lifecycle as ResponsibilityLifecycleState)) {
    throw new TypeError("responsibility lifecycle is invalid");
  }
  if (!priorities.includes(priority as (typeof priorities)[number])) {
    throw new TypeError("responsibility priority is invalid");
  }
  const workReference = object(candidate.work_reference, "work_reference");
  assertSafeOperationsJson(workReference as JsonObject, "work_reference");
  const latestStatus = candidate.latest_status === null
    ? null
    : object(candidate.latest_status, "latest_status");
  if (latestStatus !== null) {
    assertSafeOperationsJson(latestStatus as JsonObject, "latest_status");
  }
  const result = {
    tenant_id: stringField(candidate, "tenant_id"),
    partition_id: stringField(candidate, "partition_id"),
    thread_id: stringField(candidate, "thread_id"),
    handoff_id: stringField(candidate, "handoff_id"),
    stream_version: integerField(candidate, "stream_version"),
    lifecycle_state: lifecycle,
    initiator: participant(candidate.initiator),
    recipient: participant(candidate.recipient, true),
    current_responsible_actor: participant(candidate.current_responsible_actor, true),
    verifier: participant(candidate.verifier),
    target_binding: targetBinding(candidate.target_binding),
    work_reference: workReference,
    priority,
    accept_by: timestampField(candidate, "accept_by"),
    result_due_at: timestampField(candidate, "result_due_at"),
    latest_status: latestStatus,
    parent_handoff_id: nullableString(candidate, "parent_handoff_id"),
    child_handoff_id: nullableString(candidate, "child_handoff_id"),
    created_at: timestampField(candidate, "created_at"),
    updated_at: timestampField(candidate, "updated_at"),
  } as ResponsibilityView;
  return structuredClone(result);
}

function timeline(value: unknown): TimelineEntry {
  const candidate = object(value, "timeline entry");
  assertSafeOperationsJson(candidate as JsonObject, "timeline entry");
  const change = object(candidate.change, "timeline change");
  assertSafeOperationsJson(change as JsonObject, "timeline change");
  return structuredClone({
    tenant_id: stringField(candidate, "tenant_id"),
    partition_id: stringField(candidate, "partition_id"),
    partition_position: integerField(candidate, "partition_position"),
    handoff_id: stringField(candidate, "handoff_id"),
    thread_id: stringField(candidate, "thread_id"),
    stream_version: integerField(candidate, "stream_version"),
    event_id: stringField(candidate, "event_id"),
    event_type: stringField(candidate, "event_type"),
    occurred_at: timestampField(candidate, "occurred_at"),
    subject: stringField(candidate, "subject"),
    event_source: stringField(candidate, "event_source"),
    actor_id: stringField(candidate, "actor_id"),
    endpoint_id: stringField(candidate, "endpoint_id"),
    correlation_id: nullableString(candidate, "correlation_id"),
    causation_id: nullableString(candidate, "causation_id"),
    change,
  } as TimelineEntry);
}

function relationship(value: unknown): RelationshipView {
  const candidate = object(value, "relationship");
  assertSafeOperationsJson(candidate as JsonObject, "relationship");
  const kind = candidate.relationship_kind;
  if (
    kind !== "thread_membership" && kind !== "parent_child" &&
    kind !== "responsibility" && kind !== "target"
  ) throw new TypeError("relationship kind is invalid");
  return structuredClone({
    tenant_id: stringField(candidate, "tenant_id"),
    partition_id: stringField(candidate, "partition_id"),
    thread_id: stringField(candidate, "thread_id"),
    relationship_id: stringField(candidate, "relationship_id"),
    relationship_kind: kind,
    source_id: stringField(candidate, "source_id"),
    target_id: stringField(candidate, "target_id"),
    handoff_id: stringField(candidate, "handoff_id"),
    stream_version: integerField(candidate, "stream_version"),
    observed_at: timestampField(candidate, "observed_at"),
  });
}

function decodePage<T>(
  value: unknown,
  decodeItem: (item: unknown) => T,
): CollaborationPage<T> {
  const candidate = object(value, "collaboration page");
  if (!Array.isArray(candidate.items)) throw new TypeError("items is invalid");
  const nextCursor = candidate.next_cursor;
  if (nextCursor !== null && (typeof nextCursor !== "string" || nextCursor.length > 2048)) {
    throw new TypeError("next_cursor is invalid");
  }
  return {
    items: candidate.items.map(decodeItem),
    next_cursor: nextCursor,
    freshness: freshness(candidate.freshness),
  };
}

export class CollaborationClient {
  constructor(
    private readonly transport: SdkTransport,
    private readonly representation: RepresentationContext,
  ) {}

  listResponsibilities(
    input: ResponsibilityListOptions,
  ): Promise<CollaborationPage<ResponsibilityView>> {
    const states = enumList(input.lifecycleStates, lifecycles, "lifecycleStates");
    const selectedPriorities = enumList(input.priorities, priorities, "priorities");
    const limit = positive(input.limit, "limit");
    const dueBefore = input.dueBefore;
    if (dueBefore !== undefined && !Number.isFinite(Date.parse(dueBefore))) {
      throw new TypeError("dueBefore is invalid");
    }
    return this.transport.request({
      method: "GET",
      path: ["v1", "responsibilities"],
      query: {
        partition_id: identifier(input.partitionId, "partitionId"),
        thread_id: optionalIdentifier(input.threadId, "threadId"),
        responsible_actor_id: optionalIdentifier(input.responsibleActorId, "responsibleActorId"),
        lifecycle_state: states,
        priority: selectedPriorities,
        due_before: dueBefore,
        cursor: boundedCursor(input.cursor),
        limit,
      },
      retry: "query",
      ...requestOptions(this.representation, input),
      decode: (value) => decodePage(value, responsibility),
    });
  }

  listTimeline(input: TimelineListOptions): Promise<CollaborationPage<TimelineEntry>> {
    return this.transport.request({
      method: "GET",
      path: ["v1", "timeline"],
      query: {
        partition_id: identifier(input.partitionId, "partitionId"),
        handoff_id: optionalIdentifier(input.handoffId, "handoffId"),
        thread_id: optionalIdentifier(input.threadId, "threadId"),
        cursor: boundedCursor(input.cursor),
        limit: positive(input.limit, "limit"),
      },
      retry: "query",
      ...requestOptions(this.representation, input),
      decode: (value) => decodePage(value, timeline),
    });
  }

  listRelationships(
    input: RelationshipListOptions,
  ): Promise<CollaborationPage<RelationshipView>> {
    return this.transport.request({
      method: "GET",
      path: ["v1", "relationships"],
      query: {
        partition_id: identifier(input.partitionId, "partitionId"),
        handoff_id: optionalIdentifier(input.handoffId, "handoffId"),
        thread_id: optionalIdentifier(input.threadId, "threadId"),
        cursor: boundedCursor(input.cursor),
        limit: positive(input.limit, "limit"),
      },
      retry: "query",
      ...requestOptions(this.representation, input),
      decode: (value) => decodePage(value, relationship),
    });
  }
}
