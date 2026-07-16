import type { WorkerLease, WorkerLeaseStore } from "@work-fabric/exchange-spi";

export class FakeLeaseStore implements WorkerLeaseStore {
  private current: WorkerLease | null = null;
  private expired = false;
  private nextToken = 1;

  expireCurrent(): void {
    this.expired = true;
  }

  async acquire(
    leaseKey: string,
    owner: string,
    now: string,
    leaseSeconds: number,
  ): Promise<WorkerLease | null> {
    if (this.current !== null && !this.expired) return null;
    const lease = {
      lease_key: leaseKey,
      owner,
      fencing_token: this.nextToken++,
      expires_at: new Date(Date.parse(now) + leaseSeconds * 1_000).toISOString(),
    };
    this.current = lease;
    this.expired = false;
    return structuredClone(lease);
  }

  async renew(
    leaseKey: string,
    owner: string,
    fencingToken: number,
    now: string,
    leaseSeconds: number,
  ): Promise<boolean> {
    if (
      this.current === null || this.expired ||
      this.current.lease_key !== leaseKey || this.current.owner !== owner ||
      this.current.fencing_token !== fencingToken
    ) return false;
    this.current = {
      ...this.current,
      expires_at: new Date(Date.parse(now) + leaseSeconds * 1_000).toISOString(),
    };
    return true;
  }

  async release(
    leaseKey: string,
    owner: string,
    fencingToken: number,
  ): Promise<boolean> {
    if (
      this.current === null || this.current.lease_key !== leaseKey ||
      this.current.owner !== owner || this.current.fencing_token !== fencingToken
    ) return false;
    this.current = null;
    return true;
  }
}

export class ManualRepeatingTimer {
  private callback: (() => Promise<void>) | undefined;
  interval: number | undefined;
  stopped = false;

  scheduleEvery(intervalMs: number, callback: () => Promise<void>) {
    this.interval = intervalMs;
    this.callback = callback;
    return {
      stop: async () => {
        this.stopped = true;
      },
    };
  }

  async tick(): Promise<void> {
    await this.callback?.();
  }
}
