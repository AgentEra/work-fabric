import type {
  ContextReference,
  JsonObject,
  JsonValue,
  ProposedEvent,
} from "@work-fabric/exchange-spi";

import type { HandoffCommand } from "../domain/handoff-commands.js";
import type { HandoffEvent } from "../domain/handoff-events.js";
import { evolveHandoff } from "../domain/handoff-reducer.js";
import { handoffEventToJson } from "../domain/handoff-state-codec.js";
import type {
  AcceptanceCriterion,
  ActorRef,
  ActorType,
  AuthorityScope,
  HandoffPackage,
  HandoffState,
  HandoffTarget,
} from "../domain/handoff-types.js";
import { canonicalJson } from "./canonical-json.js";
import type { CommandEnvelope } from "./protocol-types.js";

function invalidPayload(field: string): never {
  throw new TypeError(`Invalid validated Handoff Payload field: ${field}`);
}

function object(value: JsonValue | undefined, field: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidPayload(field);
  }
  return value as JsonObject;
}

function string(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string") return invalidPayload(field);
  return value;
}

function boolean(value: JsonValue | undefined, field: string): boolean {
  if (typeof value !== "boolean") return invalidPayload(field);
  return value;
}

function array(value: JsonValue | undefined, field: string): readonly JsonValue[] {
  if (!Array.isArray(value)) return invalidPayload(field);
  return value;
}

function stringArray(
  value: JsonValue | undefined,
  field: string,
): readonly string[] {
  return array(value, field).map((item, index) =>
    string(item, `${field}[${index}]`),
  );
}

function objectArray(
  value: JsonValue | undefined,
  field: string,
): readonly JsonObject[] {
  return array(value, field).map((item, index) =>
    object(item, `${field}[${index}]`),
  );
}

function actorType(value: JsonValue | undefined, field: string): ActorType {
  const decoded = string(value, field);
  if (decoded === "human" || decoded === "agent" || decoded === "system") {
    return decoded;
  }
  return invalidPayload(field);
}

function actorRef(value: JsonValue | undefined, field: string): ActorRef {
  const decoded = object(value, field);
  return {
    actor_id: string(decoded.actor_id, `${field}.actor_id`),
    actor_type: actorType(decoded.actor_type, `${field}.actor_type`),
  };
}

function extensions(
  value: JsonValue | undefined,
  field: string,
): { readonly extensions?: JsonObject } {
  if (value === undefined) return {};
  return { extensions: object(value, field) };
}

function authorityScope(
  value: JsonValue | undefined,
  field: string,
): AuthorityScope {
  const decoded = object(value, field);
  return {
    delegation_id: string(decoded.delegation_id, `${field}.delegation_id`),
    scopes: stringArray(decoded.scopes, `${field}.scopes`),
    resource_refs: stringArray(decoded.resource_refs, `${field}.resource_refs`),
    expires_at: string(decoded.expires_at, `${field}.expires_at`),
    may_redelegate: boolean(decoded.may_redelegate, `${field}.may_redelegate`),
    ...extensions(decoded.extensions, `${field}.extensions`),
  };
}

function acceptanceCriterion(
  value: JsonValue,
  field: string,
): AcceptanceCriterion {
  const decoded = object(value, field);
  const resultSchemaRef = decoded.result_schema_ref;
  if (resultSchemaRef !== null && typeof resultSchemaRef !== "string") {
    return invalidPayload(`${field}.result_schema_ref`);
  }
  return {
    criterion_id: string(decoded.criterion_id, `${field}.criterion_id`),
    description: string(decoded.description, `${field}.description`),
    required: boolean(decoded.required, `${field}.required`),
    result_schema_ref: resultSchemaRef,
    required_evidence_types: stringArray(
      decoded.required_evidence_types,
      `${field}.required_evidence_types`,
    ),
    ...extensions(decoded.extensions, `${field}.extensions`),
  };
}

function target(value: JsonValue | undefined, field: string): HandoffTarget {
  const decoded = object(value, field);
  if (decoded.actor_id !== undefined) {
    return { actor_id: string(decoded.actor_id, `${field}.actor_id`) };
  }
  if (decoded.endpoint_id !== undefined) {
    return { endpoint_id: string(decoded.endpoint_id, `${field}.endpoint_id`) };
  }
  return {
    capability_requirement: object(
      decoded.capability_requirement,
      `${field}.capability_requirement`,
    ),
  };
}

function priority(
  value: JsonValue | undefined,
  field: string,
): HandoffPackage["priority"] {
  const decoded = string(value, field);
  switch (decoded) {
    case "low":
    case "normal":
    case "high":
    case "critical":
      return decoded;
    default:
      return invalidPayload(field);
  }
}

function decodeOfferPackage(
  payload: JsonObject,
  contextReference: ContextReference | null,
): HandoffPackage {
  return {
    work_reference: object(payload.work_reference, "payload.work_reference"),
    target: target(payload.target, "payload.target"),
    intent: objectArray(payload.intent, "payload.intent"),
    context: contextReference,
    authority_scope: authorityScope(
      payload.authority_scope,
      "payload.authority_scope",
    ),
    acceptance_criteria: array(
      payload.acceptance_criteria,
      "payload.acceptance_criteria",
    ).map((criterion, index) =>
      acceptanceCriterion(
        criterion,
        `payload.acceptance_criteria[${index}]`,
      ),
    ),
    verifier: actorRef(payload.verifier, "payload.verifier"),
    priority: priority(payload.priority, "payload.priority"),
    accept_by: string(payload.accept_by, "payload.accept_by"),
    result_due_at: string(payload.result_due_at, "payload.result_due_at"),
  };
}

function handoffId(payload: JsonObject): string {
  return string(payload.handoff_id, "payload.handoff_id");
}

export interface DecodedHandoffTransfer {
  readonly parent_handoff_id: string;
  readonly child_handoff_id: string;
  readonly actor: ActorRef;
  readonly child_package: HandoffPackage;
}

export function decodeHandoffTransfer(
  envelope: CommandEnvelope,
  actor: ActorRef,
  generatedChildHandoffId: string,
  childContextReference: ContextReference | null,
): DecodedHandoffTransfer {
  if (envelope.message_type !== "workfabric.handoff.transfer.v1") {
    throw new Error(
      `Unsupported Handoff Transfer message_type: ${envelope.message_type}`,
    );
  }
  const childOffer = object(
    envelope.payload.child_offer,
    "payload.child_offer",
  );
  return {
    parent_handoff_id: string(
      envelope.payload.parent_handoff_id,
      "payload.parent_handoff_id",
    ),
    child_handoff_id: generatedChildHandoffId,
    actor,
    child_package: decodeOfferPackage(childOffer, childContextReference),
  };
}

export function decodeHandoffCommand(
  envelope: CommandEnvelope,
  actor: ActorRef,
  generatedHandoffId: string,
  contextReference: ContextReference | null,
): HandoffCommand {
  const payload = envelope.payload;
  switch (envelope.message_type) {
    case "workfabric.handoff.offer.v1":
      return {
        kind: "offer",
        handoff_id: generatedHandoffId,
        thread_id:
          payload.thread_id === undefined
            ? generatedHandoffId
            : string(payload.thread_id, "payload.thread_id"),
        actor,
        package: decodeOfferPackage(payload, contextReference),
        parent_handoff_id: null,
      };
    case "workfabric.handoff.accept.v1":
      return { kind: "accept", handoff_id: handoffId(payload), actor };
    case "workfabric.handoff.decline.v1":
      return { kind: "decline", handoff_id: handoffId(payload), actor };
    case "workfabric.handoff.expire.v1":
      return { kind: "expire", handoff_id: handoffId(payload), actor };
    case "workfabric.handoff.cancel.v1":
      return {
        kind: "cancel",
        handoff_id: handoffId(payload),
        actor,
        reason:
          payload.reason === undefined
            ? []
            : objectArray(payload.reason, "payload.reason"),
      };
    case "workfabric.handoff.report_status.v1":
      return {
        kind: "report_status",
        handoff_id: handoffId(payload),
        actor,
        status: object(payload.status, "payload.status"),
      };
    case "workfabric.handoff.return_result.v1":
      return {
        kind: "return_result",
        handoff_id: handoffId(payload),
        actor,
        result: object(payload.result, "payload.result"),
      };
    case "workfabric.handoff.verify.v1":
      return {
        kind: "verify",
        handoff_id: handoffId(payload),
        actor,
        satisfied_criterion_ids: stringArray(
          payload.satisfied_criterion_ids,
          "payload.satisfied_criterion_ids",
        ),
        summary: objectArray(payload.summary, "payload.summary"),
        evidence: objectArray(payload.evidence, "payload.evidence"),
      };
    case "workfabric.handoff.close.v1":
      return { kind: "close", handoff_id: handoffId(payload), actor };
    case "workfabric.handoff.request_rework.v1":
      return {
        kind: "request_rework",
        handoff_id: handoffId(payload),
        actor,
        criterion_ids: stringArray(
          payload.criterion_ids,
          "payload.criterion_ids",
        ),
        reason: objectArray(payload.reason, "payload.reason"),
      };
    case "workfabric.handoff.transfer.v1":
    case "workfabric.handoff.child_accepted.v1":
    default:
      throw new Error(
        `Unsupported single-stream Handoff message_type: ${envelope.message_type}`,
      );
  }
}

export interface EncodeHandoffEventsInput {
  readonly current_state: HandoffState | null;
  readonly events: readonly HandoffEvent[];
  readonly current_stream_version: number;
  readonly envelope: CommandEnvelope;
  readonly event_ids: readonly string[];
  readonly receipt_ids: readonly (string | null)[];
  readonly authorized_endpoint_ids: readonly string[];
  readonly now: string;
}

export interface EncodedHandoffEvents {
  readonly events: readonly ProposedEvent[];
  readonly receipt: JsonObject | null;
}

type ReceiptType =
  | "responsibility_accepted"
  | "result_received"
  | "result_verified";

interface EventProjection {
  readonly change_type: string;
  readonly changed_fields: readonly ChangedField[];
  readonly receipt_type: ReceiptType | null;
}

type StateChangedField =
  | "child_handoff_id"
  | "current_responsible_actor"
  | "lifecycle_state"
  | "package"
  | "recipient"
  | "resource_version"
  | "result"
  | "updated_at";

type ChangedField = StateChangedField | "latest_status";

function projectEvent(event: HandoffEvent): EventProjection {
  switch (event.event_type) {
    case "workfabric.handoff.offered.v1":
      return {
        change_type: "created",
        changed_fields: [
          "current_responsible_actor",
          "lifecycle_state",
          "package",
        ],
        receipt_type: null,
      };
    case "workfabric.handoff.accepted.v1":
      return {
        change_type: "accepted",
        changed_fields: [
          "current_responsible_actor",
          "lifecycle_state",
          "recipient",
        ],
        receipt_type: "responsibility_accepted",
      };
    case "workfabric.handoff.declined.v1":
      return {
        change_type: "declined",
        changed_fields: ["current_responsible_actor", "lifecycle_state"],
        receipt_type: null,
      };
    case "workfabric.handoff.expired.v1":
      return {
        change_type: "expired",
        changed_fields: ["current_responsible_actor", "lifecycle_state"],
        receipt_type: null,
      };
    case "workfabric.handoff.cancelled.v1":
      return {
        change_type: "cancelled",
        changed_fields: ["current_responsible_actor", "lifecycle_state"],
        receipt_type: null,
      };
    case "workfabric.handoff.status_reported.v1":
      return {
        change_type: "status_reported",
        changed_fields: ["latest_status"],
        receipt_type: null,
      };
    case "workfabric.handoff.result_returned.v1":
      return {
        change_type: "result_returned",
        changed_fields: [
          "current_responsible_actor",
          "lifecycle_state",
          "result",
        ],
        receipt_type: "result_received",
      };
    case "workfabric.handoff.verified.v1":
      return {
        change_type: "verified",
        changed_fields: ["lifecycle_state"],
        receipt_type: "result_verified",
      };
    case "workfabric.handoff.closed.v1":
      return {
        change_type: "closed",
        changed_fields: ["current_responsible_actor", "lifecycle_state"],
        receipt_type: null,
      };
    case "workfabric.handoff.rework_requested.v1":
      return {
        change_type: "rework_requested",
        changed_fields: ["current_responsible_actor", "lifecycle_state"],
        receipt_type: null,
      };
    case "workfabric.handoff.transferred.v1":
      return {
        change_type: "transferred",
        changed_fields: [
          "child_handoff_id",
          "current_responsible_actor",
          "lifecycle_state",
        ],
        receipt_type: null,
      };
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function stateFieldChanged(
  before: HandoffState | null,
  after: HandoffState,
  field: StateChangedField,
): boolean {
  if (before === null) return true;
  return canonicalJson(before[field]) !== canonicalJson(after[field]);
}

function changedFields(
  projection: EventProjection,
  before: HandoffState | null,
  after: HandoffState,
): readonly string[] {
  const candidates: readonly ChangedField[] = [
    ...projection.changed_fields,
    "resource_version",
    "updated_at",
  ];
  return candidates.filter(
    (field) =>
      field === "latest_status" || stateFieldChanged(before, after, field),
  );
}

function visibleActorIds(state: HandoffState): readonly string[] {
  return unique([
    state.initiator.actor_id,
    ...(state.recipient === null ? [] : [state.recipient.actor_id]),
    state.verifier.actor_id,
    ...("actor_id" in state.package.target
      ? [state.package.target.actor_id]
      : []),
  ]);
}

function workReferenceUri(state: HandoffState): string | undefined {
  const uri = state.package.work_reference.uri;
  return typeof uri === "string" ? uri : undefined;
}

function capabilityIds(state: HandoffState): readonly string[] {
  if (!("capability_requirement" in state.package.target)) {
    return [];
  }
  const capabilityId =
    state.package.target.capability_requirement.capability_id;
  return typeof capabilityId === "string" ? [capabilityId] : [];
}

function routingDetails(state: HandoffState): JsonObject {
  const uri = workReferenceUri(state);
  const capabilities = capabilityIds(state);
  return {
    ...(uri === undefined ? {} : { work_reference_uri: uri }),
    ...(capabilities.length === 0
      ? {}
      : { capability_ids: capabilities }),
    lifecycle_state: state.lifecycle_state,
  };
}

function receipt(
  receiptId: string,
  receiptType: ReceiptType,
  event: HandoffEvent,
  resourceVersion: number,
  input: EncodeHandoffEventsInput,
): JsonObject {
  return {
    receipt_id: receiptId,
    receipt_type: receiptType,
    handoff_id: event.handoff_id,
    actor_id: input.envelope.actor_id,
    endpoint_id: input.envelope.endpoint_id,
    resource_version: resourceVersion,
    recorded_at: input.now,
  };
}

export function encodeHandoffEvents(
  input: EncodeHandoffEventsInput,
): EncodedHandoffEvents {
  const stateVersion = input.current_state?.resource_version ?? 0;
  if (
    !Number.isInteger(input.current_stream_version) ||
    input.current_stream_version < 0 ||
    input.current_stream_version !== stateVersion
  ) {
    throw new Error(
      `current_stream_version must match current_state: ${input.current_stream_version} !== ${stateVersion}`,
    );
  }
  if (input.event_ids.length !== input.events.length) {
    throw new Error(
      `event_ids count must match events: ${input.event_ids.length} !== ${input.events.length}`,
    );
  }

  if (input.receipt_ids.length !== input.events.length) {
    throw new Error(
      `receipt_ids count must match events: ${input.receipt_ids.length} !== ${input.events.length}`,
    );
  }

  const projections = input.events.map(projectEvent);
  let state = input.current_state;
  let finalReceipt: JsonObject | null = null;
  const proposedEvents = input.events.map((event, eventIndex) => {
    const projection = projections[eventIndex];
    const eventId = input.event_ids[eventIndex];
    if (projection === undefined || eventId === undefined) {
      throw new Error("Missing generated Event metadata");
    }

    const nextStreamVersion = input.current_stream_version + eventIndex + 1;
    const beforeState = state;
    const fromState = beforeState?.lifecycle_state ?? null;
    const nextState = evolveHandoff(beforeState, event, nextStreamVersion);
    const resourceVersion = nextState.resource_version;
    state = nextState;

    const receiptId = input.receipt_ids[eventIndex];
    let receiptSummary: JsonObject | null = null;
    if (projection.receipt_type === null) {
      if (receiptId !== null) {
        throw new Error(
          `Receipt ID must be null for ${projection.change_type} event`,
        );
      }
    } else {
      if (typeof receiptId !== "string") {
        throw new Error(
          `Receipt ID is required for ${projection.change_type} event`,
        );
      }
      receiptSummary = {
        receipt_id: receiptId,
        receipt_type: projection.receipt_type,
      };
      finalReceipt = receipt(
        receiptId,
        projection.receipt_type,
        event,
        resourceVersion,
        input,
      );
    }

    const protocolData: JsonObject = {
      resource_version: resourceVersion,
      change: {
        change_type: projection.change_type,
        from_state: fromState,
        to_state: nextState.lifecycle_state,
        changed_fields: changedFields(projection, beforeState, nextState),
        details: routingDetails(nextState),
      },
      receipt: receiptSummary,
    };

    return {
      event_id: eventId,
      event_type: event.event_type,
      schema_version: "1.0",
      exchange_id: input.envelope.exchange_id,
      request_message_id: input.envelope.message_id,
      idempotency_key: input.envelope.idempotency_key,
      ...(input.envelope.correlation_id === undefined
        ? {}
        : { correlation_id: input.envelope.correlation_id }),
      ...(input.envelope.causation_id === undefined
        ? {}
        : { causation_id: input.envelope.causation_id }),
      thread_id: nextState.thread_id,
      handoff_id: event.handoff_id,
      actor_id: input.envelope.actor_id,
      endpoint_id: input.envelope.endpoint_id,
      visibility: "participants",
      visible_actor_ids: visibleActorIds(nextState),
      visible_endpoint_ids: unique(input.authorized_endpoint_ids),
      occurred_at: event.occurred_at,
      domain_data: handoffEventToJson(event),
      protocol_data: protocolData,
    } satisfies ProposedEvent;
  });

  return { events: proposedEvents, receipt: finalReceipt };
}
