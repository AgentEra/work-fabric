import type {
  DeliveryAttempt,
  DeliveryStateStore,
  EventJournal,
  HandoffReadModel,
  HandoffReadModelStore,
  ProjectionFailureRecord,
  ProjectionFailureStore,
  ProtocolEvent,
  RuntimeSubscription,
  SubscriptionStore,
} from "@work-fabric/exchange-spi";
import { buildProtocolEvent } from "@work-fabric/exchange-runtime";

export interface ExchangeQueryService {
  getHandoff(tenantId: string, handoffId: string): Promise<HandoffReadModel | null>;
  readHandoffEvents(tenantId: string, handoffId: string, fromVersion: number, limit: number): Promise<readonly ProtocolEvent[]>;
  listPartitionHandoffs(tenantId: string, partitionId: string, limit: number): Promise<readonly HandoffReadModel[]>;
  readPartitionEvents(tenantId: string, partitionId: string, afterPosition: number, limit: number): Promise<readonly ProtocolEvent[]>;
  getSubscription(tenantId: string, subscriptionId: string): Promise<RuntimeSubscription | null>;
  listSubscriptions(tenantId: string, limit: number): Promise<readonly RuntimeSubscription[]>;
  listProjectionFailures(projectorId: string, partitionId: string, limit: number): Promise<readonly ProjectionFailureRecord[]>;
  listDeliveryAttempts(subscriptionId: string, eventId: string, limit: number): Promise<readonly DeliveryAttempt[]>;
  getDeliveryPosition(subscriptionId: string, partitionId: string): Promise<number>;
}

function bounded<T>(values: readonly T[], limit: number): readonly T[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError("limit must be a positive safe integer");
  }
  return structuredClone(values.slice(0, limit));
}

export class StoreBackedExchangeQueryService implements ExchangeQueryService {
  constructor(
    private readonly journal: EventJournal,
    private readonly models: HandoffReadModelStore,
    private readonly subscriptions: SubscriptionStore,
    private readonly projectionFailures: ProjectionFailureStore,
    private readonly deliveryState: DeliveryStateStore,
  ) {}

  async getHandoff(tenantId: string, handoffId: string) {
    const model = await this.models.getHandoff(handoffId);
    if (model === null || model.tenant_id !== tenantId || model.handoff_id !== handoffId) {
      return null;
    }
    return structuredClone(model);
  }

  async readHandoffEvents(tenantId: string, handoffId: string, fromVersion: number, limit: number) {
    const records = await this.journal.readStream(handoffId, fromVersion);
    if (records.some((record) => record.tenant_id !== tenantId || record.handoff_id !== handoffId)) return [];
    return bounded(records.map(buildProtocolEvent), limit);
  }

  async listPartitionHandoffs(tenantId: string, partitionId: string, limit: number) {
    const models = await this.models.listHandoffs(partitionId);
    if (models.some((model) => model.tenant_id !== tenantId || model.partition_id !== partitionId)) return [];
    return bounded(models, limit);
  }

  async readPartitionEvents(tenantId: string, partitionId: string, afterPosition: number, limit: number) {
    const records = await this.journal.readPartition(partitionId, afterPosition, limit);
    if (records.some((record) => record.tenant_id !== tenantId || record.partition_id !== partitionId)) return [];
    return bounded(records.map(buildProtocolEvent), limit);
  }

  async getSubscription(tenantId: string, subscriptionId: string) {
    const subscription = await this.subscriptions.getSubscription(subscriptionId);
    if (subscription === null || subscription.tenant_id !== tenantId || subscription.subscription_id !== subscriptionId) return null;
    return structuredClone(subscription);
  }

  async listSubscriptions(tenantId: string, limit: number) {
    const subscriptions = await this.subscriptions.listActiveSubscriptions(tenantId);
    if (subscriptions.some((subscription) => subscription.tenant_id !== tenantId)) return [];
    return bounded(subscriptions, limit);
  }

  async listProjectionFailures(projectorId: string, partitionId: string, limit: number) {
    const failures = await this.projectionFailures.listProjectionFailures(projectorId, partitionId);
    return bounded(failures.map((failure) => ({
      ...failure,
      reason: "projection_failed",
    })), limit);
  }

  async listDeliveryAttempts(subscriptionId: string, eventId: string, limit: number) {
    const attempts = await this.deliveryState.listDeliveryAttempts(subscriptionId, eventId);
    return bounded(attempts.map((attempt) => ({ ...attempt, detail: null })), limit);
  }

  async getDeliveryPosition(subscriptionId: string, partitionId: string) {
    return this.deliveryState.loadDeliveryPosition(subscriptionId, partitionId);
  }
}
