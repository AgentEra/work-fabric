import type { AgentRoleProfile, RuntimeJsonObject, RuntimeTaskPackage } from "@work-fabric/agent-runtime-spi";
import type { HandoffEventQuery, HandoffReadModel, ProtocolEvent, RequestOptions } from "@work-fabric/sdk-typescript";

import { invalid } from "./errors.js";
import { compareRfc3339, normalizeRfc3339, parseRfc3339 } from "./rfc3339.js";
import { cloneFrozenJson } from "./safe-json.js";

export interface RuntimeHandoffQueries {
  getHandoff(id: string, options?: RequestOptions): Promise<HandoffReadModel>;
  listHandoffEvents(id: string, options?: HandoffEventQuery): Promise<readonly ProtocolEvent[]>;
}

export interface LoadedRuntimeHandoff {
  readonly snapshot: HandoffReadModel;
  readonly events: readonly ProtocolEvent[];
  readonly task: RuntimeTaskPackage;
}

type JsonRecord = Record<string, unknown>;

const STATE_FIELDS = ["handoff_id", "thread_id", "resource_version", "lifecycle_state", "initiator", "recipient", "verifier", "current_responsible_actor", "target_binding", "package", "result", "parent_handoff_id", "child_handoff_id", "created_at", "updated_at"] as const;
const PACKAGE_FIELDS = ["work_reference", "target", "intent", "context", "authority_scope", "acceptance_criteria", "verifier", "priority", "accept_by", "result_due_at"] as const;
const LIFECYCLES = new Set(["target_resolution_pending", "target_unavailable", "offered", "accepted", "result_returned", "verified", "rework_requested", "closed", "declined", "expired", "cancelled", "transferred"]);
const EVENT_PAGE_LIMIT = 100;

function record(value: unknown, path: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid("invalid_snapshot", path);
  return value as JsonRecord;
}

function exact(value: JsonRecord, fields: readonly string[], path: string): void {
  if (Object.keys(value).length !== fields.length || Object.keys(value).some((key) => !fields.includes(key))) invalid("invalid_snapshot", path);
}

function id(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || value.trim() !== value) invalid("invalid_snapshot", path);
  return value;
}

function timestamp(value: unknown, path: string, now: string): string {
  const parsed = parseRfc3339(value, path, "expired_timestamp");
  const parsedNow = parseRfc3339(now, "now", "expired_timestamp");
  if (compareRfc3339(parsed, parsedNow) <= 0) invalid("expired_timestamp", path);
  return parsed.canonical;
}

function jsonObject(value: unknown, path: string): RuntimeJsonObject {
  const item = record(value, path);
  try { structuredClone(item); } catch { invalid("invalid_snapshot", path); }
  return item as RuntimeJsonObject;
}

function objectArray(value: unknown, path: string, maximum: number): readonly RuntimeJsonObject[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "object" || item === null || Array.isArray(item))) invalid("invalid_snapshot", path);
  return value.map((item, index) => jsonObject(item, `${path}.${index}`));
}

function target(value: unknown, path: string): JsonRecord {
  const item = record(value, path);
  const keys = Object.keys(item);
  if (keys.length !== 1 || !["actor_id", "endpoint_id", "capability_requirement"].includes(keys[0]!)) invalid("invalid_snapshot", path);
  if (keys[0] === "actor_id" || keys[0] === "endpoint_id") id(item[keys[0]!], `${path}.${keys[0]}`);
  else capabilityRequirement(item.capability_requirement, `${path}.capability_requirement`);
  return item;
}

function capabilityRequirement(value: unknown, path: string): void {
  const item = record(value, path);
  const allowed = ["capability_id", "version_constraint", "input_media_types", "output_media_types", "constraints", "extensions"];
  if (!Object.hasOwn(item, "capability_id") || Object.keys(item).some((key) => !allowed.includes(key))) invalid("invalid_snapshot", path);
  const capabilityId = id(item.capability_id, `${path}.capability_id`);
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(capabilityId)) invalid("invalid_snapshot", `${path}.capability_id`);
  if (item.version_constraint !== undefined && (typeof item.version_constraint !== "string" || item.version_constraint.length === 0 || item.version_constraint.length > 256)) invalid("invalid_snapshot", `${path}.version_constraint`);
  for (const field of ["input_media_types", "output_media_types"] as const) {
    const media = item[field];
    if (media !== undefined && (!Array.isArray(media) || new Set(media).size !== media.length || media.some((entry) => typeof entry !== "string" || entry.length > 255 || !/^[^/\s]+\/[^/\s]+$/.test(entry)))) invalid("invalid_snapshot", `${path}.${field}`);
  }
  if (item.constraints !== undefined) jsonObject(item.constraints, `${path}.constraints`);
  if (item.extensions !== undefined) jsonObject(item.extensions, `${path}.extensions`);
}

function actor(value: unknown, path: string): void {
  const item = record(value, path); exact(item, ["actor_id", "actor_type"], path); id(item.actor_id, `${path}.actor_id`);
  if (item.actor_type !== "human" && item.actor_type !== "agent" && item.actor_type !== "system") invalid("invalid_snapshot", `${path}.actor_type`);
}

function context(value: unknown, path: string): RuntimeJsonObject | null {
  if (value === null) return null;
  const item = record(value, path); exact(item, ["context_id", "version", "digest"], path);
  id(item.context_id, `${path}.context_id`);
  if (!Number.isSafeInteger(item.version) || (item.version as number) < 1) invalid("invalid_snapshot", `${path}.version`);
  if (item.digest !== null && (typeof item.digest !== "string" || item.digest.length === 0 || item.digest.length > 512)) invalid("invalid_snapshot", `${path}.digest`);
  return item as RuntimeJsonObject;
}

function authority(value: unknown, path: string, now: string): RuntimeJsonObject {
  const item = record(value, path);
  const allowed = ["delegation_id", "scopes", "resource_refs", "expires_at", "may_redelegate", "extensions"];
  if (Object.keys(item).some((key) => !allowed.includes(key)) || !["delegation_id", "scopes", "resource_refs", "expires_at", "may_redelegate"].every((key) => Object.hasOwn(item, key))) invalid("invalid_snapshot", path);
  id(item.delegation_id, `${path}.delegation_id`);
  if (!Array.isArray(item.scopes) || item.scopes.length === 0 || item.scopes.length > 64 || item.scopes.some((item) => typeof item !== "string" || item.length === 0)) invalid("invalid_snapshot", `${path}.scopes`);
  if (!Array.isArray(item.resource_refs) || item.resource_refs.length > 128 || item.resource_refs.some((item) => typeof item !== "string" || item.length === 0)) invalid("invalid_snapshot", `${path}.resource_refs`);
  timestamp(item.expires_at, `${path}.expires_at`, now);
  if (typeof item.may_redelegate !== "boolean") invalid("invalid_snapshot", `${path}.may_redelegate`);
  if (Object.hasOwn(item, "extensions")) jsonObject(item.extensions, `${path}.extensions`);
  return item as RuntimeJsonObject;
}

function criteria(value: unknown, path: string): readonly RuntimeJsonObject[] {
  const result = objectArray(value, path, 128);
  for (let index = 0; index < result.length; index += 1) {
    const item = record(result[index], `${path}.${index}`);
    const allowed = ["criterion_id", "description", "required", "result_schema_ref", "required_evidence_types", "extensions"];
    if (Object.keys(item).some((key) => !allowed.includes(key)) || !["criterion_id", "description", "required", "result_schema_ref", "required_evidence_types"].every((key) => Object.hasOwn(item, key))) invalid("invalid_snapshot", `${path}.${index}`);
    id(item.criterion_id, `${path}.${index}.criterion_id`);
    if (typeof item.description !== "string" || typeof item.required !== "boolean" || (item.result_schema_ref !== null && typeof item.result_schema_ref !== "string") || !Array.isArray(item.required_evidence_types) || item.required_evidence_types.some((type) => typeof type !== "string")) invalid("invalid_snapshot", `${path}.${index}`);
  }
  return result;
}

export class HandoffPackageLoader {
  constructor(private readonly queries: RuntimeHandoffQueries, private readonly tenantId: string, private readonly role: AgentRoleProfile, private readonly now: () => string = () => new Date().toISOString()) {}

  async load(handoffId: string, workspacePath: string, signal?: AbortSignal): Promise<LoadedRuntimeHandoff> {
    id(handoffId, "handoff_id");
    if (typeof workspacePath !== "string" || workspacePath.length === 0) invalid("invalid_workspace_path", "workspace_path");
    const snapshot = cloneFrozenJson(await this.queries.getHandoff(handoffId, signal === undefined ? {} : { signal }), "snapshot");
    if (snapshot.tenant_id !== this.tenantId || snapshot.handoff_id !== handoffId || !Number.isSafeInteger(snapshot.stream_version) || snapshot.stream_version < 1) invalid("snapshot_identity_mismatch", "snapshot");
    const state = record(snapshot.state, "state"); exact(state, STATE_FIELDS, "state");
    if (state.handoff_id !== handoffId || state.resource_version !== snapshot.stream_version) invalid("snapshot_version_mismatch", "state");
    const threadId = id(state.thread_id, "state.thread_id");
    if (typeof state.lifecycle_state !== "string" || !LIFECYCLES.has(state.lifecycle_state)) invalid("unsupported_lifecycle", "state.lifecycle_state");
    normalizeRfc3339(state.created_at, "state.created_at", "invalid_snapshot"); normalizeRfc3339(state.updated_at, "state.updated_at", "invalid_snapshot");
    actor(state.initiator, "state.initiator"); actor(state.verifier, "state.verifier");
    if (state.recipient !== null) actor(state.recipient, "state.recipient");
    if (state.current_responsible_actor !== null) actor(state.current_responsible_actor, "state.current_responsible_actor");
    if (state.target_binding !== null) {
      const binding = record(state.target_binding, "state.target_binding");
      exact(binding, ["target", "resolved_by", "resolver_endpoint_id", "delegation_id", "resolved_at", "evidence"], "state.target_binding");
      target(binding.target, "state.target_binding.target");
      actor(binding.resolved_by, "state.target_binding.resolved_by");
      id(binding.resolver_endpoint_id, "state.target_binding.resolver_endpoint_id");
      if (binding.delegation_id !== null) id(binding.delegation_id, "state.target_binding.delegation_id");
      normalizeRfc3339(binding.resolved_at, "state.target_binding.resolved_at", "invalid_snapshot");
      objectArray(binding.evidence, "state.target_binding.evidence", 128);
    }
    const handoffPackage = record(state.package, "state.package"); exact(handoffPackage, PACKAGE_FIELDS, "state.package");
    target(handoffPackage.target, "state.package.target");
    jsonObject(handoffPackage.work_reference, "state.package.work_reference");
    const intent = objectArray(handoffPackage.intent, "state.package.intent", 128);
    const contextReference = context(handoffPackage.context, "state.package.context");
    const authorityScope = authority(handoffPackage.authority_scope, "state.package.authority_scope", this.now());
    const acceptanceCriteria = criteria(handoffPackage.acceptance_criteria, "state.package.acceptance_criteria");
    actor(handoffPackage.verifier, "state.package.verifier");
    if (handoffPackage.priority !== "low" && handoffPackage.priority !== "normal" && handoffPackage.priority !== "high" && handoffPackage.priority !== "critical") invalid("invalid_snapshot", "state.package.priority");
    const acceptBy = timestamp(handoffPackage.accept_by, "state.package.accept_by", this.now());
    const resultDueAt = timestamp(handoffPackage.result_due_at, "state.package.result_due_at", this.now());
    const events = await this.readEvents(handoffId, snapshot.stream_version, signal);
    const task = cloneFrozenJson({ tenant_id: this.tenantId, handoff_id: handoffId, thread_id: threadId, stream_version: snapshot.stream_version, role: this.role, capability_id: this.capabilityId(handoffPackage.target), intent, context_reference: contextReference, authority_scope: authorityScope, acceptance_criteria: acceptanceCriteria, priority: handoffPackage.priority, accept_by: acceptBy, result_due_at: resultDueAt, workspace_path: workspacePath }, "task") as RuntimeTaskPackage;
    return Object.freeze({ snapshot, events, task });
  }

  private capabilityId(value: unknown): string | null {
    const item = record(value, "state.package.target");
    const requirement = objectOrNull(item.capability_requirement);
    return requirement !== null && typeof requirement.capability_id === "string" ? requirement.capability_id : null;
  }

  private async readEvents(handoffId: string, streamVersion: number, signal?: AbortSignal): Promise<readonly ProtocolEvent[]> {
    const events: ProtocolEvent[] = [];
    let fromVersion = 1;
    while (fromVersion <= streamVersion) {
      const page = cloneFrozenJson(await this.queries.listHandoffEvents(handoffId, signal === undefined ? { fromVersion, limit: EVENT_PAGE_LIMIT } : { fromVersion, limit: EVENT_PAGE_LIMIT, signal }), "events") as readonly ProtocolEvent[];
      if (page.length === 0 || page.length > EVENT_PAGE_LIMIT || events.length + page.length > 4_096) invalid("event_sequence", "events");
      for (const event of page) {
        if (event.wftenant !== this.tenantId || event.wfhandoff !== handoffId || event.wfsequence !== fromVersion) invalid("event_sequence", "events");
        events.push(event); fromVersion += 1;
      }
    }
    if (events.length === 0 || events.at(-1)?.wfsequence !== streamVersion) invalid("event_sequence", "events");
    return Object.freeze(events);
  }
}

function objectOrNull(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : null;
}
