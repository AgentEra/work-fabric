import type {
  ExplicitHandoffTarget,
  JsonObject,
  JsonValue,
} from "@work-fabric/exchange-spi";

import type { HandoffEvent } from "./handoff-events.js";
import type {
  AcceptanceCriterion,
  ActorRef,
  ActorType,
  AuthorityScope,
  HandoffLifecycleState,
  HandoffPackage,
  HandoffState,
  HandoffTarget,
  TargetBinding,
} from "./handoff-types.js";

type UnknownRecord = { readonly [key: string]: unknown };
type InvalidStoredValue = (field: string) => never;

function invalidState(field: string): never {
  throw new Error(`Invalid stored Handoff state: ${field}`);
}

function invalidEvent(field: string): never {
  throw new Error(`Invalid stored Handoff event: ${field}`);
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(
  value: unknown,
  ancestors = new WeakSet<object>(),
): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    const array: readonly unknown[] = value;
    if (ancestors.has(array)) return false;
    ancestors.add(array);
    let valid = true;
    for (let index = 0; index < array.length; index += 1) {
      if (
        !Object.hasOwn(array, index) ||
        !isJsonValue(array[index], ancestors)
      ) {
        valid = false;
        break;
      }
    }
    ancestors.delete(array);
    return valid;
  }
  if (!isUnknownRecord(value) || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Object.values(value).every((item) =>
    isJsonValue(item, ancestors),
  );
  ancestors.delete(value);
  return valid;
}

function isJsonObject(value: unknown): value is JsonObject {
  return isUnknownRecord(value) && isJsonValue(value);
}

function requireRecord(
  value: unknown,
  path: string,
  invalid: InvalidStoredValue,
): UnknownRecord {
  if (!isUnknownRecord(value)) invalid(path);
  return value;
}

function requireOnlyKeys(
  value: UnknownRecord,
  allowedKeys: readonly string[],
  path: string,
  invalid: InvalidStoredValue,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(path.length === 0 ? key : `${path}.${key}`);
  }
}

function requireJsonObject(
  value: unknown,
  path: string,
  invalid: InvalidStoredValue,
): JsonObject {
  if (!isJsonObject(value)) invalid(path);
  return value;
}

function requireArray(
  value: unknown,
  path: string,
  invalid: InvalidStoredValue,
): readonly unknown[] {
  if (!Array.isArray(value)) invalid(path);
  return value;
}

function requireString(
  value: unknown,
  path: string,
  invalid: InvalidStoredValue,
): string {
  if (typeof value !== "string") invalid(path);
  return value;
}

function requireBoolean(
  value: unknown,
  path: string,
  invalid: InvalidStoredValue,
): boolean {
  if (typeof value !== "boolean") invalid(path);
  return value;
}

function requirePositiveInteger(
  value: unknown,
  path: string,
  invalid: InvalidStoredValue,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    invalid(path);
  }
  return value;
}

function requireNullableString(
  value: unknown,
  path: string,
  invalid: InvalidStoredValue,
): string | null {
  if (value === null) return null;
  return requireString(value, path, invalid);
}

function requireStringArray(
  value: unknown,
  path: string,
  invalid: InvalidStoredValue,
): readonly string[] {
  const array = requireArray(value, path, invalid);
  const decoded: string[] = [];
  for (let index = 0; index < array.length; index += 1) {
    if (!Object.hasOwn(array, index)) invalid(`${path}[${index}]`);
    decoded.push(requireString(array[index], `${path}[${index}]`, invalid));
  }
  return decoded;
}

function requireObjectArray(
  value: unknown,
  path: string,
  invalid: InvalidStoredValue,
): readonly JsonObject[] {
  const array = requireArray(value, path, invalid);
  const decoded: JsonObject[] = [];
  for (let index = 0; index < array.length; index += 1) {
    if (!Object.hasOwn(array, index)) invalid(`${path}[${index}]`);
    decoded.push(
      requireJsonObject(array[index], `${path}[${index}]`, invalid),
    );
  }
  return decoded;
}

function decodeActorType(
  value: unknown,
  path: string,
  invalid: InvalidStoredValue,
): ActorType {
  const actorType = requireString(value, path, invalid);
  switch (actorType) {
    case "human":
    case "agent":
    case "system":
      return actorType;
    default:
      return invalid(path);
  }
}

function decodeActor(
  value: unknown,
  path: string,
  invalid: InvalidStoredValue,
): ActorRef {
  const actor = requireRecord(value, path, invalid);
  requireOnlyKeys(actor, ["actor_id", "actor_type"], path, invalid);
  return {
    actor_id: requireString(actor.actor_id, `${path}.actor_id`, invalid),
    actor_type: decodeActorType(actor.actor_type, `${path}.actor_type`, invalid),
  };
}

function decodeNullableActor(
  value: unknown,
  path: string,
  invalid: InvalidStoredValue,
): ActorRef | null {
  if (value === null) return null;
  return decodeActor(value, path, invalid);
}

function decodePriority(
  value: unknown,
  path: string,
  invalid: InvalidStoredValue,
): HandoffPackage["priority"] {
  const priority = requireString(value, path, invalid);
  switch (priority) {
    case "low":
    case "normal":
    case "high":
    case "critical":
      return priority;
    default:
      return invalid(path);
  }
}

function decodeLifecycleState(
  value: unknown,
  path: string,
  invalid: InvalidStoredValue,
): HandoffLifecycleState {
  const lifecycleState = requireString(value, path, invalid);
  switch (lifecycleState) {
    case "target_resolution_pending":
    case "target_unavailable":
    case "offered":
    case "accepted":
    case "result_returned":
    case "verified":
    case "rework_requested":
    case "closed":
    case "declined":
    case "expired":
    case "cancelled":
    case "transferred":
      return lifecycleState;
    default:
      return invalid(path);
  }
}

function decodeExplicitTarget(
  value: unknown,
  path: string,
  invalid: InvalidStoredValue,
): ExplicitHandoffTarget {
  const target = decodeTarget(value, path, invalid);
  if ("capability_requirement" in target) invalid(path);
  return target;
}

function decodeTargetBinding(
  value: unknown,
  path: string,
  invalid: InvalidStoredValue,
): TargetBinding {
  const binding = requireRecord(value, path, invalid);
  requireOnlyKeys(
    binding,
    [
      "target",
      "resolved_by",
      "resolver_endpoint_id",
      "delegation_id",
      "resolved_at",
      "evidence",
    ],
    path,
    invalid,
  );
  return {
    target: decodeExplicitTarget(binding.target, `${path}.target`, invalid),
    resolved_by: decodeActor(
      binding.resolved_by,
      `${path}.resolved_by`,
      invalid,
    ),
    resolver_endpoint_id: requireString(
      binding.resolver_endpoint_id,
      `${path}.resolver_endpoint_id`,
      invalid,
    ),
    delegation_id: requireNullableString(
      binding.delegation_id,
      `${path}.delegation_id`,
      invalid,
    ),
    resolved_at: requireString(
      binding.resolved_at,
      `${path}.resolved_at`,
      invalid,
    ),
    evidence: requireObjectArray(
      binding.evidence,
      `${path}.evidence`,
      invalid,
    ),
  };
}

function decodeNullableTargetBinding(
  value: unknown,
  path: string,
  invalid: InvalidStoredValue,
): TargetBinding | null {
  return value === null ? null : decodeTargetBinding(value, path, invalid);
}

function decodeTarget(
  value: unknown,
  path: string,
  invalid: InvalidStoredValue,
): HandoffTarget {
  const target = requireRecord(value, path, invalid);
  const hasActor = Object.hasOwn(target, "actor_id");
  const hasEndpoint = Object.hasOwn(target, "endpoint_id");
  const hasCapability = Object.hasOwn(target, "capability_requirement");
  const discriminantCount = [hasActor, hasEndpoint, hasCapability].filter(
    Boolean,
  ).length;
  if (discriminantCount !== 1) invalid(path);

  if (hasActor) {
    requireOnlyKeys(target, ["actor_id"], path, invalid);
    return {
      actor_id: requireString(target.actor_id, `${path}.actor_id`, invalid),
    };
  }
  if (hasEndpoint) {
    requireOnlyKeys(target, ["endpoint_id"], path, invalid);
    return {
      endpoint_id: requireString(
        target.endpoint_id,
        `${path}.endpoint_id`,
        invalid,
      ),
    };
  }
  requireOnlyKeys(target, ["capability_requirement"], path, invalid);
  return {
    capability_requirement: requireJsonObject(
      target.capability_requirement,
      `${path}.capability_requirement`,
      invalid,
    ),
  };
}

function decodeContext(
  value: unknown,
  path: string,
  invalid: InvalidStoredValue,
): HandoffPackage["context"] {
  if (value === null) return null;
  const context = requireRecord(value, path, invalid);
  requireOnlyKeys(context, ["context_id", "version", "digest"], path, invalid);
  return {
    context_id: requireString(context.context_id, `${path}.context_id`, invalid),
    version: requirePositiveInteger(context.version, `${path}.version`, invalid),
    digest: requireNullableString(context.digest, `${path}.digest`, invalid),
  };
}

function decodeAuthorityScope(
  value: unknown,
  path: string,
  invalid: InvalidStoredValue,
): AuthorityScope {
  const authority = requireRecord(value, path, invalid);
  requireOnlyKeys(
    authority,
    [
      "delegation_id",
      "scopes",
      "resource_refs",
      "expires_at",
      "may_redelegate",
      "extensions",
    ],
    path,
    invalid,
  );
  const base: AuthorityScope = {
    delegation_id: requireString(
      authority.delegation_id,
      `${path}.delegation_id`,
      invalid,
    ),
    scopes: requireStringArray(authority.scopes, `${path}.scopes`, invalid),
    resource_refs: requireStringArray(
      authority.resource_refs,
      `${path}.resource_refs`,
      invalid,
    ),
    expires_at: requireString(authority.expires_at, `${path}.expires_at`, invalid),
    may_redelegate: requireBoolean(
      authority.may_redelegate,
      `${path}.may_redelegate`,
      invalid,
    ),
  };
  if (!Object.hasOwn(authority, "extensions")) return base;
  return {
    ...base,
    extensions: requireJsonObject(
      authority.extensions,
      `${path}.extensions`,
      invalid,
    ),
  };
}

function decodeAcceptanceCriterion(
  value: unknown,
  path: string,
  invalid: InvalidStoredValue,
): AcceptanceCriterion {
  const criterion = requireRecord(value, path, invalid);
  requireOnlyKeys(
    criterion,
    [
      "criterion_id",
      "description",
      "required",
      "result_schema_ref",
      "required_evidence_types",
      "extensions",
    ],
    path,
    invalid,
  );
  const base: AcceptanceCriterion = {
    criterion_id: requireString(
      criterion.criterion_id,
      `${path}.criterion_id`,
      invalid,
    ),
    description: requireString(
      criterion.description,
      `${path}.description`,
      invalid,
    ),
    required: requireBoolean(criterion.required, `${path}.required`, invalid),
    result_schema_ref: requireNullableString(
      criterion.result_schema_ref,
      `${path}.result_schema_ref`,
      invalid,
    ),
    required_evidence_types: requireStringArray(
      criterion.required_evidence_types,
      `${path}.required_evidence_types`,
      invalid,
    ),
  };
  if (!Object.hasOwn(criterion, "extensions")) return base;
  return {
    ...base,
    extensions: requireJsonObject(
      criterion.extensions,
      `${path}.extensions`,
      invalid,
    ),
  };
}

function decodeAcceptanceCriteria(
  value: unknown,
  path: string,
  invalid: InvalidStoredValue,
): readonly AcceptanceCriterion[] {
  const array = requireArray(value, path, invalid);
  const decoded: AcceptanceCriterion[] = [];
  for (let index = 0; index < array.length; index += 1) {
    if (!Object.hasOwn(array, index)) invalid(`${path}[${index}]`);
    decoded.push(
      decodeAcceptanceCriterion(array[index], `${path}[${index}]`, invalid),
    );
  }
  return decoded;
}

function decodePackage(
  value: unknown,
  path: string,
  invalid: InvalidStoredValue,
): HandoffPackage {
  const handoffPackage = requireRecord(value, path, invalid);
  requireOnlyKeys(
    handoffPackage,
    [
      "work_reference",
      "target",
      "intent",
      "context",
      "authority_scope",
      "acceptance_criteria",
      "verifier",
      "priority",
      "accept_by",
      "result_due_at",
    ],
    path,
    invalid,
  );
  return {
    work_reference: requireJsonObject(
      handoffPackage.work_reference,
      `${path}.work_reference`,
      invalid,
    ),
    target: decodeTarget(handoffPackage.target, `${path}.target`, invalid),
    intent: requireObjectArray(handoffPackage.intent, `${path}.intent`, invalid),
    context: decodeContext(handoffPackage.context, `${path}.context`, invalid),
    authority_scope: decodeAuthorityScope(
      handoffPackage.authority_scope,
      `${path}.authority_scope`,
      invalid,
    ),
    acceptance_criteria: decodeAcceptanceCriteria(
      handoffPackage.acceptance_criteria,
      `${path}.acceptance_criteria`,
      invalid,
    ),
    verifier: decodeActor(handoffPackage.verifier, `${path}.verifier`, invalid),
    priority: decodePriority(handoffPackage.priority, `${path}.priority`, invalid),
    accept_by: requireString(
      handoffPackage.accept_by,
      `${path}.accept_by`,
      invalid,
    ),
    result_due_at: requireString(
      handoffPackage.result_due_at,
      `${path}.result_due_at`,
      invalid,
    ),
  };
}

function actorToJson(actor: ActorRef): JsonObject {
  return {
    actor_id: actor.actor_id,
    actor_type: actor.actor_type,
  };
}

function targetToJson(target: HandoffTarget): JsonObject {
  if ("actor_id" in target) return { actor_id: target.actor_id };
  if ("endpoint_id" in target) return { endpoint_id: target.endpoint_id };
  return { capability_requirement: target.capability_requirement };
}

function targetBindingToJson(binding: TargetBinding): JsonObject {
  return {
    target: targetToJson(binding.target),
    resolved_by: actorToJson(binding.resolved_by),
    resolver_endpoint_id: binding.resolver_endpoint_id,
    delegation_id: binding.delegation_id,
    resolved_at: binding.resolved_at,
    evidence: binding.evidence,
  };
}

function authorityScopeToJson(authority: AuthorityScope): JsonObject {
  const base: JsonObject = {
    delegation_id: authority.delegation_id,
    scopes: authority.scopes,
    resource_refs: authority.resource_refs,
    expires_at: authority.expires_at,
    may_redelegate: authority.may_redelegate,
  };
  return authority.extensions === undefined
    ? base
    : { ...base, extensions: authority.extensions };
}

function acceptanceCriterionToJson(
  criterion: AcceptanceCriterion,
): JsonObject {
  const base: JsonObject = {
    criterion_id: criterion.criterion_id,
    description: criterion.description,
    required: criterion.required,
    result_schema_ref: criterion.result_schema_ref,
    required_evidence_types: criterion.required_evidence_types,
  };
  return criterion.extensions === undefined
    ? base
    : { ...base, extensions: criterion.extensions };
}

function packageToJson(handoffPackage: HandoffPackage): JsonObject {
  return {
    work_reference: handoffPackage.work_reference,
    target: targetToJson(handoffPackage.target),
    intent: handoffPackage.intent,
    context:
      handoffPackage.context === null
        ? null
        : {
            context_id: handoffPackage.context.context_id,
            version: handoffPackage.context.version,
            digest: handoffPackage.context.digest,
          },
    authority_scope: authorityScopeToJson(handoffPackage.authority_scope),
    acceptance_criteria: handoffPackage.acceptance_criteria.map(
      acceptanceCriterionToJson,
    ),
    verifier: actorToJson(handoffPackage.verifier),
    priority: handoffPackage.priority,
    accept_by: handoffPackage.accept_by,
    result_due_at: handoffPackage.result_due_at,
  };
}

export function handoffStateToJson(state: HandoffState): JsonObject {
  return {
    handoff_id: state.handoff_id,
    thread_id: state.thread_id,
    resource_version: state.resource_version,
    lifecycle_state: state.lifecycle_state,
    initiator: actorToJson(state.initiator),
    recipient: state.recipient === null ? null : actorToJson(state.recipient),
    verifier: actorToJson(state.verifier),
    current_responsible_actor:
      state.current_responsible_actor === null
        ? null
        : actorToJson(state.current_responsible_actor),
    target_binding:
      state.target_binding === null
        ? null
        : targetBindingToJson(state.target_binding),
    package: packageToJson(state.package),
    result: state.result,
    parent_handoff_id: state.parent_handoff_id,
    child_handoff_id: state.child_handoff_id,
    created_at: state.created_at,
    updated_at: state.updated_at,
  };
}

export function handoffStateFromJson(value: JsonObject): HandoffState {
  const state = requireRecord(value, "state", invalidState);
  requireOnlyKeys(
    state,
    [
      "handoff_id",
      "thread_id",
      "resource_version",
      "lifecycle_state",
      "initiator",
      "recipient",
      "verifier",
      "current_responsible_actor",
      "target_binding",
      "package",
      "result",
      "parent_handoff_id",
      "child_handoff_id",
      "created_at",
      "updated_at",
    ],
    "",
    invalidState,
  );
  return {
    handoff_id: requireString(state.handoff_id, "handoff_id", invalidState),
    thread_id: requireString(state.thread_id, "thread_id", invalidState),
    resource_version: requirePositiveInteger(
      state.resource_version,
      "resource_version",
      invalidState,
    ),
    lifecycle_state: decodeLifecycleState(
      state.lifecycle_state,
      "lifecycle_state",
      invalidState,
    ),
    initiator: decodeActor(state.initiator, "initiator", invalidState),
    recipient: decodeNullableActor(state.recipient, "recipient", invalidState),
    verifier: decodeActor(state.verifier, "verifier", invalidState),
    current_responsible_actor: decodeNullableActor(
      state.current_responsible_actor,
      "current_responsible_actor",
      invalidState,
    ),
    target_binding: decodeNullableTargetBinding(
      state.target_binding,
      "target_binding",
      invalidState,
    ),
    package: decodePackage(state.package, "package", invalidState),
    result:
      state.result === null
        ? null
        : requireJsonObject(state.result, "result", invalidState),
    parent_handoff_id: requireNullableString(
      state.parent_handoff_id,
      "parent_handoff_id",
      invalidState,
    ),
    child_handoff_id: requireNullableString(
      state.child_handoff_id,
      "child_handoff_id",
      invalidState,
    ),
    created_at: requireString(state.created_at, "created_at", invalidState),
    updated_at: requireString(state.updated_at, "updated_at", invalidState),
  };
}

export function handoffEventToJson(event: HandoffEvent): JsonObject {
  const common: JsonObject = {
    event_type: event.event_type,
    handoff_id: event.handoff_id,
    occurred_at: event.occurred_at,
  };
  switch (event.event_type) {
    case "workfabric.handoff.offered.v1":
    case "workfabric.handoff.target_resolution_requested.v1":
      return {
        ...common,
        thread_id: event.thread_id,
        initiator: actorToJson(event.initiator),
        package: packageToJson(event.package),
        parent_handoff_id: event.parent_handoff_id,
      };
    case "workfabric.handoff.target_resolved.v1":
      return { ...common, binding: targetBindingToJson(event.binding) };
    case "workfabric.handoff.target_unavailable.v1":
      return {
        ...common,
        resolved_by: actorToJson(event.resolved_by),
        resolver_endpoint_id: event.resolver_endpoint_id,
        delegation_id: event.delegation_id,
        reason_code: event.reason_code,
        reason: event.reason,
        evidence: event.evidence,
      };
    case "workfabric.handoff.accepted.v1":
      return { ...common, recipient: actorToJson(event.recipient) };
    case "workfabric.handoff.declined.v1":
    case "workfabric.handoff.expired.v1":
    case "workfabric.handoff.closed.v1":
      return common;
    case "workfabric.handoff.cancelled.v1":
      return { ...common, reason: event.reason };
    case "workfabric.handoff.status_reported.v1":
      return { ...common, status: event.status };
    case "workfabric.handoff.result_returned.v1":
      return { ...common, result: event.result };
    case "workfabric.handoff.verified.v1":
      return {
        ...common,
        satisfied_criterion_ids: event.satisfied_criterion_ids,
        summary: event.summary,
        evidence: event.evidence,
      };
    case "workfabric.handoff.rework_requested.v1":
      return {
        ...common,
        criterion_ids: event.criterion_ids,
        reason: event.reason,
      };
    case "workfabric.handoff.transferred.v1":
      return { ...common, child_handoff_id: event.child_handoff_id };
  }
}

function decodeEventType(
  value: unknown,
): HandoffEvent["event_type"] {
  const eventType = requireString(value, "event_type", invalidEvent);
  switch (eventType) {
    case "workfabric.handoff.offered.v1":
    case "workfabric.handoff.target_resolution_requested.v1":
    case "workfabric.handoff.target_resolved.v1":
    case "workfabric.handoff.target_unavailable.v1":
    case "workfabric.handoff.accepted.v1":
    case "workfabric.handoff.declined.v1":
    case "workfabric.handoff.expired.v1":
    case "workfabric.handoff.cancelled.v1":
    case "workfabric.handoff.status_reported.v1":
    case "workfabric.handoff.result_returned.v1":
    case "workfabric.handoff.verified.v1":
    case "workfabric.handoff.closed.v1":
    case "workfabric.handoff.rework_requested.v1":
    case "workfabric.handoff.transferred.v1":
      return eventType;
    default:
      return invalidEvent("event_type");
  }
}

function eventKeys(eventType: HandoffEvent["event_type"]): readonly string[] {
  const common = ["event_type", "handoff_id", "occurred_at"];
  switch (eventType) {
    case "workfabric.handoff.offered.v1":
    case "workfabric.handoff.target_resolution_requested.v1":
      return [
        ...common,
        "thread_id",
        "initiator",
        "package",
        "parent_handoff_id",
      ];
    case "workfabric.handoff.target_resolved.v1":
      return [...common, "binding"];
    case "workfabric.handoff.target_unavailable.v1":
      return [
        ...common,
        "resolved_by",
        "resolver_endpoint_id",
        "delegation_id",
        "reason_code",
        "reason",
        "evidence",
      ];
    case "workfabric.handoff.accepted.v1":
      return [...common, "recipient"];
    case "workfabric.handoff.declined.v1":
    case "workfabric.handoff.expired.v1":
    case "workfabric.handoff.closed.v1":
      return common;
    case "workfabric.handoff.cancelled.v1":
      return [...common, "reason"];
    case "workfabric.handoff.status_reported.v1":
      return [...common, "status"];
    case "workfabric.handoff.result_returned.v1":
      return [...common, "result"];
    case "workfabric.handoff.verified.v1":
      return [
        ...common,
        "satisfied_criterion_ids",
        "summary",
        "evidence",
      ];
    case "workfabric.handoff.rework_requested.v1":
      return [...common, "criterion_ids", "reason"];
    case "workfabric.handoff.transferred.v1":
      return [...common, "child_handoff_id"];
  }
}

export function handoffEventFromJson(value: JsonObject): HandoffEvent {
  const event = requireRecord(value, "event", invalidEvent);
  const eventType = decodeEventType(event.event_type);
  requireOnlyKeys(event, eventKeys(eventType), "", invalidEvent);
  const handoffId = requireString(event.handoff_id, "handoff_id", invalidEvent);
  const occurredAt = requireString(event.occurred_at, "occurred_at", invalidEvent);

  switch (eventType) {
    case "workfabric.handoff.offered.v1":
    case "workfabric.handoff.target_resolution_requested.v1":
      return {
        event_type: eventType,
        handoff_id: handoffId,
        thread_id: requireString(event.thread_id, "thread_id", invalidEvent),
        initiator: decodeActor(event.initiator, "initiator", invalidEvent),
        package: decodePackage(event.package, "package", invalidEvent),
        parent_handoff_id: requireNullableString(
          event.parent_handoff_id,
          "parent_handoff_id",
          invalidEvent,
        ),
        occurred_at: occurredAt,
      };
    case "workfabric.handoff.target_resolved.v1":
      return {
        event_type: eventType,
        handoff_id: handoffId,
        binding: decodeTargetBinding(event.binding, "binding", invalidEvent),
        occurred_at: occurredAt,
      };
    case "workfabric.handoff.target_unavailable.v1": {
      const reasonCode = requireString(
        event.reason_code,
        "reason_code",
        invalidEvent,
      );
      if (
        reasonCode !== "no_candidate" &&
        reasonCode !== "no_eligible_target" &&
        reasonCode !== "policy_rejected" &&
        reasonCode !== "resolver_unavailable"
      ) {
        invalidEvent("reason_code");
      }
      return {
        event_type: eventType,
        handoff_id: handoffId,
        resolved_by: decodeActor(
          event.resolved_by,
          "resolved_by",
          invalidEvent,
        ),
        resolver_endpoint_id: requireString(
          event.resolver_endpoint_id,
          "resolver_endpoint_id",
          invalidEvent,
        ),
        delegation_id: requireNullableString(
          event.delegation_id,
          "delegation_id",
          invalidEvent,
        ),
        reason_code: reasonCode,
        reason: requireObjectArray(event.reason, "reason", invalidEvent),
        evidence: requireObjectArray(event.evidence, "evidence", invalidEvent),
        occurred_at: occurredAt,
      };
    }
    case "workfabric.handoff.accepted.v1":
      return {
        event_type: eventType,
        handoff_id: handoffId,
        recipient: decodeActor(event.recipient, "recipient", invalidEvent),
        occurred_at: occurredAt,
      };
    case "workfabric.handoff.declined.v1":
    case "workfabric.handoff.expired.v1":
    case "workfabric.handoff.closed.v1":
      return {
        event_type: eventType,
        handoff_id: handoffId,
        occurred_at: occurredAt,
      };
    case "workfabric.handoff.cancelled.v1":
      return {
        event_type: eventType,
        handoff_id: handoffId,
        reason: requireObjectArray(event.reason, "reason", invalidEvent),
        occurred_at: occurredAt,
      };
    case "workfabric.handoff.status_reported.v1":
      return {
        event_type: eventType,
        handoff_id: handoffId,
        status: requireJsonObject(event.status, "status", invalidEvent),
        occurred_at: occurredAt,
      };
    case "workfabric.handoff.result_returned.v1":
      return {
        event_type: eventType,
        handoff_id: handoffId,
        result: requireJsonObject(event.result, "result", invalidEvent),
        occurred_at: occurredAt,
      };
    case "workfabric.handoff.verified.v1":
      return {
        event_type: eventType,
        handoff_id: handoffId,
        satisfied_criterion_ids: requireStringArray(
          event.satisfied_criterion_ids,
          "satisfied_criterion_ids",
          invalidEvent,
        ),
        summary: requireObjectArray(event.summary, "summary", invalidEvent),
        evidence: requireObjectArray(event.evidence, "evidence", invalidEvent),
        occurred_at: occurredAt,
      };
    case "workfabric.handoff.rework_requested.v1":
      return {
        event_type: eventType,
        handoff_id: handoffId,
        criterion_ids: requireStringArray(
          event.criterion_ids,
          "criterion_ids",
          invalidEvent,
        ),
        reason: requireObjectArray(event.reason, "reason", invalidEvent),
        occurred_at: occurredAt,
      };
    case "workfabric.handoff.transferred.v1":
      return {
        event_type: eventType,
        handoff_id: handoffId,
        child_handoff_id: requireString(
          event.child_handoff_id,
          "child_handoff_id",
          invalidEvent,
        ),
        occurred_at: occurredAt,
      };
  }
}
