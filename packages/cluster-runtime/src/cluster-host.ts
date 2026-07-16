import {
  PARTITION_WORK_KINDS,
  clusterIdentifier,
  type ClusterHostLimits,
  type PartitionWakeupConsumer,
  type PartitionWorkCatalog,
  type PartitionWorkItem,
  validateClusterLimits,
} from "@work-fabric/cluster-spi";
import type { SemanticTelemetryObserver } from "@work-fabric/operations-spi";

import type { ClusterClock } from "./lease-guard.js";
import type { PartitionWorkerResult } from "./partition-worker.js";
import { TenantFairReadyQueue, type ReadyQueueOfferResult } from "./ready-queue.js";
import { observeCluster } from "./telemetry.js";

export interface ClusterPartitionRunner {
  run(item: PartitionWorkItem, signal: AbortSignal): Promise<PartitionWorkerResult>;
}

export interface ClusterHostDependencies {
  readonly catalog: PartitionWorkCatalog;
  readonly wakeup_consumer?: PartitionWakeupConsumer;
  readonly tenant_ids: readonly string[];
  readonly worker: ClusterPartitionRunner;
  readonly clock: ClusterClock;
  readonly telemetry?: SemanticTelemetryObserver;
}

export type ClusterHostState = "idle" | "running" | "draining" | "stopped";

export interface ClusterHostSnapshot {
  readonly state: ClusterHostState;
  readonly queue_depth: number;
  readonly in_flight_turns: number;
  readonly completed_turns: number;
  readonly failed_turns: number;
  readonly lease_losses: number;
  readonly lease_unavailable: number;
  readonly dropped_hints: number;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    timer.unref?.();
    const aborted = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      reject(abortError(signal));
    };
    function done(): void {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

export class ClusterHost {
  private readonly limits: ClusterHostLimits;
  private readonly queue: TenantFairReadyQueue;
  private readonly active = new Set<Promise<void>>();
  private readonly intake = new AbortController();
  private stateValue: ClusterHostState = "idle";
  private pollInFlight = false;
  private drainPromise: Promise<ClusterHostSnapshot> | undefined;
  private completedTurns = 0;
  private failedTurns = 0;
  private leaseLosses = 0;
  private leaseUnavailable = 0;
  private droppedHints = 0;

  constructor(
    private readonly dependencies: ClusterHostDependencies,
    limits: ClusterHostLimits,
  ) {
    this.limits = validateClusterLimits(limits);
    if (
      dependencies.tenant_ids.length === 0 ||
      dependencies.tenant_ids.length > this.limits.max_tenants_per_host
    ) {
      throw new RangeError("tenant_ids exceeds max_tenants_per_host or is empty");
    }
    const tenants = new Set<string>();
    for (const tenantId of dependencies.tenant_ids) {
      clusterIdentifier(tenantId, "tenant_id");
      if (tenants.has(tenantId)) throw new TypeError("tenant_ids must be unique");
      tenants.add(tenantId);
    }
    this.queue = new TenantFairReadyQueue(this.limits.max_ready_items);
  }

  start(): void {
    if (this.stateValue !== "idle") {
      if (this.stateValue === "running") return;
      throw new Error("cluster host cannot be restarted");
    }
    this.stateValue = "running";
    void this.pollLoop();
    if (this.dependencies.wakeup_consumer !== undefined) void this.ingestLoop();
  }

  async pollOnce(): Promise<"polled" | "already_polling" | "stopped"> {
    if (this.isStopping()) {
      return "stopped";
    }
    if (this.pollInFlight) return "already_polling";
    this.pollInFlight = true;
    const startedAt = performance.now();
    let failed = false;
    try {
      for (const tenantId of this.dependencies.tenant_ids) {
        if (this.isStopping() || this.queue.size >= this.limits.max_ready_items) break;
        try {
          const page = await this.dependencies.catalog.scanReady({
            tenant_id: tenantId,
            kinds: PARTITION_WORK_KINDS,
            available_at_or_before: this.dependencies.clock.now(),
            limit: Math.min(
              this.limits.catalog_page_size,
              this.limits.max_ready_items - this.queue.size,
            ),
          });
          if (this.isStopping()) break;
          for (const item of page.items) this.enqueue(item, false);
        } catch {
          failed = true;
        }
      }
      return "polled";
    } finally {
      this.pollInFlight = false;
      observeCluster(
        this.dependencies.telemetry,
        "cluster_catalog_scan",
        failed ? "retryable" : "succeeded",
        performance.now() - startedAt,
      );
    }
  }

  async ingestOnce(): Promise<
    ReadyQueueOfferResult | "empty" | "unavailable" | "stopped"
  > {
    if (this.isStopping()) {
      return "stopped";
    }
    const consumer = this.dependencies.wakeup_consumer;
    if (consumer === undefined) return "unavailable";
    const delivery = await consumer.next(this.intake.signal);
    if (delivery === null) return "empty";
    if (this.isStopping()) {
      await delivery.acknowledge();
      return "stopped";
    }
    try {
      const result = this.enqueue({
        tenant_id: delivery.wakeup.tenant_id,
        partition_id: delivery.wakeup.partition_id,
        kind: delivery.wakeup.kind,
        observed_position: delivery.wakeup.observed_position,
        available_at: delivery.wakeup.occurred_at,
      }, true);
      await delivery.acknowledge();
      return result;
    } catch (error) {
      await delivery.retry().catch(() => undefined);
      throw error;
    }
  }

  async pump(): Promise<void> {
    if (this.isStopping()) return;
    while (
      this.active.size < this.limits.max_concurrent_turns &&
      !this.isStopping()
    ) {
      const item = this.queue.take();
      if (item === null) break;
      const turnSignal = new AbortController().signal;
      let task: Promise<void>;
      task = this.dependencies.worker.run(item, turnSignal)
        .then((result) => this.recordTurn(result))
        .catch(() => {
          this.failedTurns += 1;
          observeCluster(
            this.dependencies.telemetry,
            "cluster_turn",
            "failed",
            0,
          );
        })
        .finally(() => {
          this.active.delete(task);
          if (this.stateValue === "idle" || this.stateValue === "running") {
            void this.pump();
          }
        });
      this.active.add(task);
    }
  }

  drain(): Promise<ClusterHostSnapshot> {
    if (this.drainPromise !== undefined) return this.drainPromise;
    this.drainPromise = this.performDrain();
    return this.drainPromise;
  }

  snapshot(): ClusterHostSnapshot {
    return {
      state: this.stateValue,
      queue_depth: this.queue.size,
      in_flight_turns: this.active.size,
      completed_turns: this.completedTurns,
      failed_turns: this.failedTurns,
      lease_losses: this.leaseLosses,
      lease_unavailable: this.leaseUnavailable,
      dropped_hints: this.droppedHints,
    };
  }

  private enqueue(item: PartitionWorkItem, hint: boolean): ReadyQueueOfferResult {
    const result = this.queue.offer(item);
    if (result === "dropped") {
      if (hint) this.droppedHints += 1;
      observeCluster(
        this.dependencies.telemetry,
        "cluster_queue_overload",
        "retryable",
        0,
      );
    }
    return result;
  }

  private isStopping(): boolean {
    return this.stateValue === "draining" || this.stateValue === "stopped";
  }

  private recordTurn(result: PartitionWorkerResult): void {
    if (result.kind === "lease_unavailable") {
      this.leaseUnavailable += 1;
      observeCluster(
        this.dependencies.telemetry,
        "cluster_lease_acquire",
        "conflicted",
        0,
      );
      return;
    }
    if (result.kind === "failed") {
      this.failedTurns += 1;
      if (result.code === "partition_lease_lost") {
        this.leaseLosses += 1;
        observeCluster(
          this.dependencies.telemetry,
          "cluster_lease_lost",
          "conflicted",
          0,
        );
      }
      observeCluster(
        this.dependencies.telemetry,
        "cluster_turn",
        result.code === "partition_lease_lost" ? "conflicted" : "failed",
        0,
      );
      return;
    }
    this.completedTurns += 1;
    observeCluster(
      this.dependencies.telemetry,
      "cluster_lease_acquire",
      "succeeded",
      0,
    );
    observeCluster(
      this.dependencies.telemetry,
      "cluster_turn",
      result.outcome.outcome === "advanced" || result.outcome.outcome === "idle"
        ? "succeeded"
        : "retryable",
      0,
      Math.max(1, result.outcome.processed),
    );
  }

  private async pollLoop(): Promise<void> {
    while (this.stateValue === "running") {
      await this.pollOnce();
      await this.pump();
      try {
        await delay(this.limits.poll_interval_ms, this.intake.signal);
      } catch {
        return;
      }
    }
  }

  private async ingestLoop(): Promise<void> {
    while (this.stateValue === "running") {
      try {
        const result = await this.ingestOnce();
        await this.pump();
        if (result === "empty") {
          await delay(this.limits.poll_interval_ms, this.intake.signal);
        }
      } catch {
        if (this.intake.signal.aborted) return;
        try {
          await delay(this.limits.poll_interval_ms, this.intake.signal);
        } catch {
          return;
        }
      }
    }
  }

  private async performDrain(): Promise<ClusterHostSnapshot> {
    const startedAt = performance.now();
    this.stateValue = "draining";
    this.intake.abort(new Error("cluster host draining"));
    this.queue.clear();
    const active = [...this.active];
    if (active.length > 0) {
      let timeout: NodeJS.Timeout | undefined;
      const expired = new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, this.limits.drain_timeout_seconds * 1_000);
        timeout.unref?.();
      });
      await Promise.race([
        Promise.allSettled(active).then(() => undefined),
        expired,
      ]);
      if (timeout !== undefined) clearTimeout(timeout);
    }
    this.stateValue = "stopped";
    observeCluster(
      this.dependencies.telemetry,
      "cluster_drain",
      "succeeded",
      performance.now() - startedAt,
    );
    return this.snapshot();
  }
}
