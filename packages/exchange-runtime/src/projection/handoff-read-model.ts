import {
  handoffStateFromJson,
  type HandoffState,
} from "@work-fabric/exchange-core";
import type {
  AssignmentView,
  HandoffReadModel,
  JsonObject,
} from "@work-fabric/exchange-spi";

function actorToJson(actor: HandoffState["initiator"]): JsonObject {
  return {
    actor_id: actor.actor_id,
    actor_type: actor.actor_type,
  };
}

export function assignmentFromHandoff(
  model: HandoffReadModel,
): AssignmentView | null {
  const state = handoffStateFromJson(model.state);
  if (
    state.handoff_id !== model.handoff_id ||
    state.resource_version !== model.stream_version
  ) {
    throw new Error("Handoff read model identity or version is inconsistent");
  }
  if (state.current_responsible_actor === null) return null;

  return structuredClone({
    tenant_id: model.tenant_id,
    handoff_id: model.handoff_id,
    work_reference: state.package.work_reference,
    responsible_actor: actorToJson(state.current_responsible_actor),
    lifecycle_state: state.lifecycle_state,
    accept_by: state.package.accept_by,
    result_due_at: state.package.result_due_at,
    latest_status: model.latest_status,
  });
}
