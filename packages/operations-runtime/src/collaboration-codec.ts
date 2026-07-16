import {
  effectiveHandoffTarget,
  handoffStateFromJson,
} from "@work-fabric/exchange-core";
import type {
  EventRecord,
  HandoffReadModel,
} from "@work-fabric/exchange-spi";
import { buildProtocolEvent } from "@work-fabric/exchange-runtime";
import type {
  RelationshipView,
  ResponsibilityView,
  SafeTargetBinding,
  TimelineEntry,
} from "@work-fabric/operations-spi";

function targetBinding(
  state: ReturnType<typeof handoffStateFromJson>,
): SafeTargetBinding | null {
  const binding = state.target_binding;
  if (binding === null) return null;
  return {
    target: structuredClone(binding.target),
    resolver_endpoint_id: binding.resolver_endpoint_id,
    resolved_at: binding.resolved_at,
  };
}

export function responsibilityFromModel(
  model: HandoffReadModel,
): ResponsibilityView {
  const state = handoffStateFromJson(model.state);
  if (
    state.handoff_id !== model.handoff_id ||
    state.resource_version !== model.stream_version
  ) throw new Error("Handoff model identity or version is inconsistent");
  return {
    tenant_id: model.tenant_id,
    partition_id: model.partition_id,
    thread_id: state.thread_id,
    handoff_id: model.handoff_id,
    stream_version: model.stream_version,
    lifecycle_state: state.lifecycle_state,
    initiator: structuredClone(state.initiator),
    recipient: structuredClone(state.recipient),
    current_responsible_actor: structuredClone(state.current_responsible_actor),
    verifier: structuredClone(state.verifier),
    target_binding: targetBinding(state),
    work_reference: structuredClone(state.package.work_reference),
    priority: state.package.priority,
    accept_by: state.package.accept_by,
    result_due_at: state.package.result_due_at,
    latest_status: structuredClone(model.latest_status),
    parent_handoff_id: state.parent_handoff_id,
    child_handoff_id: state.child_handoff_id,
    created_at: state.created_at,
    updated_at: state.updated_at,
  };
}

export function timelineFromRecord(record: EventRecord): TimelineEntry {
  const event = buildProtocolEvent(record);
  return {
    tenant_id: record.tenant_id,
    partition_id: record.partition_id,
    partition_position: record.partition_position,
    handoff_id: record.handoff_id,
    thread_id: record.thread_id,
    stream_version: record.stream_version,
    event_id: event.id,
    event_type: event.type,
    occurred_at: event.time,
    subject: event.subject,
    event_source: event.source,
    actor_id: record.actor_id,
    endpoint_id: record.endpoint_id,
    correlation_id: event.wfcorrelation ?? null,
    causation_id: event.wfcausation ?? null,
    change: structuredClone(event.data),
  };
}

function relation(
  model: HandoffReadModel,
  kind: RelationshipView["relationship_kind"],
  suffix: string,
  sourceId: string,
  targetId: string,
  observedAt: string,
): RelationshipView {
  return {
    tenant_id: model.tenant_id,
    partition_id: model.partition_id,
    relationship_id: `${model.handoff_id}:${suffix}`,
    relationship_kind: kind,
    source_id: sourceId,
    target_id: targetId,
    handoff_id: model.handoff_id,
    stream_version: model.stream_version,
    observed_at: observedAt,
  };
}

export function relationshipsFromModel(
  model: HandoffReadModel,
): readonly RelationshipView[] {
  const state = handoffStateFromJson(model.state);
  const source = `handoff:${model.handoff_id}`;
  const views: RelationshipView[] = [
    relation(
      model,
      "thread_membership",
      "thread",
      source,
      `thread:${state.thread_id}`,
      state.updated_at,
    ),
  ];
  if (state.current_responsible_actor !== null) {
    views.push(
      relation(
        model,
        "responsibility",
        "responsibility",
        source,
        `actor:${state.current_responsible_actor.actor_id}`,
        state.updated_at,
      ),
    );
  }
  const target = effectiveHandoffTarget(state);
  if (target !== null) {
    views.push(
      relation(
        model,
        "target",
        "target",
        source,
        "actor_id" in target
          ? `actor:${target.actor_id}`
          : `endpoint:${target.endpoint_id}`,
        state.updated_at,
      ),
    );
  }
  if (state.parent_handoff_id !== null) {
    views.push(
      relation(
        model,
        "parent_child",
        "parent",
        `handoff:${state.parent_handoff_id}`,
        source,
        state.updated_at,
      ),
    );
  } else if (state.child_handoff_id !== null) {
    views.push(
      relation(
        model,
        "parent_child",
        "child",
        source,
        `handoff:${state.child_handoff_id}`,
        state.updated_at,
      ),
    );
  }
  return views.sort((left, right) =>
    left.relationship_id.localeCompare(right.relationship_id),
  );
}
