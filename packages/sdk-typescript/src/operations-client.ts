import type { RepresentationContext } from "./config.js";
import { assertSafeOperationsJson } from "@work-fabric/operations-spi";
import type { JsonObject } from "@work-fabric/exchange-spi";
import {
  decodeObject,
  decodeObjectArrayProperty,
  identifier,
  positive,
  type RequestOptions,
} from "./query-client.js";
import type {
  DeliveryAttempt,
  AuditRecord,
  ConnectorDiscrepancyView,
  ConnectorIngressOperationalView,
  DeadLetterView,
  DeliveryAttemptView,
  DeliveryOperationalState,
  OperationalPage,
  ProjectionFailureView,
  ProjectionOperationalStatus,
  RecoveryRequestRecord,
  RecoveryTarget,
  SubmitRecoveryResult,
  ProjectionFailureRecord,
  RuntimeSubscription,
} from "./protocol-types.js";
import type { SdkTransport } from "./transport.js";

export interface PageOptions extends RequestOptions { readonly limit?: number }
export interface ProjectionFailureQuery extends PageOptions { readonly projectorId: string; readonly partitionId: string }
export interface DeliveryAttemptQuery extends PageOptions { readonly subscriptionId: string; readonly eventId: string }
export interface DeliveryPositionQuery extends RequestOptions { readonly subscriptionId: string; readonly partitionId: string }
export interface OperationalPageOptions extends PageOptions { readonly cursor?: string }
export interface ProjectionStatusQuery extends RequestOptions { readonly projectorId: string; readonly partitionId: string }
export interface DeliveryStateQuery extends RequestOptions { readonly subscriptionId: string; readonly partitionId: string }
export interface DeadLetterQuery extends OperationalPageOptions { readonly subscriptionId: string; readonly eventId?: string }
export interface ConnectorIngressQuery extends OperationalPageOptions { readonly connectorId: string; readonly states?: readonly ConnectorIngressOperationalView["state"][] }
export interface ConnectorIngressGet extends RequestOptions { readonly connectorId: string; readonly ingressId: string }
export interface DiscrepancyQuery extends OperationalPageOptions { readonly connectorId?: string; readonly statuses?: readonly ConnectorDiscrepancyView["status"][] }
export interface DiscrepancyGet extends RequestOptions { readonly connectorId: string; readonly discrepancyId: string }
export interface RecoveryRequestOptions extends RequestOptions { readonly idempotencyKey: string; readonly target: RecoveryTarget; readonly expectedVersion: number; readonly reason: string }
export interface AuditQueryOptions extends OperationalPageOptions {
  readonly occurredFrom?: string;
  readonly occurredTo?: string;
  readonly principalId?: string;
  readonly operation?: string;
  readonly outcome?: AuditRecord["outcome"];
}
export interface DependencyHealth { readonly dependency_id: string; readonly status: "healthy" | "unhealthy"; readonly observed_at: string; readonly latency_ms: number }
export interface HealthReport { readonly status: "ready" | "not_ready"; readonly dependencies: readonly DependencyHealth[] }
export interface LivenessReport { readonly status: "live" }
export interface ReadinessReport { readonly status: "ready" | "not_ready" }

function decodeHealth(value: unknown): HealthReport {
  const report = decodeObject<Record<string, unknown>>(value);
  if (
    (report.status !== "ready" && report.status !== "not_ready") ||
    !Array.isArray(report.dependencies)
  ) {
    throw new TypeError("HealthReport is invalid");
  }
  return report as unknown as HealthReport;
}

function decodeLiveness(value: unknown): LivenessReport {
  const report = decodeObject<Record<string, unknown>>(value);
  if (report.status !== "live") throw new TypeError("LivenessReport is invalid");
  return report as unknown as LivenessReport;
}

function decodeReadiness(value: unknown): ReadinessReport {
  const report = decodeObject<Record<string, unknown>>(value);
  if (report.status !== "ready" && report.status !== "not_ready") {
    throw new TypeError("ReadinessReport is invalid");
  }
  return report as unknown as ReadinessReport;
}

function requestOptions(representation: RepresentationContext, options: RequestOptions) {
  return {
    representation: options.representation ?? representation,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function safeObject(value: unknown, label: string): Record<string, unknown> {
  const candidate = decodeObject<Record<string, unknown>>(value);
  assertSafeOperationsJson(candidate as JsonObject, label);
  return candidate;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 255) {
    throw new TypeError(`${field} is invalid`);
  }
  return candidate;
}

function nullableString(value: Record<string, unknown>, field: string): string | null {
  return value[field] === null ? null : stringField(value, field);
}

function integerField(value: Record<string, unknown>, field: string, minimum = 0): number {
  const candidate = value[field];
  if (!Number.isSafeInteger(candidate) || (candidate as number) < minimum) {
    throw new TypeError(`${field} is invalid`);
  }
  return candidate as number;
}

function timestampField(value: Record<string, unknown>, field: string): string {
  const candidate = stringField(value, field);
  if (!Number.isFinite(Date.parse(candidate))) throw new TypeError(`${field} is invalid`);
  return candidate;
}

function nullableTimestamp(value: Record<string, unknown>, field: string): string | null {
  return value[field] === null ? null : timestampField(value, field);
}

function pageCursor(value: string | undefined): string | undefined {
  if (value !== undefined && (
    value.length === 0 || value.length > 2048 || value.trim() !== value
  )) throw new TypeError("cursor is invalid");
  return value;
}

function recoveryReason(value: string): string {
  const result = identifier(value, "reason");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(result) ||
    /(?:bearer|token|secret|password|credential)/i.test(result)
  ) throw new TypeError("reason is invalid");
  return result;
}

function selected<T extends string>(
  values: readonly T[] | undefined,
  allowed: readonly T[],
  field: string,
): readonly T[] | undefined {
  if (values === undefined) return undefined;
  if (values.length === 0 || values.length > 16 || values.some((value) => !allowed.includes(value))) {
    throw new TypeError(`${field} is invalid`);
  }
  return [...new Set(values)];
}

function decodePage<T>(value: unknown, decoder: (input: unknown) => T): OperationalPage<T> {
  const candidate = safeObject(value, "operations page");
  if (!Array.isArray(candidate.items)) throw new TypeError("operations page items are invalid");
  const next = candidate.next_cursor;
  if (next !== null && typeof next !== "string") throw new TypeError("operations cursor is invalid");
  return {
    items: candidate.items.map(decoder),
    next_cursor: next,
  };
}

function projectionStatus(value: unknown): ProjectionOperationalStatus {
  const candidate = safeObject(value, "projection status");
  const state = candidate.state;
  if (state !== "current" && state !== "lagging") throw new TypeError("projection state is invalid");
  return {
    tenant_id: stringField(candidate, "tenant_id"),
    projector_id: stringField(candidate, "projector_id"),
    partition_id: stringField(candidate, "partition_id"),
    checkpoint_position: integerField(candidate, "checkpoint_position"),
    journal_position: integerField(candidate, "journal_position"),
    lag: integerField(candidate, "lag"),
    state,
  };
}

function projectionFailure(value: unknown): ProjectionFailureView {
  const candidate = safeObject(value, "projection failure");
  if (candidate.reason_code !== "projection_failed") throw new TypeError("projection reason is invalid");
  return {
    projector_id: stringField(candidate, "projector_id"),
    partition_id: stringField(candidate, "partition_id"),
    event_id: stringField(candidate, "event_id"),
    position: integerField(candidate, "position", 1),
    reason_code: "projection_failed",
    recorded_at: timestampField(candidate, "recorded_at"),
  };
}

function activeDelivery(value: unknown): DeliveryOperationalState["active_delivery"] {
  if (value === null) return null;
  const candidate = safeObject(value, "active delivery");
  const outcome = candidate.outcome;
  if (!["pending", "acknowledged", "retry", "rejected", "expired"].includes(outcome as string)) {
    throw new TypeError("active delivery outcome is invalid");
  }
  return {
    delivery_id: stringField(candidate, "delivery_id"),
    from_position: integerField(candidate, "from_position"),
    to_position: integerField(candidate, "to_position", 1),
    attempt: integerField(candidate, "attempt", 1),
    delivered_at: timestampField(candidate, "delivered_at"),
    visibility_expires_at: timestampField(candidate, "visibility_expires_at"),
    outcome: outcome as NonNullable<DeliveryOperationalState["active_delivery"]>["outcome"],
  };
}

function deliveryState(value: unknown): DeliveryOperationalState {
  const candidate = safeObject(value, "delivery state");
  return {
    tenant_id: stringField(candidate, "tenant_id"),
    subscription_id: stringField(candidate, "subscription_id"),
    partition_id: stringField(candidate, "partition_id"),
    position: integerField(candidate, "position"),
    active_delivery: activeDelivery(candidate.active_delivery),
  };
}

function deliveryAttempt(value: unknown): DeliveryAttemptView {
  const candidate = safeObject(value, "delivery attempt");
  const outcome = candidate.outcome;
  if (outcome !== "accepted" && outcome !== "retryable_failure" && outcome !== "permanent_failure") {
    throw new TypeError("delivery attempt outcome is invalid");
  }
  return {
    subscription_id: stringField(candidate, "subscription_id"),
    partition_id: stringField(candidate, "partition_id"),
    event_id: stringField(candidate, "event_id"),
    attempt: integerField(candidate, "attempt", 1),
    attempted_at: timestampField(candidate, "attempted_at"),
    outcome,
    next_attempt_at: nullableTimestamp(candidate, "next_attempt_at"),
  };
}

function deadLetter(value: unknown): DeadLetterView {
  const candidate = safeObject(value, "dead letter");
  if (candidate.reason_code !== "delivery_dead_letter") throw new TypeError("dead letter reason is invalid");
  return {
    subscription_id: stringField(candidate, "subscription_id"),
    partition_id: stringField(candidate, "partition_id"),
    event_id: stringField(candidate, "event_id"),
    event_type: stringField(candidate, "event_type"),
    partition_position: integerField(candidate, "partition_position", 1),
    handoff_id: stringField(candidate, "handoff_id"),
    thread_id: stringField(candidate, "thread_id"),
    attempts: integerField(candidate, "attempts", 1),
    reason_code: "delivery_dead_letter",
    recorded_at: timestampField(candidate, "recorded_at"),
  };
}

const ingressStates = ["pending", "processing", "retry_wait", "completed", "dead_letter"] as const;
function connectorIngress(value: unknown): ConnectorIngressOperationalView {
  const candidate = safeObject(value, "connector ingress");
  const state = candidate.state;
  if (!ingressStates.includes(state as (typeof ingressStates)[number])) throw new TypeError("connector ingress state is invalid");
  return {
    tenant_id: stringField(candidate, "tenant_id"),
    connector_id: stringField(candidate, "connector_id"),
    ingress_id: stringField(candidate, "ingress_id"),
    source_system: stringField(candidate, "source_system"),
    external_event_id: stringField(candidate, "external_event_id"),
    event_type: stringField(candidate, "event_type"),
    state: state as ConnectorIngressOperationalView["state"],
    attempt: integerField(candidate, "attempt"),
    available_at: timestampField(candidate, "available_at"),
    accepted_at: timestampField(candidate, "accepted_at"),
    updated_at: timestampField(candidate, "updated_at"),
    completed_at: nullableTimestamp(candidate, "completed_at"),
    last_error_code: nullableString(candidate, "last_error_code"),
    last_requeued_at: nullableTimestamp(candidate, "last_requeued_at"),
  };
}

function discrepancy(value: unknown): ConnectorDiscrepancyView {
  const candidate = safeObject(value, "connector discrepancy");
  const status = candidate.status;
  if (status !== "open" && status !== "acknowledged") throw new TypeError("discrepancy status is invalid");
  const expectedVersion = candidate.expected_version;
  if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 1)) {
    throw new TypeError("expected_version is invalid");
  }
  return {
    discrepancy_id: stringField(candidate, "discrepancy_id"),
    tenant_id: stringField(candidate, "tenant_id"),
    connector_id: stringField(candidate, "connector_id"),
    external_object_id: stringField(candidate, "external_object_id"),
    resource_id: nullableString(candidate, "resource_id"),
    expected_state: nullableString(candidate, "expected_state"),
    expected_version: expectedVersion as number | null,
    observed_state: stringField(candidate, "observed_state"),
    observed_at: timestampField(candidate, "observed_at"),
    status,
    version: integerField(candidate, "version", 1),
    acknowledged_at: nullableTimestamp(candidate, "acknowledged_at"),
    acknowledged_by: nullableString(candidate, "acknowledged_by"),
  };
}

function recoveryTarget(value: unknown): RecoveryTarget {
  const candidate = safeObject(value, "recovery target");
  switch (candidate.kind) {
    case "connector_requeue": return {
      kind: candidate.kind,
      connector_id: stringField(candidate, "connector_id"),
      ingress_id: stringField(candidate, "ingress_id"),
      available_at: timestampField(candidate, "available_at"),
    };
    case "delivery_replay": return {
      kind: candidate.kind,
      subscription_id: stringField(candidate, "subscription_id"),
      partition_id: stringField(candidate, "partition_id"),
      event_id: stringField(candidate, "event_id"),
    };
    case "projection_rebuild": return {
      kind: candidate.kind,
      projector_id: stringField(candidate, "projector_id"),
      partition_id: stringField(candidate, "partition_id"),
    };
    case "discrepancy_acknowledge": return {
      kind: candidate.kind,
      discrepancy_id: stringField(candidate, "discrepancy_id"),
    };
    default: throw new TypeError("recovery target kind is invalid");
  }
}

function recoveryRecord(value: unknown): RecoveryRequestRecord {
  const candidate = safeObject(value, "recovery record");
  const state = candidate.state;
  if (state !== "pending" && state !== "processing" && state !== "completed" && state !== "failed") {
    throw new TypeError("recovery state is invalid");
  }
  return {
    tenant_id: stringField(candidate, "tenant_id"),
    recovery_id: stringField(candidate, "recovery_id"),
    idempotency_key: stringField(candidate, "idempotency_key"),
    requested_by: stringField(candidate, "requested_by"),
    requested_at: timestampField(candidate, "requested_at"),
    target: recoveryTarget(candidate.target),
    expected_version: integerField(candidate, "expected_version"),
    reason: stringField(candidate, "reason"),
    state,
    version: integerField(candidate, "version", 1),
    attempt: integerField(candidate, "attempt"),
    outcome_code: nullableString(candidate, "outcome_code"),
    completed_at: nullableTimestamp(candidate, "completed_at"),
  };
}

function recoveryResult(value: unknown): SubmitRecoveryResult {
  const candidate = safeObject(value, "recovery result");
  if (candidate.kind === "conflict") {
    return { kind: candidate.kind, recovery_id: stringField(candidate, "recovery_id") };
  }
  if (candidate.kind !== "accepted" && candidate.kind !== "replayed") {
    throw new TypeError("recovery result kind is invalid");
  }
  return { kind: candidate.kind, recovery: recoveryRecord(candidate.recovery) };
}

function auditRecord(value: unknown): AuditRecord {
  const candidate = safeObject(value, "audit record");
  const decision = candidate.authorization_decision;
  const outcome = candidate.outcome;
  const category = candidate.service_category;
  if (decision !== "allowed" && decision !== "denied") throw new TypeError("audit decision is invalid");
  if (!["succeeded", "failed", "conflicted", "not_found"].includes(outcome as string)) throw new TypeError("audit outcome is invalid");
  if (!["http", "projector", "delivery", "connector", "recovery"].includes(category as string)) throw new TypeError("audit category is invalid");
  const represented = candidate.represented_actor;
  if (represented !== null) {
    const actor = safeObject(represented, "represented actor");
    if (!["human", "agent", "system"].includes(actor.actor_type as string)) throw new TypeError("represented actor type is invalid");
  }
  return candidate as unknown as AuditRecord;
}

export class OperationsClient {
  constructor(private readonly transport: SdkTransport, private readonly representation: RepresentationContext) {}

  listSubscriptions(options: PageOptions = {}): Promise<readonly RuntimeSubscription[]> {
    const limit = positive(options.limit, "limit");
    return this.transport.request({ method: "GET", path: ["v1", "admin", "subscriptions"], query: limit === undefined ? {} : { limit }, retry: "query", ...requestOptions(this.representation, options), decode: (value) => decodeObjectArrayProperty<RuntimeSubscription>(value, "subscriptions") });
  }

  listProjectionFailures(input: ProjectionFailureQuery): Promise<readonly ProjectionFailureRecord[]> {
    const limit = positive(input.limit, "limit");
    return this.transport.request({ method: "GET", path: ["v1", "admin", "projection-failures"], query: { projector_id: identifier(input.projectorId, "projectorId"), partition_id: identifier(input.partitionId, "partitionId"), ...(limit === undefined ? {} : { limit }) }, retry: "query", ...requestOptions(this.representation, input), decode: (value) => decodeObjectArrayProperty<ProjectionFailureRecord>(value, "failures") });
  }

  listDeliveryAttempts(input: DeliveryAttemptQuery): Promise<readonly DeliveryAttempt[]> {
    const limit = positive(input.limit, "limit");
    return this.transport.request({ method: "GET", path: ["v1", "admin", "delivery-attempts"], query: { subscription_id: identifier(input.subscriptionId, "subscriptionId"), event_id: identifier(input.eventId, "eventId"), ...(limit === undefined ? {} : { limit }) }, retry: "query", ...requestOptions(this.representation, input), decode: (value) => decodeObjectArrayProperty<DeliveryAttempt>(value, "attempts") });
  }

  getDeliveryPosition(input: DeliveryPositionQuery): Promise<number> {
    return this.transport.request({ method: "GET", path: ["v1", "admin", "delivery-position"], query: { subscription_id: identifier(input.subscriptionId, "subscriptionId"), partition_id: identifier(input.partitionId, "partitionId") }, retry: "query", ...requestOptions(this.representation, input), decode(value) { const position = decodeObject<{ position: unknown }>(value).position; if (!Number.isSafeInteger(position) || (position as number) < 0) throw new TypeError("invalid position"); return position as number; } });
  }

  getHealth(options: RequestOptions = {}): Promise<HealthReport> {
    return this.transport.request({ method: "GET", path: ["v1", "admin", "health"], retry: "none", ...requestOptions(this.representation, options), decode: decodeHealth, decodeError: (value, status) => status === 503 ? decodeHealth(value) : undefined });
  }

  getLiveness(options: Omit<RequestOptions, "representation"> = {}): Promise<LivenessReport> {
    return this.transport.request({ method: "GET", path: ["health", "live"], retry: "query", representation: null, ...(options.signal === undefined ? {} : { signal: options.signal }), decode: decodeLiveness });
  }

  getReadiness(options: Omit<RequestOptions, "representation"> = {}): Promise<ReadinessReport> {
    return this.transport.request({ method: "GET", path: ["health", "ready"], retry: "none", representation: null, ...(options.signal === undefined ? {} : { signal: options.signal }), decode: decodeReadiness, decodeError: (value, status) => status === 503 ? decodeReadiness(value) : undefined });
  }

  getProjectionStatus(input: ProjectionStatusQuery): Promise<ProjectionOperationalStatus> {
    return this.transport.request({ method: "GET", path: ["v1", "operations", "projections", identifier(input.projectorId, "projectorId"), "partitions", identifier(input.partitionId, "partitionId")], retry: "query", ...requestOptions(this.representation, input), decode: projectionStatus });
  }

  listProjectionFailurePage(input: ProjectionFailureQuery & OperationalPageOptions): Promise<OperationalPage<ProjectionFailureView>> {
    const limit = positive(input.limit, "limit"); const cursor = pageCursor(input.cursor);
    return this.transport.request({ method: "GET", path: ["v1", "operations", "projection-failures"], query: { projector_id: identifier(input.projectorId, "projectorId"), partition_id: identifier(input.partitionId, "partitionId"), ...(cursor === undefined ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) }, retry: "query", ...requestOptions(this.representation, input), decode: (value) => decodePage(value, projectionFailure) });
  }

  getDeliveryState(input: DeliveryStateQuery): Promise<DeliveryOperationalState> {
    return this.transport.request({ method: "GET", path: ["v1", "operations", "deliveries", identifier(input.subscriptionId, "subscriptionId"), "partitions", identifier(input.partitionId, "partitionId")], retry: "query", ...requestOptions(this.representation, input), decode: deliveryState });
  }

  listDeliveryAttemptPage(input: DeliveryAttemptQuery & OperationalPageOptions): Promise<OperationalPage<DeliveryAttemptView>> {
    const limit = positive(input.limit, "limit"); const cursor = pageCursor(input.cursor);
    return this.transport.request({ method: "GET", path: ["v1", "operations", "delivery-attempts"], query: { subscription_id: identifier(input.subscriptionId, "subscriptionId"), event_id: identifier(input.eventId, "eventId"), ...(cursor === undefined ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) }, retry: "query", ...requestOptions(this.representation, input), decode: (value) => decodePage(value, deliveryAttempt) });
  }

  listDeadLetters(input: DeadLetterQuery): Promise<OperationalPage<DeadLetterView>> {
    const limit = positive(input.limit, "limit"); const cursor = pageCursor(input.cursor);
    return this.transport.request({ method: "GET", path: ["v1", "operations", "dead-letters"], query: { subscription_id: identifier(input.subscriptionId, "subscriptionId"), ...(input.eventId === undefined ? {} : { event_id: identifier(input.eventId, "eventId") }), ...(cursor === undefined ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) }, retry: "query", ...requestOptions(this.representation, input), decode: (value) => decodePage(value, deadLetter) });
  }

  listConnectorIngress(input: ConnectorIngressQuery): Promise<OperationalPage<ConnectorIngressOperationalView>> {
    const states = selected(input.states, ingressStates, "states"); const limit = positive(input.limit, "limit"); const cursor = pageCursor(input.cursor);
    return this.transport.request({ method: "GET", path: ["v1", "operations", "connectors", identifier(input.connectorId, "connectorId"), "ingress"], query: { ...(states === undefined ? {} : { state: states }), ...(cursor === undefined ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) }, retry: "query", ...requestOptions(this.representation, input), decode: (value) => decodePage(value, connectorIngress) });
  }

  getConnectorIngress(input: ConnectorIngressGet): Promise<ConnectorIngressOperationalView> {
    return this.transport.request({ method: "GET", path: ["v1", "operations", "connectors", identifier(input.connectorId, "connectorId"), "ingress", identifier(input.ingressId, "ingressId")], retry: "query", ...requestOptions(this.representation, input), decode: connectorIngress });
  }

  listDiscrepancies(input: DiscrepancyQuery = {}): Promise<OperationalPage<ConnectorDiscrepancyView>> {
    const statuses = selected(input.statuses, ["open", "acknowledged"] as const, "statuses"); const limit = positive(input.limit, "limit"); const cursor = pageCursor(input.cursor);
    return this.transport.request({ method: "GET", path: ["v1", "operations", "discrepancies"], query: { ...(input.connectorId === undefined ? {} : { connector_id: identifier(input.connectorId, "connectorId") }), ...(statuses === undefined ? {} : { status: statuses }), ...(cursor === undefined ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) }, retry: "query", ...requestOptions(this.representation, input), decode: (value) => decodePage(value, discrepancy) });
  }

  getDiscrepancy(input: DiscrepancyGet): Promise<ConnectorDiscrepancyView> {
    return this.transport.request({ method: "GET", path: ["v1", "operations", "discrepancies", identifier(input.discrepancyId, "discrepancyId")], query: { connector_id: identifier(input.connectorId, "connectorId") }, retry: "query", ...requestOptions(this.representation, input), decode: discrepancy });
  }

  requestRecovery(input: RecoveryRequestOptions): Promise<SubmitRecoveryResult> {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new TypeError("expectedVersion must be a non-negative safe integer");
    }
    return this.transport.request({
      method: "POST",
      path: ["v1", "operations", "recoveries"],
      body: {
        idempotency_key: identifier(input.idempotencyKey, "idempotencyKey"),
        target: recoveryTarget(input.target),
        expected_version: input.expectedVersion,
        reason: recoveryReason(input.reason),
      },
      retry: "none",
      ...requestOptions(this.representation, input),
      decode: recoveryResult,
    });
  }

  getRecovery(recoveryId: string, options: RequestOptions = {}): Promise<RecoveryRequestRecord> {
    return this.transport.request({
      method: "GET",
      path: ["v1", "operations", "recoveries", identifier(recoveryId, "recoveryId")],
      retry: "query",
      ...requestOptions(this.representation, options),
      decode: recoveryRecord,
    });
  }

  listAudit(input: AuditQueryOptions = {}): Promise<OperationalPage<AuditRecord>> {
    const limit = positive(input.limit, "limit");
    const cursor = pageCursor(input.cursor);
    const outcomes = ["succeeded", "failed", "conflicted", "not_found"] as const;
    if (input.outcome !== undefined && !outcomes.includes(input.outcome)) throw new TypeError("outcome is invalid");
    const timestamp = (value: string | undefined, field: string) => {
      if (value !== undefined && !Number.isFinite(Date.parse(value))) throw new TypeError(`${field} is invalid`);
      return value;
    };
    return this.transport.request({
      method: "GET",
      path: ["v1", "operations", "audit"],
      query: {
        ...(timestamp(input.occurredFrom, "occurredFrom") === undefined ? {} : { occurred_from: input.occurredFrom }),
        ...(timestamp(input.occurredTo, "occurredTo") === undefined ? {} : { occurred_to: input.occurredTo }),
        ...(input.principalId === undefined ? {} : { principal_id: identifier(input.principalId, "principalId") }),
        ...(input.operation === undefined ? {} : { operation: identifier(input.operation, "operation") }),
        ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      },
      retry: "query",
      ...requestOptions(this.representation, input),
      decode: (value) => decodePage(value, auditRecord),
    });
  }
}
