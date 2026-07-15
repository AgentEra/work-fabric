import type { Clock, IdGenerator } from "@work-fabric/exchange-core";
import type {
  DeliveryStateStore,
  EventJournal,
  EventRecord,
  JsonObject,
  PendingDeliveryRecord,
  ProtocolEvent,
  SubscriptionDeliveryPolicy,
  SubscriptionStore,
} from "@work-fabric/exchange-spi";
import type { WfppSchemaValidator } from "@work-fabric/protocol-runtime";

import {
  CursorCodecError,
  type OpaqueCursorCodec,
} from "./opaque-cursor-codec.js";
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

export interface EventDeliveryDocument {
  readonly delivery_id: string;
  readonly subscription_id: string;
  readonly attempt: number;
  readonly events: readonly ProtocolEvent[];
  readonly next_cursor: string;
  readonly delivered_at: string;
  readonly visibility_expires_at: string;
  readonly extensions?: JsonObject;
}

export type PullResult =
  | { readonly kind: "idle"; readonly cursor: string }
  | { readonly kind: "delivery"; readonly delivery: EventDeliveryDocument }
  | {
      readonly kind: "error";
      readonly code:
        | "invalid_argument"
        | "cursor_expired"
        | "precondition_failed";
      readonly message: string;
    };

export type AckResult =
  | {
      readonly kind: "acknowledged" | "retry" | "rejected";
      readonly cursor: string;
    }
  | {
      readonly kind: "error";
      readonly code:
        | "invalid_argument"
        | "not_found"
        | "precondition_failed"
        | "cursor_expired";
      readonly message: string;
    };

function pullError(
  code: Extract<PullResult, { kind: "error" }>["code"],
  message: string,
): PullResult {
  return { kind: "error", code, message };
}

function ackError(
  code: Extract<AckResult, { kind: "error" }>["code"],
  message: string,
): AckResult {
  return { kind: "error", code, message };
}

function document(delivery: PendingDeliveryRecord): EventDeliveryDocument {
  return {
    delivery_id: delivery.delivery_id,
    subscription_id: delivery.subscription_id,
    attempt: delivery.attempt,
    events: delivery.events.map(buildProtocolEvent),
    next_cursor: delivery.next_cursor,
    delivered_at: delivery.delivered_at,
    visibility_expires_at: delivery.visibility_expires_at,
  };
}

function rejectedReason(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "delivery_rejected";
  }
  const reason = (value as Record<string, unknown>).reason;
  return typeof reason === "string" && reason.length > 0
    ? reason.slice(0, 512)
    : "delivery_rejected";
}

export class CursorPullService {
  constructor(
    private readonly journal: EventJournal,
    private readonly deliveryState: DeliveryStateStore,
    private readonly subscriptions: SubscriptionStore,
    private readonly policy: SubscriptionDeliveryPolicy,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly cursors: OpaqueCursorCodec,
    private readonly schemas: WfppSchemaValidator,
    private readonly visibilityTimeoutSeconds: number,
  ) {
    assertPositiveSafeInteger(
      visibilityTimeoutSeconds,
      "visibilityTimeoutSeconds",
    );
  }

  async pull(
    subscriptionId: string,
    partitionId: string,
    cursor: string | null,
    limit: number,
  ): Promise<PullResult> {
    return this.pullForMode(
      subscriptionId,
      partitionId,
      cursor,
      limit,
      "cursor_pull",
    );
  }

  async pullSse(
    subscriptionId: string,
    partitionId: string,
    cursor: string | null,
  ): Promise<PullResult> {
    return this.pullForMode(subscriptionId, partitionId, cursor, 1, "sse");
  }

  private async pullForMode(
    subscriptionId: string,
    partitionId: string,
    cursor: string | null,
    limit: number,
    expectedMode: "cursor_pull" | "sse",
  ): Promise<PullResult> {
    let now: string;
    try {
      assertOpaqueId(subscriptionId, "subscription_id");
      assertOpaqueId(partitionId, "partition_id");
      assertPositiveSafeInteger(limit, "limit");
      now = this.clock.now();
      assertTimestamp(now, "clock time");
    } catch {
      return pullError("invalid_argument", "invalid pull request");
    }

    try {
      const subscription = await this.subscriptions.getSubscription(subscriptionId);
      if (
        subscription === null ||
        subscription.state !== "active" ||
        subscription.delivery_mode !== expectedMode
      ) {
        return pullError(
          "precondition_failed",
          "Subscription is not available for this delivery mode",
        );
      }
      assertRuntimeSubscription(subscription);

      const position = await this.deliveryState.loadDeliveryPosition(
        subscriptionId,
        partitionId,
      );
      assertNonNegativeSafeInteger(position, "delivery position");
      const active = await this.deliveryState.getActiveDelivery(
        subscriptionId,
        partitionId,
      );
      if (cursor !== null) {
        let payload;
        try {
          payload = this.cursors.decode(cursor, now);
        } catch (error: unknown) {
          if (error instanceof CursorCodecError && error.code === "cursor_expired") {
            return pullError("cursor_expired", "cursor expired");
          }
          return pullError("invalid_argument", "invalid cursor");
        }
        if (
          payload.subscription_id !== subscriptionId ||
          payload.partition_id !== partitionId ||
          (payload.position !== position &&
            !(
              active?.outcome === "pending" &&
              cursor === active.next_cursor &&
              payload.position === active.to_position
            ))
        ) {
          return pullError("precondition_failed", "cursor does not match position");
        }
      }

      if (active !== null) {
        if (
          active.outcome === "pending" &&
          compareTimestamps(active.visibility_expires_at, now) > 0
        ) {
          return { kind: "delivery", delivery: this.validatedDocument(active) };
        }
        let replaceable = active;
        if (active.outcome === "pending") {
          const expired = await this.deliveryState.settleDelivery(
            active.delivery_id,
            "pending",
            {
              outcome: "expired",
              settled_at: now,
              reason: "visibility_expired",
            },
          );
          if (expired.kind === "conflict" || expired.kind === "position_conflict") {
            return pullError(
              "precondition_failed",
              "Delivery changed during visibility expiry",
            );
          }
          replaceable = expired.delivery;
        }
        if (replaceable.outcome === "retry" || replaceable.outcome === "expired") {
          const replacement = await this.replaceDelivery(replaceable, now);
          if (replacement === null) {
            return pullError(
              "precondition_failed",
              "Delivery changed during retry",
            );
          }
          return {
            kind: "delivery",
            delivery: this.validatedDocument(replacement),
          };
        }
        return pullError(
          "precondition_failed",
          "active Delivery cannot be resumed",
        );
      }

      const records = await this.journal.readPartition(partitionId, position, limit);
      let previousJournalPosition = position;
      const matched: EventRecord[] = [];
      for (const record of records) {
        this.validateJournalRecord(record, partitionId, previousJournalPosition);
        previousJournalPosition = record.partition_position;
        const event = buildProtocolEvent(record);
        const filtered = matchesSubscription(subscription.filter, event);
        const authorized = filtered
          ? await this.policy.authorizeDelivery(subscription, record)
          : { kind: "deny" as const, reason: "filter_mismatch" };
        if (filtered && authorized.kind === "allow") {
          matched.push(record);
        }
      }

      if (matched.length === 0) {
        if (previousJournalPosition !== position) {
          const advanced = await this.deliveryState.advanceDeliveryPosition(
            subscriptionId,
            partitionId,
            position,
            previousJournalPosition,
          );
          if (!advanced) {
            return pullError(
              "precondition_failed",
              "delivery position changed while scanning",
            );
          }
        }
        const expiresAt = addSeconds(now, this.visibilityTimeoutSeconds);
        return {
          kind: "idle",
          cursor: this.cursors.encode({
            subscription_id: subscriptionId,
            partition_id: partitionId,
            position: previousJournalPosition,
            expires_at: expiresAt,
          }),
        };
      }

      const last = matched.at(-1);
      if (last === undefined) {
        return pullError("precondition_failed", "matched Delivery is empty");
      }
      const delivery = this.newDelivery(
        subscriptionId,
        partitionId,
        position,
        matched.filter(
          (record) => record.partition_position <= last.partition_position,
        ),
        1,
        now,
      );
      const validation = this.schemas.validate(
        "urn:work-fabric:schema:v1:event-delivery",
        document(delivery),
      );
      if (!validation.valid) {
        return pullError(
          "precondition_failed",
          "Event Delivery does not satisfy the protocol schema",
        );
      }
      const claimed = await this.deliveryState.claimPendingDelivery(delivery, null);
      if (claimed.delivery.outcome !== "pending") {
        return pullError("precondition_failed", "Delivery claim conflict");
      }
      return {
        kind: "delivery",
        delivery: this.validatedDocument(claimed.delivery),
      };
    } catch {
      return pullError("precondition_failed", "Pull could not be completed");
    }
  }

  async acknowledge(input: unknown): Promise<AckResult> {
    const validation = this.schemas.validate(
      "urn:work-fabric:schema:v1:delivery-ack",
      input,
    );
    if (!validation.valid || typeof input !== "object" || input === null) {
      return ackError("invalid_argument", "invalid Delivery Ack");
    }
    const ack = input as Record<string, unknown>;
    let now: string;
    try {
      assertOpaqueId(ack.delivery_id, "delivery_id");
      assertOpaqueId(ack.subscription_id, "subscription_id");
      assertTimestamp(ack.acknowledged_at, "acknowledged_at");
      now = this.clock.now();
      assertTimestamp(now, "clock time");
    } catch {
      return ackError("invalid_argument", "invalid Delivery Ack");
    }

    try {
      const delivery = await this.deliveryState.getDelivery(ack.delivery_id);
      if (delivery === null) return ackError("not_found", "Delivery not found");
      if (delivery.subscription_id !== ack.subscription_id) {
        return ackError(
          "precondition_failed",
          "Delivery does not belong to Subscription",
        );
      }
      const outcome = ack.outcome;
      if (
        outcome !== "acknowledged" &&
        outcome !== "retry" &&
        outcome !== "rejected"
      ) {
        return ackError("invalid_argument", "invalid Ack outcome");
      }
      if (ack.last_event_id !== undefined) {
        const lastEvent = delivery.events.at(-1);
        if (lastEvent?.event_id !== ack.last_event_id) {
          return ackError("precondition_failed", "last Event does not match");
        }
      }
      if (ack.cursor !== undefined) {
        if (typeof ack.cursor !== "string") {
          return ackError("invalid_argument", "invalid Ack cursor");
        }
        let payload;
        try {
          payload = this.cursors.decodeAuthenticated(ack.cursor);
        } catch {
          return ackError("invalid_argument", "invalid Ack cursor");
        }
        if (
          payload.subscription_id !== delivery.subscription_id ||
          payload.partition_id !== delivery.partition_id ||
          payload.position !== delivery.to_position
        ) {
          return ackError("precondition_failed", "Ack cursor does not match");
        }
        if (
          delivery.outcome === "pending" &&
          compareTimestamps(payload.expires_at, now) <= 0
        ) {
          return ackError("cursor_expired", "cursor expired");
        }
      }

      if (delivery.outcome === "expired") {
        return ackError("cursor_expired", "Delivery visibility expired");
      }
      if (
        delivery.outcome === "pending" &&
        compareTimestamps(delivery.visibility_expires_at, now) <= 0
      ) {
        await this.deliveryState.settleDelivery(delivery.delivery_id, "pending", {
          outcome: "expired",
          settled_at: now,
          reason: "visibility_expired",
        });
        return ackError("cursor_expired", "Delivery visibility expired");
      }
      const settled = await this.deliveryState.settleDelivery(
        delivery.delivery_id,
        "pending",
        {
          outcome,
          settled_at: now,
          reason: outcome === "rejected" ? rejectedReason(ack.details) : null,
        },
      );
      if (settled.kind === "conflict" || settled.kind === "position_conflict") {
        return ackError("precondition_failed", "Delivery settlement conflict");
      }
      const cursor = this.cursors.encode({
        subscription_id: delivery.subscription_id,
        partition_id: delivery.partition_id,
        position:
          outcome === "retry"
            ? delivery.from_position
            : delivery.to_position,
        expires_at: addSeconds(now, this.visibilityTimeoutSeconds),
      });
      return { kind: outcome, cursor };
    } catch {
      return ackError(
        "precondition_failed",
        "Delivery Ack could not be completed",
      );
    }
  }

  private async replaceDelivery(
    active: PendingDeliveryRecord,
    now: string,
  ): Promise<PendingDeliveryRecord | null> {
    const replacement = this.newDelivery(
      active.subscription_id,
      active.partition_id,
      active.from_position,
      active.events,
      active.attempt + 1,
      now,
    );
    const validation = this.schemas.validate(
      "urn:work-fabric:schema:v1:event-delivery",
      document(replacement),
    );
    if (!validation.valid) return null;
    const claimed = await this.deliveryState.claimPendingDelivery(
      replacement,
      active.delivery_id,
    );
    return claimed.delivery.outcome === "pending" ? claimed.delivery : null;
  }

  private validatedDocument(
    delivery: PendingDeliveryRecord,
  ): EventDeliveryDocument {
    const output = document(delivery);
    const validation = this.schemas.validate(
      "urn:work-fabric:schema:v1:event-delivery",
      output,
    );
    if (!validation.valid) {
      throw new Error("stored Event Delivery is not protocol valid");
    }
    return output;
  }

  private newDelivery(
    subscriptionId: string,
    partitionId: string,
    fromPosition: number,
    events: readonly EventRecord[],
    attempt: number,
    now: string,
  ): PendingDeliveryRecord {
    const last = events.at(-1);
    if (last === undefined) throw new Error("Delivery requires an Event");
    assertPositiveSafeInteger(attempt, "delivery attempt");
    const expiresAt = addSeconds(now, this.visibilityTimeoutSeconds);
    const deliveryId = this.ids.nextId("delivery");
    assertOpaqueId(deliveryId, "generated delivery_id");
    return {
      delivery_id: deliveryId,
      subscription_id: subscriptionId,
      partition_id: partitionId,
      from_position: fromPosition,
      to_position: last.partition_position,
      next_cursor: this.cursors.encode({
        subscription_id: subscriptionId,
        partition_id: partitionId,
        position: last.partition_position,
        expires_at: expiresAt,
      }),
      events: structuredClone(events),
      attempt,
      delivered_at: now,
      visibility_expires_at: expiresAt,
      outcome: "pending",
    };
  }

  private validateJournalRecord(
    record: EventRecord,
    partitionId: string,
    afterPosition: number,
  ): void {
    assertOpaqueId(record.event_id, "event_id");
    assertOpaqueId(record.partition_id, "event partition_id");
    assertPositiveSafeInteger(record.partition_position, "event position");
    if (
      record.partition_id !== partitionId ||
      record.partition_position !== afterPosition + 1
    ) {
      throw new Error("Journal returned an invalid Partition sequence");
    }
  }
}
