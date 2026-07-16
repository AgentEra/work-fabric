import {
  clusterIdentifier,
  type PartitionTurnHandler,
  type PartitionTurnOutcome,
  type PartitionWorkItem,
  type PartitionWorkKind,
  validatePartitionWorkItem,
} from "@work-fabric/cluster-spi";
import type { WorkerLeaseStore } from "@work-fabric/exchange-spi";

import { ClusterError, type ClusterErrorCode } from "./errors.js";
import {
  type ClusterClock,
  type ClusterRepeatingTimer,
  PartitionLeaseGuard,
} from "./lease-guard.js";

export interface PartitionWorkerOptions {
  readonly owner: string;
  readonly clock: ClusterClock;
  readonly lease_store_for_tenant: (
    tenantId: string,
  ) => WorkerLeaseStore | Promise<WorkerLeaseStore>;
  readonly handlers: readonly PartitionTurnHandler[];
  readonly timer?: ClusterRepeatingTimer;
  readonly lease_seconds: number;
  readonly turn_item_limit: number;
}

export type PartitionWorkerResult =
  | { readonly kind: "lease_unavailable" }
  | {
      readonly kind: "ran";
      readonly outcome: PartitionTurnOutcome;
      readonly fencing_token: number;
    }
  | { readonly kind: "failed"; readonly code: ClusterErrorCode };

function validateOutcome(
  outcome: PartitionTurnOutcome,
  limit: number,
): PartitionTurnOutcome {
  if (
    !Number.isSafeInteger(outcome.processed) || outcome.processed < 0 ||
    outcome.processed > limit ||
    (outcome.outcome === "idle" && outcome.processed !== 0)
  ) throw new ClusterError("partition_turn_failed");
  return outcome;
}

export class PartitionWorker {
  private readonly handlers = new Map<PartitionWorkKind, PartitionTurnHandler>();

  constructor(private readonly options: PartitionWorkerOptions) {
    clusterIdentifier(options.owner, "owner");
    if (
      !Number.isSafeInteger(options.lease_seconds) ||
      options.lease_seconds < 10 || options.lease_seconds > 300
    ) throw new RangeError("lease_seconds must be between 10 and 300");
    if (
      !Number.isSafeInteger(options.turn_item_limit) ||
      options.turn_item_limit <= 0 || options.turn_item_limit > 10_000
    ) throw new RangeError("turn_item_limit must be between 1 and 10000");
    for (const handler of options.handlers) {
      if (this.handlers.has(handler.kind)) {
        throw new TypeError(`duplicate handler for ${handler.kind}`);
      }
      this.handlers.set(handler.kind, handler);
    }
  }

  async run(
    candidate: PartitionWorkItem,
    signal: AbortSignal,
  ): Promise<PartitionWorkerResult> {
    let item: PartitionWorkItem;
    try {
      item = validatePartitionWorkItem(candidate);
    } catch {
      return { kind: "failed", code: "partition_turn_failed" };
    }
    const handler = this.handlers.get(item.kind);
    if (handler === undefined) {
      return { kind: "failed", code: "partition_turn_failed" };
    }

    const turnController = new AbortController();
    const abortTurn = (): void => turnController.abort(signal.reason);
    if (signal.aborted) abortTurn();
    else signal.addEventListener("abort", abortTurn, { once: true });

    let guard: PartitionLeaseGuard | undefined;
    let heartbeat: { stop(): Promise<void> } | undefined;
    try {
      const store = await this.options.lease_store_for_tenant(item.tenant_id);
      guard = new PartitionLeaseGuard({
        store,
        clock: this.options.clock,
        ...(this.options.timer === undefined ? {} : { timer: this.options.timer }),
        lease_key: `partition:${item.kind}:${item.partition_id}`,
        owner: this.options.owner,
        lease_seconds: this.options.lease_seconds,
        on_lost: () => turnController.abort(
          new ClusterError("partition_lease_lost"),
        ),
      });
      if (!await guard.acquire()) return { kind: "lease_unavailable" };
      heartbeat = guard.startHeartbeat(turnController.signal);
      await guard.assertOwnership();
      if (turnController.signal.aborted) {
        throw turnController.signal.reason instanceof ClusterError
          ? turnController.signal.reason
          : new ClusterError("partition_turn_failed");
      }
      const fencingToken = guard.fencingToken;
      const outcome = validateOutcome(await handler.run({
        item: structuredClone(item),
        owner: this.options.owner,
        fencing_token: fencingToken,
        signal: turnController.signal,
        assertOwnership: () => guard?.assertOwnership() ?? Promise.reject(
          new ClusterError("partition_lease_lost"),
        ),
      }, this.options.turn_item_limit), this.options.turn_item_limit);
      if (turnController.signal.reason instanceof ClusterError) {
        throw turnController.signal.reason;
      }
      return { kind: "ran", outcome, fencing_token: fencingToken };
    } catch (error) {
      return {
        kind: "failed",
        code: error instanceof ClusterError
          ? error.code
          : "partition_turn_failed",
      };
    } finally {
      signal.removeEventListener("abort", abortTurn);
      await heartbeat?.stop().catch(() => undefined);
      await guard?.release().catch(() => false);
    }
  }
}
