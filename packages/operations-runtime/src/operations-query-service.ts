import type {
  DeliveryAttempt,
  DeliveryStateStore,
  PendingDeliveryRecord,
  ProjectionCheckpointStore,
  ProjectionFailureRecord,
  ProjectionFailureStore,
  SubscriptionStore,
} from "@work-fabric/exchange-spi";
import type { ConnectorIngressRecord, ConnectorIngressStore } from "@work-fabric/connector-spi";
import type {
  ConnectorDiscrepancy,
  ConnectorDiscrepancyStore,
} from "@work-fabric/connector-runtime";
import {
  normalizePageLimit,
  type DeadLetterOperationalQuery,
  type DeadLetterView,
  type DeliveryAttemptOperationalQuery,
  type DeliveryAttemptView,
  type DeliveryOperationalState,
  type ConnectorDiscrepancyOperationalQuery,
  type ConnectorDiscrepancyView,
  type ConnectorIngressOperationalQuery,
  type ConnectorIngressOperationalView,
  type OpaqueCursorCodec,
  type OperationalPage,
  type PartitionJournalPositionSource,
  type ProjectionFailureOperationalQuery,
  type ProjectionFailureView,
  type ProjectionOperationalStatus,
} from "@work-fabric/operations-spi";
import type { JsonObject } from "@work-fabric/exchange-spi";

export interface OperationsQueryDependencies {
  readonly journal_positions: PartitionJournalPositionSource;
  readonly checkpoints: ProjectionCheckpointStore;
  readonly projection_failures: ProjectionFailureStore;
  readonly subscriptions: SubscriptionStore;
  readonly delivery_state: DeliveryStateStore;
  readonly connector_ingress?: ConnectorIngressStore;
  readonly discrepancies?: ConnectorDiscrepancyStore;
  readonly cursor: OpaqueCursorCodec;
  readonly max_page_limit?: number;
}

export interface OperationsQueryService {
  getProjectionStatus(tenantId: string, projectorId: string, partitionId: string): Promise<ProjectionOperationalStatus | null>;
  listProjectionFailures(tenantId: string, query: ProjectionFailureOperationalQuery): Promise<OperationalPage<ProjectionFailureView>>;
  getDeliveryState(tenantId: string, subscriptionId: string, partitionId: string): Promise<DeliveryOperationalState | null>;
  listDeliveryAttempts(tenantId: string, query: DeliveryAttemptOperationalQuery): Promise<OperationalPage<DeliveryAttemptView>>;
  listDeadLetters(tenantId: string, query: DeadLetterOperationalQuery): Promise<OperationalPage<DeadLetterView>>;
  getConnectorIngress(tenantId: string, connectorId: string, ingressId: string): Promise<ConnectorIngressOperationalView | null>;
  listConnectorIngress(tenantId: string, query: ConnectorIngressOperationalQuery): Promise<OperationalPage<ConnectorIngressOperationalView>>;
  getDiscrepancy(tenantId: string, discrepancyId: string): Promise<ConnectorDiscrepancyView | null>;
  listDiscrepancies(tenantId: string, query: ConnectorDiscrepancyOperationalQuery): Promise<OperationalPage<ConnectorDiscrepancyView>>;
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 255 ||
    value.trim() !== value
  ) throw new TypeError(`${field} is invalid`);
  return value;
}

function nonNegative(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function positive(value: unknown, field: string): number {
  const parsed = nonNegative(value, field);
  if (parsed === 0) throw new TypeError(`${field} must be positive`);
  return parsed;
}

function activeDelivery(record: PendingDeliveryRecord | null) {
  if (record === null) return null;
  return {
    delivery_id: identifier(record.delivery_id, "delivery_id"),
    from_position: nonNegative(record.from_position, "from_position"),
    to_position: positive(record.to_position, "to_position"),
    attempt: positive(record.attempt, "attempt"),
    delivered_at: record.delivered_at,
    visibility_expires_at: record.visibility_expires_at,
    outcome: record.outcome,
  };
}

function failureView(record: ProjectionFailureRecord): ProjectionFailureView {
  return {
    projector_id: identifier(record.projector_id, "projector_id"),
    partition_id: identifier(record.partition_id, "partition_id"),
    event_id: identifier(record.event_id, "event_id"),
    position: positive(record.position, "position"),
    reason_code: "projection_failed",
    recorded_at: record.recorded_at,
  };
}

function attemptView(record: DeliveryAttempt): DeliveryAttemptView {
  return {
    subscription_id: identifier(record.subscription_id, "subscription_id"),
    partition_id: identifier(record.partition_id, "partition_id"),
    event_id: identifier(record.event_id, "event_id"),
    attempt: positive(record.attempt, "attempt"),
    attempted_at: record.attempted_at,
    outcome: record.outcome,
    next_attempt_at: record.next_attempt_at,
  };
}

function normalizedErrorCode(value: string | undefined): string | null {
  if (value === undefined) return null;
  return /^[a-z][a-z0-9_.-]{0,127}$/.test(value) &&
      !/(?:bearer|token|secret|password|credential)/i.test(value)
    ? value
    : "connector_error";
}

function ingressView(record: ConnectorIngressRecord): ConnectorIngressOperationalView {
  return {
    tenant_id: identifier(record.envelope.tenant_id, "tenant_id"),
    connector_id: identifier(record.envelope.connector_id, "connector_id"),
    ingress_id: identifier(record.ingress_id, "ingress_id"),
    source_system: identifier(record.envelope.source_system, "source_system"),
    external_event_id: identifier(record.envelope.external_event_id, "external_event_id"),
    event_type: identifier(record.envelope.event_type, "event_type"),
    state: record.state,
    attempt: nonNegative(record.attempt, "attempt"),
    available_at: record.available_at,
    accepted_at: record.accepted_at,
    updated_at: record.updated_at,
    completed_at: record.completed_at ?? null,
    last_error_code: normalizedErrorCode(record.last_error_code),
    last_requeued_at: record.last_requeued_at ?? null,
  };
}

function discrepancyView(record: ConnectorDiscrepancy): ConnectorDiscrepancyView {
  return {
    discrepancy_id: identifier(record.discrepancy_id, "discrepancy_id"),
    tenant_id: identifier(record.tenant_id, "tenant_id"),
    connector_id: identifier(record.connector_id, "connector_id"),
    external_object_id: identifier(record.external_object_id, "external_object_id"),
    resource_id: record.resource_id,
    expected_state: record.expected_state,
    expected_version: record.expected_version,
    observed_state: identifier(record.observed_state, "observed_state"),
    observed_at: record.observed_at,
    status: record.status,
    version: positive(record.version, "version"),
    acknowledged_at: record.acknowledged_at,
    acknowledged_by: record.acknowledged_by,
  };
}

export class StoreBackedOperationsQueryService implements OperationsQueryService {
  private readonly maxPageLimit: number;

  constructor(private readonly dependencies: OperationsQueryDependencies) {
    this.maxPageLimit = dependencies.max_page_limit ?? 100;
    positive(this.maxPageLimit, "max_page_limit");
  }

  async getProjectionStatus(
    tenantId: string,
    projectorId: string,
    partitionId: string,
  ): Promise<ProjectionOperationalStatus | null> {
    identifier(tenantId, "tenantId");
    identifier(projectorId, "projectorId");
    identifier(partitionId, "partitionId");
    const journalPosition = await this.dependencies.journal_positions.load(
      tenantId,
      partitionId,
    );
    if (journalPosition === null) return null;
    nonNegative(journalPosition, "journal position");
    const checkpoint = await this.dependencies.checkpoints.loadProjectionCheckpoint(
      projectorId,
      partitionId,
    );
    nonNegative(checkpoint, "checkpoint position");
    if (checkpoint > journalPosition) throw new Error("projection position is inconsistent");
    const lag = journalPosition - checkpoint;
    return {
      tenant_id: tenantId,
      projector_id: projectorId,
      partition_id: partitionId,
      checkpoint_position: checkpoint,
      journal_position: journalPosition,
      lag,
      state: lag === 0 ? "current" : "lagging",
    };
  }

  async listProjectionFailures(
    tenantId: string,
    query: ProjectionFailureOperationalQuery,
  ): Promise<OperationalPage<ProjectionFailureView>> {
    const ownership = await this.getProjectionStatus(
      tenantId,
      query.projector_id,
      query.partition_id,
    );
    if (ownership === null) return { items: [], next_cursor: null };
    const records = await this.dependencies.projection_failures.listProjectionFailures(
      query.projector_id,
      query.partition_id,
    );
    const values = records.map(failureView);
    if (values.some((value) =>
      value.projector_id !== query.projector_id ||
      value.partition_id !== query.partition_id
    )) throw new Error("projection failure identity mismatch");
    values.sort((left, right) =>
      left.position - right.position || left.event_id.localeCompare(right.event_id),
    );
    return this.page(
      values,
      query.limit,
      query.cursor,
      "projection_failure_position_asc_event_asc",
      { tenant_id: tenantId, projector_id: query.projector_id, partition_id: query.partition_id },
      (value) => ({ position: value.position, event_id: value.event_id }),
      (value, position) =>
        value.position > this.cursorNumber(position, "position") ||
        (value.position === this.cursorNumber(position, "position") &&
          value.event_id > this.cursorString(position, "event_id")),
    );
  }

  async getDeliveryState(
    tenantId: string,
    subscriptionId: string,
    partitionId: string,
  ): Promise<DeliveryOperationalState | null> {
    const owned = await this.ownedSubscription(tenantId, subscriptionId);
    identifier(partitionId, "partitionId");
    if (!owned) return null;
    const position = await this.dependencies.delivery_state.loadDeliveryPosition(
      subscriptionId,
      partitionId,
    );
    const active = await this.dependencies.delivery_state.getActiveDelivery(
      subscriptionId,
      partitionId,
    );
    if (active !== null && (
      active.subscription_id !== subscriptionId || active.partition_id !== partitionId
    )) throw new Error("active delivery identity mismatch");
    return {
      tenant_id: tenantId,
      subscription_id: subscriptionId,
      partition_id: partitionId,
      position: nonNegative(position, "delivery position"),
      active_delivery: activeDelivery(active),
    };
  }

  async listDeliveryAttempts(
    tenantId: string,
    query: DeliveryAttemptOperationalQuery,
  ): Promise<OperationalPage<DeliveryAttemptView>> {
    if (!await this.ownedSubscription(tenantId, query.subscription_id)) {
      return { items: [], next_cursor: null };
    }
    identifier(query.event_id, "event_id");
    const values = (await this.dependencies.delivery_state.listDeliveryAttempts(
      query.subscription_id,
      query.event_id,
    )).map(attemptView);
    if (values.some((value) =>
      value.subscription_id !== query.subscription_id || value.event_id !== query.event_id
    )) throw new Error("delivery attempt identity mismatch");
    values.sort((left, right) =>
      left.attempt - right.attempt || left.attempted_at.localeCompare(right.attempted_at),
    );
    return this.page(
      values,
      query.limit,
      query.cursor,
      "delivery_attempt_asc_time_asc",
      { tenant_id: tenantId, subscription_id: query.subscription_id, event_id: query.event_id },
      (value) => ({ attempt: value.attempt, attempted_at: value.attempted_at }),
      (value, position) =>
        value.attempt > this.cursorNumber(position, "attempt") ||
        (value.attempt === this.cursorNumber(position, "attempt") &&
          value.attempted_at > this.cursorString(position, "attempted_at")),
    );
  }

  async listDeadLetters(
    tenantId: string,
    query: DeadLetterOperationalQuery,
  ): Promise<OperationalPage<DeadLetterView>> {
    if (!await this.ownedSubscription(tenantId, query.subscription_id)) {
      return { items: [], next_cursor: null };
    }
    if (query.event_id !== undefined) identifier(query.event_id, "event_id");
    const records = await this.dependencies.delivery_state.listDeadLetters(
      query.subscription_id,
      query.event_id,
    );
    const values = records.map((record): DeadLetterView => {
      if (
        record.subscription_id !== query.subscription_id ||
        record.event.tenant_id !== tenantId
      ) throw new Error("dead letter identity mismatch");
      return {
        subscription_id: record.subscription_id,
        partition_id: identifier(record.event.partition_id, "partition_id"),
        event_id: identifier(record.event.event_id, "event_id"),
        event_type: identifier(record.event.event_type, "event_type"),
        partition_position: positive(record.event.partition_position, "partition_position"),
        handoff_id: identifier(record.event.handoff_id, "handoff_id"),
        thread_id: identifier(record.event.thread_id, "thread_id"),
        attempts: positive(record.attempts, "attempts"),
        reason_code: "delivery_dead_letter",
        recorded_at: record.recorded_at,
      };
    });
    values.sort((left, right) =>
      right.recorded_at.localeCompare(left.recorded_at) ||
      left.event_id.localeCompare(right.event_id),
    );
    return this.page(
      values,
      query.limit,
      query.cursor,
      "dead_letter_recorded_desc_event_asc",
      { tenant_id: tenantId, subscription_id: query.subscription_id, event_id: query.event_id ?? null },
      (value) => ({ recorded_at: value.recorded_at, event_id: value.event_id }),
      (value, position) =>
        value.recorded_at < this.cursorString(position, "recorded_at") ||
        (value.recorded_at === this.cursorString(position, "recorded_at") &&
          value.event_id > this.cursorString(position, "event_id")),
    );
  }

  async getConnectorIngress(
    tenantId: string,
    connectorId: string,
    ingressId: string,
  ): Promise<ConnectorIngressOperationalView | null> {
    identifier(tenantId, "tenantId");
    identifier(connectorId, "connectorId");
    identifier(ingressId, "ingressId");
    if (this.dependencies.connector_ingress === undefined) return null;
    const record = await this.dependencies.connector_ingress.get({
      tenant_id: tenantId,
      connector_id: connectorId,
      ingress_id: ingressId,
    });
    if (record === null) return null;
    const view = ingressView(record);
    if (
      view.tenant_id !== tenantId || view.connector_id !== connectorId ||
      view.ingress_id !== ingressId
    ) throw new Error("connector ingress identity mismatch");
    return view;
  }

  async listConnectorIngress(
    tenantId: string,
    query: ConnectorIngressOperationalQuery,
  ): Promise<OperationalPage<ConnectorIngressOperationalView>> {
    identifier(tenantId, "tenantId");
    identifier(query.connector_id, "connector_id");
    const limit = normalizePageLimit(query.limit, {
      default_limit: Math.min(25, this.maxPageLimit),
      max_limit: this.maxPageLimit,
    });
    if (this.dependencies.connector_ingress === undefined) {
      return { items: [], next_cursor: null };
    }
    const page = await this.dependencies.connector_ingress.list({
      tenant_id: tenantId,
      connector_id: query.connector_id,
      ...(query.states === undefined ? {} : { states: query.states }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit,
    });
    if (page.items.length > limit) throw new Error("connector ingress page exceeds limit");
    const items = page.items.map(ingressView);
    if (items.some((item) =>
      item.tenant_id !== tenantId || item.connector_id !== query.connector_id ||
      (query.states !== undefined && !query.states.includes(item.state))
    )) throw new Error("connector ingress page identity mismatch");
    return {
      items: structuredClone(items),
      next_cursor: page.next_cursor ?? null,
    };
  }

  async getDiscrepancy(
    tenantId: string,
    discrepancyId: string,
  ): Promise<ConnectorDiscrepancyView | null> {
    identifier(tenantId, "tenantId");
    identifier(discrepancyId, "discrepancyId");
    if (this.dependencies.discrepancies === undefined) return null;
    const record = await this.dependencies.discrepancies.get(tenantId, discrepancyId);
    if (record === null) return null;
    const view = discrepancyView(record);
    if (view.tenant_id !== tenantId || view.discrepancy_id !== discrepancyId) {
      throw new Error("connector discrepancy identity mismatch");
    }
    return view;
  }

  async listDiscrepancies(
    tenantId: string,
    query: ConnectorDiscrepancyOperationalQuery,
  ): Promise<OperationalPage<ConnectorDiscrepancyView>> {
    identifier(tenantId, "tenantId");
    if (query.connector_id !== undefined) identifier(query.connector_id, "connector_id");
    const limit = normalizePageLimit(query.limit, {
      default_limit: Math.min(25, this.maxPageLimit),
      max_limit: this.maxPageLimit,
    });
    if (this.dependencies.discrepancies === undefined) {
      return { items: [], next_cursor: null };
    }
    const page = await this.dependencies.discrepancies.list({
      tenant_id: tenantId,
      ...(query.connector_id === undefined ? {} : { connector_id: query.connector_id }),
      ...(query.statuses === undefined ? {} : { statuses: query.statuses }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit,
    });
    if (page.items.length > limit) throw new Error("connector discrepancy page exceeds limit");
    const items = page.items.map(discrepancyView);
    if (items.some((item) =>
      item.tenant_id !== tenantId ||
      (query.connector_id !== undefined && item.connector_id !== query.connector_id) ||
      (query.statuses !== undefined && !query.statuses.includes(item.status))
    )) throw new Error("connector discrepancy page identity mismatch");
    return { items: structuredClone(items), next_cursor: page.next_cursor };
  }

  private async ownedSubscription(tenantId: string, subscriptionId: string): Promise<boolean> {
    identifier(tenantId, "tenantId");
    identifier(subscriptionId, "subscriptionId");
    const subscription = await this.dependencies.subscriptions.getSubscription(subscriptionId);
    return subscription !== null &&
      subscription.subscription_id === subscriptionId &&
      subscription.tenant_id === tenantId;
  }

  private async page<T>(
    input: readonly T[],
    requestedLimit: number,
    cursor: string | undefined,
    sort: string,
    filters: JsonObject,
    positionFor: (value: T) => JsonObject,
    after: (value: T, position: JsonObject) => boolean,
  ): Promise<OperationalPage<T>> {
    const limit = normalizePageLimit(requestedLimit, {
      default_limit: Math.min(25, this.maxPageLimit),
      max_limit: this.maxPageLimit,
    });
    const context = { kind: "operations" as const, sort, filters };
    const position = cursor === undefined
      ? null
      : await this.dependencies.cursor.decode(cursor, context);
    const candidates = position === null ? [...input] : input.filter((value) => after(value, position));
    const items = candidates.slice(0, limit);
    const last = items.at(-1);
    return {
      items: structuredClone(items),
      next_cursor: candidates.length > limit && last !== undefined
        ? await this.dependencies.cursor.encode({ ...context, position: positionFor(last) })
        : null,
    };
  }

  private cursorString(position: JsonObject, field: string): string {
    return identifier(position[field], `cursor ${field}`);
  }

  private cursorNumber(position: JsonObject, field: string): number {
    return positive(position[field], `cursor ${field}`);
  }
}
