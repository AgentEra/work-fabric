import { createHash } from "node:crypto";

import {
  type PartitionTurnContext,
  type PartitionTurnHandler,
  type PartitionTurnOutcome,
  type PartitionWakeup,
  type PartitionWakeupPublisher,
  type PartitionWorkKind,
} from "@work-fabric/cluster-spi";
import {
  compareUtcTimestamps,
  parseUtcTimestamp,
  type OutboxRecord,
  type OutboxStore,
} from "@work-fabric/exchange-spi";

import type { ClusterClock } from "./lease-guard.js";

interface RuntimeFence {
  assertOwnership(): Promise<void>;
}

function requireKind(
  context: PartitionTurnContext,
  expected: PartitionWorkKind,
): void {
  if (context.item.kind !== expected) {
    throw new TypeError(`handler requires ${expected}`);
  }
}

function metadataWakeupId(
  record: OutboxRecord,
  kind: PartitionWorkKind,
): string {
  const digest = createHash("sha256")
    .update(record.tenant_id)
    .update("\u0000")
    .update(record.outbox_id)
    .update("\u0000")
    .update(kind)
    .digest("base64url");
  return `wakeup_${digest}`;
}

export interface OutboxRetryPolicy {
  nextAttemptAt(attempt: number, now: string): string;
}

export interface OutboxWakeupHandlerOptions {
  readonly store_for_tenant: (
    tenantId: string,
  ) => OutboxStore | Promise<OutboxStore>;
  readonly publisher: PartitionWakeupPublisher;
  readonly clock: ClusterClock;
  readonly retry_policy: OutboxRetryPolicy;
  readonly row_lease_seconds: number;
}

const DOWNSTREAM_WORK = [
  "handoff_projection",
  "collaboration_projection",
  "signal_delivery",
] as const;

function validateClaimedRecord(
  record: OutboxRecord,
  context: PartitionTurnContext,
): void {
  if (
    record.tenant_id !== context.item.tenant_id ||
    record.partition_id !== context.item.partition_id ||
    record.event.tenant_id !== record.tenant_id ||
    record.event.partition_id !== record.partition_id ||
    record.event.partition_position !== record.position ||
    record.lease_owner !== context.owner ||
    !Number.isSafeInteger(record.fencing_token) || record.fencing_token <= 0 ||
    !Number.isSafeInteger(record.position) || record.position <= 0
  ) throw new TypeError("claimed Outbox identity is invalid");
}

export class OutboxWakeupHandler implements PartitionTurnHandler {
  readonly kind = "outbox_wakeup" as const;

  constructor(private readonly options: OutboxWakeupHandlerOptions) {
    if (
      !Number.isSafeInteger(options.row_lease_seconds) ||
      options.row_lease_seconds < 10 || options.row_lease_seconds > 300
    ) throw new RangeError("row_lease_seconds must be between 10 and 300");
  }

  async run(
    context: PartitionTurnContext,
    limit: number,
  ): Promise<PartitionTurnOutcome> {
    requireKind(context, this.kind);
    await context.assertOwnership();
    const now = this.options.clock.now();
    parseUtcTimestamp(now, "Outbox handler clock");
    const store = await this.options.store_for_tenant(context.item.tenant_id);
    const rows = await store.claim({
      owner: context.owner,
      now,
      lease_seconds: this.options.row_lease_seconds,
      limit,
      tenant_id: context.item.tenant_id,
      partition_id: context.item.partition_id,
    });
    if (rows.length === 0) return { outcome: "idle", processed: 0 };
    if (rows.length > limit) throw new RangeError("Outbox claim exceeded limit");

    let processed = 0;
    for (const record of rows) {
      validateClaimedRecord(record, context);
      let publicationFailed = false;
      for (const kind of DOWNSTREAM_WORK) {
        await context.assertOwnership();
        const wakeup: PartitionWakeup = {
          wakeup_id: metadataWakeupId(record, kind),
          exchange_id: record.event.exchange_id,
          tenant_id: record.tenant_id,
          partition_id: record.partition_id,
          kind,
          observed_position: record.position,
          occurred_at: now,
        };
        try {
          if (await this.options.publisher.publish(wakeup) !== "accepted") {
            publicationFailed = true;
            break;
          }
        } catch {
          publicationFailed = true;
          break;
        }
      }

      await context.assertOwnership();
      if (publicationFailed) {
        const retryAt = this.options.retry_policy.nextAttemptAt(
          record.attempt,
          now,
        );
        parseUtcTimestamp(retryAt, "Outbox retry time");
        if (compareUtcTimestamps(retryAt, now) <= 0) {
          throw new RangeError("Outbox retry time must follow now");
        }
        const recorded = await store.recordFailure(
          record.outbox_id,
          context.owner,
          record.fencing_token,
          retryAt,
        );
        return {
          outcome: recorded ? "waiting" : "blocked",
          processed: recorded ? processed + 1 : processed,
        };
      }

      const published = await store.markPublished(
        record.outbox_id,
        context.owner,
        record.fencing_token,
      );
      if (!published) return { outcome: "blocked", processed };
      processed += 1;
    }
    return { outcome: "advanced", processed };
  }
}

type ProjectionPortResult =
  | { readonly kind: "idle"; readonly position: number }
  | {
      readonly kind: "advanced";
      readonly position: number;
      readonly processed: number;
    }
  | { readonly kind: "waiting"; readonly position: number }
  | { readonly kind: "blocked"; readonly position: number };

interface ProjectionPort {
  runPartition(
    partitionId: string,
    limit: number,
    fence?: RuntimeFence,
  ): Promise<ProjectionPortResult>;
}

function projectionOutcome(result: ProjectionPortResult): PartitionTurnOutcome {
  if (result.kind === "idle") return { outcome: "idle", processed: 0 };
  if (result.kind === "advanced") {
    return { outcome: "advanced", processed: result.processed };
  }
  return { outcome: result.kind, processed: 0 };
}

abstract class ProjectionHandler implements PartitionTurnHandler {
  abstract readonly kind: "handoff_projection" | "collaboration_projection";

  constructor(private readonly projector: ProjectionPort) {}

  async run(
    context: PartitionTurnContext,
    limit: number,
  ): Promise<PartitionTurnOutcome> {
    requireKind(context, this.kind);
    await context.assertOwnership();
    return projectionOutcome(await this.projector.runPartition(
      context.item.partition_id,
      limit,
      context,
    ));
  }
}

export class HandoffProjectionHandler extends ProjectionHandler {
  readonly kind = "handoff_projection" as const;
}

export class CollaborationProjectionHandler extends ProjectionHandler {
  readonly kind = "collaboration_projection" as const;
}

export interface SignalDispatcherPort {
  dispatchPartitionTurn(
    partitionId: string,
    tenantId: string,
    limit: number,
    fence?: RuntimeFence,
  ): Promise<{ readonly processed: number }>;
}

export class SignalDeliveryHandler implements PartitionTurnHandler {
  readonly kind = "signal_delivery" as const;

  constructor(private readonly dispatcher: SignalDispatcherPort) {}

  async run(
    context: PartitionTurnContext,
    limit: number,
  ): Promise<PartitionTurnOutcome> {
    requireKind(context, this.kind);
    await context.assertOwnership();
    const result = await this.dispatcher.dispatchPartitionTurn(
      context.item.partition_id,
      context.item.tenant_id,
      limit,
      context,
    );
    if (
      !Number.isSafeInteger(result.processed) || result.processed < 0 ||
      result.processed > limit
    ) throw new RangeError("Signal Dispatcher processed count is invalid");
    return result.processed === 0
      ? { outcome: "idle", processed: 0 }
      : { outcome: "advanced", processed: result.processed };
  }
}
