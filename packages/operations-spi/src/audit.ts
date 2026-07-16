import type { ExchangeAdapter } from "@work-fabric/exchange-spi";
import type { CursorPage, ParticipantRef } from "./collaboration.js";

export type AuthorizationDecision = "allowed" | "denied";
export type AuditOutcome =
  | "succeeded"
  | "failed"
  | "conflicted"
  | "not_found";
export type AuditServiceCategory =
  | "http"
  | "projector"
  | "delivery"
  | "connector"
  | "recovery";

export interface AuditRecord {
  readonly tenant_id: string;
  readonly audit_id: string;
  readonly occurred_at: string;
  readonly request_id: string;
  readonly trace_id: string | null;
  readonly principal_id: string;
  readonly represented_actor: ParticipantRef | null;
  readonly represented_endpoint_id: string | null;
  readonly delegation_id: string | null;
  readonly operation: string;
  readonly resource_kind: string;
  readonly resource_id: string;
  readonly authorization_decision: AuthorizationDecision;
  readonly outcome: AuditOutcome;
  readonly reason_code: string | null;
  readonly service_category: AuditServiceCategory;
}

export interface AuditQuery {
  readonly tenant_id: string;
  readonly occurred_from?: string;
  readonly occurred_to?: string;
  readonly principal_id?: string;
  readonly operation?: string;
  readonly outcome?: AuditOutcome;
  readonly cursor?: string;
  readonly limit: number;
}

export interface AuditStore extends ExchangeAdapter {
  append(record: AuditRecord): Promise<void>;
  list(query: AuditQuery): Promise<CursorPage<AuditRecord>>;
  pruneBefore(tenantId: string, occurredBefore: string, limit: number): Promise<number>;
}

function boundedIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) ||
    /(?:bearer|authorization|token|secret|password)/i.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function nullableIdentifier(value: unknown, field: string): string | null {
  return value === null ? null : boundedIdentifier(value, field);
}

function participant(value: ParticipantRef | null): ParticipantRef | null {
  if (value === null) return null;
  if (
    value.actor_type !== "human" &&
    value.actor_type !== "agent" &&
    value.actor_type !== "system"
  ) {
    throw new TypeError("represented_actor.actor_type is invalid");
  }
  return {
    actor_id: boundedIdentifier(value.actor_id, "represented_actor.actor_id"),
    actor_type: value.actor_type,
  };
}

export function validateAuditRecord(input: AuditRecord): AuditRecord {
  if (!Number.isFinite(Date.parse(input.occurred_at))) {
    throw new TypeError("occurred_at is invalid");
  }
  if (
    input.authorization_decision !== "allowed" &&
    input.authorization_decision !== "denied"
  ) {
    throw new TypeError("authorization_decision is invalid");
  }
  if (
    input.outcome !== "succeeded" &&
    input.outcome !== "failed" &&
    input.outcome !== "conflicted" &&
    input.outcome !== "not_found"
  ) {
    throw new TypeError("outcome is invalid");
  }
  if (
    input.service_category !== "http" &&
    input.service_category !== "projector" &&
    input.service_category !== "delivery" &&
    input.service_category !== "connector" &&
    input.service_category !== "recovery"
  ) {
    throw new TypeError("service_category is invalid");
  }
  return structuredClone({
    tenant_id: boundedIdentifier(input.tenant_id, "tenant_id"),
    audit_id: boundedIdentifier(input.audit_id, "audit_id"),
    occurred_at: input.occurred_at,
    request_id: boundedIdentifier(input.request_id, "request_id"),
    trace_id: nullableIdentifier(input.trace_id, "trace_id"),
    principal_id: boundedIdentifier(input.principal_id, "principal_id"),
    represented_actor: participant(input.represented_actor),
    represented_endpoint_id: nullableIdentifier(
      input.represented_endpoint_id,
      "represented_endpoint_id",
    ),
    delegation_id: nullableIdentifier(input.delegation_id, "delegation_id"),
    operation: boundedIdentifier(input.operation, "operation"),
    resource_kind: boundedIdentifier(input.resource_kind, "resource_kind"),
    resource_id: boundedIdentifier(input.resource_id, "resource_id"),
    authorization_decision: input.authorization_decision,
    outcome: input.outcome,
    reason_code: nullableIdentifier(input.reason_code, "reason_code"),
    service_category: input.service_category,
  });
}
