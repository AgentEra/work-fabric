import {
  clusterIdentifier,
  clusterPositive,
} from "@work-fabric/cluster-spi";
import { parseUtcTimestamp, type WorkerLease, type WorkerLeaseStore } from "@work-fabric/exchange-spi";

import { ClusterError } from "./errors.js";

export interface ClusterClock {
  now(): string;
}

export interface RepeatingTask {
  stop(): Promise<void>;
}

export interface ClusterRepeatingTimer {
  scheduleEvery(
    intervalMs: number,
    callback: () => Promise<void>,
  ): RepeatingTask;
}

export class NodeRepeatingTimer implements ClusterRepeatingTimer {
  scheduleEvery(
    intervalMs: number,
    callback: () => Promise<void>,
  ): RepeatingTask {
    let stopped = false;
    let timeout: NodeJS.Timeout | undefined;
    let inFlight = Promise.resolve();
    const schedule = (): void => {
      if (stopped) return;
      timeout = setTimeout(() => {
        inFlight = callback().catch(() => undefined).then(schedule);
      }, intervalMs);
      timeout.unref?.();
    };
    schedule();
    return {
      stop: async () => {
        stopped = true;
        if (timeout !== undefined) clearTimeout(timeout);
        await inFlight;
      },
    };
  }
}

export interface PartitionLeaseGuardOptions {
  readonly store: WorkerLeaseStore;
  readonly clock: ClusterClock;
  readonly timer?: ClusterRepeatingTimer;
  readonly lease_key: string;
  readonly owner: string;
  readonly lease_seconds: number;
  readonly on_lost?: () => void;
}

function validateLease(lease: WorkerLease, leaseKey: string, owner: string): void {
  if (lease.lease_key !== leaseKey || lease.owner !== owner) {
    throw new ClusterError("partition_turn_failed");
  }
  clusterPositive(lease.fencing_token, "fencing_token");
  parseUtcTimestamp(lease.expires_at, "lease.expires_at");
}

export class PartitionLeaseGuard {
  private lease: WorkerLease | null = null;
  private lost = false;
  private readonly timer: ClusterRepeatingTimer;

  constructor(private readonly options: PartitionLeaseGuardOptions) {
    clusterIdentifier(options.lease_key, "lease_key");
    clusterIdentifier(options.owner, "owner");
    if (
      !Number.isSafeInteger(options.lease_seconds) ||
      options.lease_seconds < 10 || options.lease_seconds > 300
    ) throw new RangeError("lease_seconds must be between 10 and 300");
    this.timer = options.timer ?? new NodeRepeatingTimer();
  }

  get fencingToken(): number {
    if (this.lease === null) throw new ClusterError("partition_turn_failed");
    return this.lease.fencing_token;
  }

  async acquire(): Promise<boolean> {
    if (this.lease !== null) throw new ClusterError("partition_turn_failed");
    const now = this.options.clock.now();
    parseUtcTimestamp(now, "cluster clock");
    const lease = await this.options.store.acquire(
      this.options.lease_key,
      this.options.owner,
      now,
      this.options.lease_seconds,
    );
    if (lease === null) return false;
    validateLease(lease, this.options.lease_key, this.options.owner);
    this.lease = structuredClone(lease);
    return true;
  }

  async assertOwnership(): Promise<void> {
    if (this.lease === null || this.lost) {
      this.markLost();
      throw new ClusterError("partition_lease_lost");
    }
    const now = this.options.clock.now();
    parseUtcTimestamp(now, "cluster clock");
    const renewed = await this.options.store.renew(
      this.options.lease_key,
      this.options.owner,
      this.lease.fencing_token,
      now,
      this.options.lease_seconds,
    );
    if (!renewed) {
      this.markLost();
      throw new ClusterError("partition_lease_lost");
    }
  }

  startHeartbeat(signal: AbortSignal): RepeatingTask {
    if (this.lease === null) throw new ClusterError("partition_turn_failed");
    const intervalMs = Math.floor(this.options.lease_seconds * 1_000 / 3);
    return this.timer.scheduleEvery(intervalMs, async () => {
      if (signal.aborted || this.lost) return;
      try {
        await this.assertOwnership();
      } catch (error) {
        if (!(error instanceof ClusterError)) this.markLost();
      }
    });
  }

  async release(): Promise<boolean> {
    const lease = this.lease;
    if (lease === null) return false;
    this.lease = null;
    return this.options.store.release(
      this.options.lease_key,
      this.options.owner,
      lease.fencing_token,
    );
  }

  private markLost(): void {
    if (this.lost) return;
    this.lost = true;
    this.options.on_lost?.();
  }
}
