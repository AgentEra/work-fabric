import type { HandoffEvent } from "./handoff-events.js";
import type { HandoffLifecycleState, HandoffState } from "./handoff-types.js";

const TERMINAL_STATES: ReadonlySet<HandoffLifecycleState> = new Set([
  "closed",
  "declined",
  "expired",
  "cancelled",
  "transferred",
]);

function requireStreamVersion(
  state: HandoffState | null,
  streamVersion: number,
): void {
  if (!Number.isInteger(streamVersion) || streamVersion <= 0) {
    throw new Error(`Invalid Handoff stream version: ${streamVersion}`);
  }

  const expected = state === null ? 1 : state.resource_version + 1;
  if (streamVersion !== expected) {
    throw new Error(
      `Non-contiguous Handoff stream version: expected ${expected}, received ${streamVersion}`,
    );
  }
}

function eventAllowedFrom(
  lifecycleState: HandoffLifecycleState,
  eventType: HandoffEvent["event_type"],
): boolean {
  switch (lifecycleState) {
    case "offered":
      return [
        "workfabric.handoff.accepted.v1",
        "workfabric.handoff.declined.v1",
        "workfabric.handoff.expired.v1",
        "workfabric.handoff.cancelled.v1",
      ].includes(eventType);
    case "accepted":
      return [
        "workfabric.handoff.cancelled.v1",
        "workfabric.handoff.status_reported.v1",
        "workfabric.handoff.result_returned.v1",
        "workfabric.handoff.transferred.v1",
      ].includes(eventType);
    case "result_returned":
      return [
        "workfabric.handoff.verified.v1",
        "workfabric.handoff.rework_requested.v1",
      ].includes(eventType);
    case "rework_requested":
      return eventType === "workfabric.handoff.accepted.v1";
    case "verified":
      return eventType === "workfabric.handoff.closed.v1";
    case "closed":
    case "declined":
    case "expired":
    case "cancelled":
    case "transferred":
      return false;
  }
}

function evolveExisting(
  state: HandoffState,
  event: Exclude<
    HandoffEvent,
    { readonly event_type: "workfabric.handoff.offered.v1" }
  >,
  streamVersion: number,
): HandoffState {
  const common = {
    ...state,
    resource_version: streamVersion,
    updated_at: event.occurred_at,
  };

  switch (event.event_type) {
    case "workfabric.handoff.accepted.v1":
      return {
        ...common,
        lifecycle_state: "accepted",
        recipient: event.recipient,
        current_responsible_actor: event.recipient,
      };
    case "workfabric.handoff.declined.v1":
      return {
        ...common,
        lifecycle_state: "declined",
        current_responsible_actor: null,
      };
    case "workfabric.handoff.expired.v1":
      return {
        ...common,
        lifecycle_state: "expired",
        current_responsible_actor: null,
      };
    case "workfabric.handoff.cancelled.v1":
      return {
        ...common,
        lifecycle_state: "cancelled",
        current_responsible_actor: null,
      };
    case "workfabric.handoff.status_reported.v1":
      return common;
    case "workfabric.handoff.result_returned.v1":
      return {
        ...common,
        lifecycle_state: "result_returned",
        current_responsible_actor: state.verifier,
        result: event.result,
      };
    case "workfabric.handoff.verified.v1":
      return {
        ...common,
        lifecycle_state: "verified",
        current_responsible_actor: state.verifier,
      };
    case "workfabric.handoff.closed.v1":
      return {
        ...common,
        lifecycle_state: "closed",
        current_responsible_actor: null,
      };
    case "workfabric.handoff.rework_requested.v1":
      return {
        ...common,
        lifecycle_state: "rework_requested",
        current_responsible_actor: state.verifier,
      };
    case "workfabric.handoff.transferred.v1":
      return {
        ...common,
        lifecycle_state: "transferred",
        current_responsible_actor: null,
        child_handoff_id: event.child_handoff_id,
      };
  }
}

export function evolveHandoff(
  state: HandoffState | null,
  event: HandoffEvent,
  streamVersion: number,
): HandoffState {
  requireStreamVersion(state, streamVersion);

  if (state === null) {
    if (event.event_type !== "workfabric.handoff.offered.v1") {
      throw new Error(
        `First Handoff event must be workfabric.handoff.offered.v1, received ${event.event_type}`,
      );
    }

    return {
      handoff_id: event.handoff_id,
      thread_id: event.thread_id,
      resource_version: streamVersion,
      lifecycle_state: "offered",
      initiator: event.initiator,
      recipient: null,
      verifier: event.package.verifier,
      current_responsible_actor: event.initiator,
      package: event.package,
      result: null,
      parent_handoff_id: event.parent_handoff_id,
      child_handoff_id: null,
      created_at: event.occurred_at,
      updated_at: event.occurred_at,
    };
  }

  if (event.handoff_id !== state.handoff_id) {
    throw new Error(
      `Handoff event ID mismatch: expected ${state.handoff_id}, received ${event.handoff_id}`,
    );
  }
  if (TERMINAL_STATES.has(state.lifecycle_state)) {
    throw new Error(`Handoff is terminal in state ${state.lifecycle_state}`);
  }
  if (event.event_type === "workfabric.handoff.offered.v1") {
    throw new Error("Handoff cannot be offered more than once");
  }
  if (!eventAllowedFrom(state.lifecycle_state, event.event_type)) {
    throw new Error(
      `${event.event_type} is not allowed from ${state.lifecycle_state}`,
    );
  }

  return evolveExisting(state, event, streamVersion);
}

export function replayHandoff(
  events: readonly {
    readonly stream_version: number;
    readonly event: HandoffEvent;
  }[],
): HandoffState | null {
  let state: HandoffState | null = null;
  for (const record of events) {
    state = evolveHandoff(state, record.event, record.stream_version);
  }
  return state;
}
