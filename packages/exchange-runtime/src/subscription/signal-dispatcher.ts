import type { Clock } from "@work-fabric/exchange-core";
import type { WfppSchemaValidator } from "@work-fabric/protocol-runtime";
import type {
  DeadLetterRecord,
  DeliveryAttempt,
  DeliveryStateStore,
  EventJournal,
  EventRecord,
  RuntimeSubscription,
  SignalAdapter,
  SubscriptionDeliveryPolicy,
  SubscriptionStore,
} from "@work-fabric/exchange-spi";
import {
  observeSemanticSafely,
  safeSemanticCorrelationId,
  type SemanticObservation,
  type SemanticTelemetryObserver,
} from "@work-fabric/operations-spi";

import { buildProtocolEvent } from "./protocol-event-builder.js";
import { matchesSubscription } from "./subscription-filter.js";
import {
  addSeconds,
  assertNonNegativeSafeInteger,
  assertOpaqueId,
  assertPositiveSafeInteger,
  assertTimestamp,
  assertRuntimeSubscription,
  compareTimestamps,
} from "./validation.js";
import type { RuntimeOwnershipFence } from "../runtime-ownership-fence.js";

export interface RetryPolicy {
  readonly base_delay_seconds: number;
  readonly max_delay_seconds: number;
}

export interface DispatchObserver {
  afterDelivery(eventId: string, subscriptionId: string): Promise<void>;
}

export interface SignalDispatchTurnResult {
  readonly processed: number;
}

export class SignalDispatcher {
  constructor(
    private readonly journal: EventJournal,
    private readonly deliveryState: DeliveryStateStore,
    private readonly subscriptions: SubscriptionStore,
    private readonly policy: SubscriptionDeliveryPolicy,
    private readonly signal: SignalAdapter,
    private readonly clock: Clock,
    private readonly retry: RetryPolicy,
    private readonly schemas: WfppSchemaValidator,
    private readonly observer?: DispatchObserver,
    private readonly telemetry?: SemanticTelemetryObserver,
  ) {
    assertPositiveSafeInteger(retry.base_delay_seconds, "base retry delay");
    assertPositiveSafeInteger(retry.max_delay_seconds, "max retry delay");
    if (retry.max_delay_seconds < retry.base_delay_seconds) {
      throw new RangeError("max retry delay must not be less than base delay");
    }
  }

  async dispatchPartition(
    partitionId: string,
    tenantId: string,
    limit: number,
    fence?: RuntimeOwnershipFence,
  ): Promise<void> {
    await this.dispatchPartitionTurn(partitionId, tenantId, limit, fence);
  }

  async dispatchPartitionTurn(
    partitionId: string,
    tenantId: string,
    limit: number,
    fence?: RuntimeOwnershipFence,
  ): Promise<SignalDispatchTurnResult> {
    assertOpaqueId(partitionId, "partition_id");
    assertOpaqueId(tenantId, "tenant_id");
    assertPositiveSafeInteger(limit, "limit");
    const subscriptions = await this.subscriptions.listActiveSubscriptions(tenantId);
    let processed = 0;
    for (const subscription of subscriptions) {
      if (processed >= limit) break;
      try {
        assertRuntimeSubscription(subscription);
        if (
          subscription.tenant_id !== tenantId ||
          subscription.delivery_mode !== "webhook"
        ) {
          continue;
        }
        processed += await this.dispatchSubscription(
          subscription,
          partitionId,
          limit - processed,
          fence,
        );
      } catch {
        await fence?.assertOwnership();
        // A Subscription-specific adapter or state failure must not block peers.
      }
    }
    return { processed };
  }

  private async dispatchSubscription(
    subscription: RuntimeSubscription,
    partitionId: string,
    limit: number,
    fence?: RuntimeOwnershipFence,
  ): Promise<number> {
    assertRuntimeSubscription(subscription);
    assertPositiveSafeInteger(subscription.max_attempts, "max_attempts");
    const now = this.clock.now();
    assertTimestamp(now, "clock time");
    let position = await this.deliveryState.loadDeliveryPosition(
      subscription.subscription_id,
      partitionId,
    );
    assertNonNegativeSafeInteger(position, "delivery position");
    const events = await this.journal.readPartition(partitionId, position, limit);
    let previousJournalPosition = position;
    let processed = 0;

    for (const event of events) {
      this.validateJournalEvent(event, partitionId, previousJournalPosition);
      previousJournalPosition = event.partition_position;
      const protocolEvent = buildProtocolEvent(event);
      const eventValidation = this.schemas.validate(
        "urn:work-fabric:schema:v1:protocol-event",
        protocolEvent,
      );
      if (!eventValidation.valid) {
        throw new Error("Journal Event is not a canonical Protocol Event");
      }
      const filtered = matchesSubscription(subscription.filter, protocolEvent);
      const authorized = filtered
        ? await this.policy.authorizeDelivery(subscription, event)
        : { kind: "deny" as const };
      if (!filtered || authorized.kind !== "allow") {
        await fence?.assertOwnership();
        const advanced = await this.deliveryState.advanceDeliveryPosition(
          subscription.subscription_id,
          partitionId,
          position,
          event.partition_position,
        );
        if (!advanced) return processed;
        position = event.partition_position;
        processed += 1;
        continue;
      }

      const attempts = await this.deliveryState.listDeliveryAttempts(
        subscription.subscription_id,
        event.event_id,
      );
      this.validateAttempts(
        attempts,
        subscription.subscription_id,
        partitionId,
        event.event_id,
      );
      const previous = attempts.at(-1);
      if (previous?.next_attempt_at !== null && previous?.next_attempt_at !== undefined) {
        assertTimestamp(previous.next_attempt_at, "next_attempt_at");
        if (
          compareTimestamps(now, previous.next_attempt_at) < 0
        ) {
          return processed;
        }
      }
      const attemptNumber = attempts.length + 1;
      assertPositiveSafeInteger(attemptNumber, "delivery attempt");
      const deliveryStartedAt = performance.now();
      await fence?.assertOwnership();
      const result = await this.signal.deliver(
        protocolEvent,
        subscription.destination,
      );
      if (
        result.kind !== "accepted" &&
        result.kind !== "retryable_failure" &&
        result.kind !== "permanent_failure"
      ) {
        throw new Error("Signal Adapter returned an invalid outcome");
      }
      if (
        result.kind !== "accepted" &&
        (typeof result.detail !== "string" || result.detail.length === 0)
      ) {
        throw new Error("Signal failure outcome requires a detail");
      }
      const nextAttemptAt =
        result.kind === "retryable_failure" &&
        attemptNumber < subscription.max_attempts
          ? addSeconds(now, this.retryDelay(attemptNumber))
          : null;
      const attempt: DeliveryAttempt = {
        subscription_id: subscription.subscription_id,
        partition_id: partitionId,
        event_id: event.event_id,
        attempt: attemptNumber,
        attempted_at: now,
        outcome: result.kind,
        detail: result.kind === "accepted" ? null : result.detail.slice(0, 512),
        next_attempt_at: nextAttemptAt,
      };
      await fence?.assertOwnership();
      await this.deliveryState.recordDeliveryAttempt(attempt);
      await this.observer?.afterDelivery(
        event.event_id,
        subscription.subscription_id,
      );

      let semanticOutcome: SemanticObservation["outcome"] =
        result.kind === "accepted" ? "succeeded" : "dead_lettered";

      if (result.kind === "retryable_failure") {
        if (attemptNumber < subscription.max_attempts) {
          semanticOutcome = "retryable";
          this.observeDelivery(event, semanticOutcome, deliveryStartedAt);
          return processed + 1;
        }
        await fence?.assertOwnership();
        await this.deadLetter(
          subscription,
          event,
          attemptNumber,
          result.detail,
          now,
        );
      } else if (result.kind === "permanent_failure") {
        await fence?.assertOwnership();
        await this.deadLetter(
          subscription,
          event,
          attemptNumber,
          result.detail,
          now,
        );
      }
      this.observeDelivery(event, semanticOutcome, deliveryStartedAt);

      await fence?.assertOwnership();
      const advanced = await this.deliveryState.advanceDeliveryPosition(
        subscription.subscription_id,
        partitionId,
        position,
        event.partition_position,
      );
      if (!advanced) return processed + 1;
      position = event.partition_position;
      processed += 1;
    }
    return processed;
  }

  private observeDelivery(
    event: EventRecord,
    outcome: SemanticObservation["outcome"],
    startedAt: number,
  ): void {
    const correlationId = safeSemanticCorrelationId(event.correlation_id);
    observeSemanticSafely(this.telemetry, {
      operation: "delivery_attempt",
      outcome,
      category: "delivery",
      duration_ms: Math.max(0, performance.now() - startedAt),
      count: 1,
      ...(correlationId === undefined ? {} : { correlation_id: correlationId }),
    });
  }

  private retryDelay(attempt: number): number {
    const exponent = Math.min(attempt - 1, 52);
    const calculated = this.retry.base_delay_seconds * 2 ** exponent;
    return Math.min(calculated, this.retry.max_delay_seconds);
  }

  private validateAttempts(
    attempts: readonly DeliveryAttempt[],
    subscriptionId: string,
    partitionId: string,
    eventId: string,
  ): void {
    let expectedAttempt = 1;
    for (const attempt of attempts) {
      assertOpaqueId(attempt.subscription_id, "attempt subscription_id");
      assertOpaqueId(attempt.partition_id, "attempt partition_id");
      assertOpaqueId(attempt.event_id, "attempt event_id");
      assertPositiveSafeInteger(attempt.attempt, "attempt");
      assertTimestamp(attempt.attempted_at, "attempted_at");
      if (
        attempt.subscription_id !== subscriptionId ||
        attempt.partition_id !== partitionId ||
        attempt.event_id !== eventId ||
        attempt.attempt !== expectedAttempt
      ) {
        throw new Error("Delivery Attempt history is inconsistent");
      }
      if (
        attempt.outcome !== "accepted" &&
        attempt.outcome !== "retryable_failure" &&
        attempt.outcome !== "permanent_failure"
      ) {
        throw new Error("Delivery Attempt outcome is invalid");
      }
      if (attempt.next_attempt_at !== null) {
        assertTimestamp(attempt.next_attempt_at, "next_attempt_at");
        if (attempt.outcome !== "retryable_failure") {
          throw new Error("only retryable attempts may have next_attempt_at");
        }
        if (
          compareTimestamps(attempt.next_attempt_at, attempt.attempted_at) <= 0
        ) {
          throw new Error("next_attempt_at must follow attempted_at");
        }
      }
      if (attempt.outcome === "accepted") {
        if (attempt.detail !== null || attempt.next_attempt_at !== null) {
          throw new Error("accepted Delivery Attempt must be terminal and empty");
        }
      } else {
        if (
          typeof attempt.detail !== "string" ||
          attempt.detail.length === 0 ||
          attempt.detail.length > 512
        ) {
          throw new Error("failed Delivery Attempt detail is invalid");
        }
        if (
          attempt.outcome === "permanent_failure" &&
          attempt.next_attempt_at !== null
        ) {
          throw new Error("permanent Delivery Attempt must be terminal");
        }
      }
      expectedAttempt += 1;
    }
  }

  private async deadLetter(
    subscription: RuntimeSubscription,
    event: EventRecord,
    attempts: number,
    reason: string,
    recordedAt: string,
  ): Promise<void> {
    const record: DeadLetterRecord = {
      subscription_id: subscription.subscription_id,
      event,
      attempts,
      reason: reason.length === 0 ? "delivery_failed" : reason.slice(0, 512),
      recorded_at: recordedAt,
    };
    await this.deliveryState.putDeadLetter(record);
  }

  private validateJournalEvent(
    event: EventRecord,
    partitionId: string,
    afterPosition: number,
  ): void {
    assertOpaqueId(event.partition_id, "event partition_id");
    assertPositiveSafeInteger(event.partition_position, "event position");
    if (
      event.partition_id !== partitionId ||
      event.partition_position !== afterPosition + 1
    ) {
      throw new Error("Journal returned an invalid Partition sequence");
    }
  }
}
