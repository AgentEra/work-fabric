import type {
  AgentRuntimeStateStore,
  RuntimeCommandRecord,
  RuntimeDeliveryRecord,
  RuntimeRunRecord,
  RuntimeRunState,
} from "@work-fabric/agent-runtime-spi";

const terminalStates = new Set<RuntimeRunState>(["succeeded", "failed", "cancelled"]);
const allowedTransitions: Readonly<Record<RuntimeRunState, readonly RuntimeRunState[]>> = {
  received: ["accepted", "failed", "cancelled"],
  accepted: ["running", "failed", "cancelled"],
  running: ["result_ready", "failed", "cancelled"],
  result_ready: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

const deliveryKey = (tenant: string, delivery: string) =>
  JSON.stringify([tenant, delivery]);
const runKey = (tenant: string, handoff: string) =>
  JSON.stringify([tenant, handoff]);
const commandKey = (
  tenant: string,
  handoff: string,
  idempotencyKey: string,
) => JSON.stringify([tenant, handoff, idempotencyKey]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function addLeaseSeconds(now: string, seconds: number): string {
  return new Date(Date.parse(now) + seconds * 1_000).toISOString();
}

function hasExpired(leaseExpiresAt: string | null, now: string): boolean {
  return leaseExpiresAt === null || Date.parse(leaseExpiresAt) <= Date.parse(now);
}

export class MemoryAgentRuntimeStateStore implements AgentRuntimeStateStore {
  private readonly deliveries = new Map<string, RuntimeDeliveryRecord>();
  private readonly runs = new Map<string, RuntimeRunRecord>();
  private readonly commands = new Map<string, RuntimeCommandRecord>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private closed = false;

  private enqueue<T>(operation: () => T): Promise<T> {
    const result = this.mutationQueue.then(() => {
      if (this.closed) throw new Error("Runtime state store is closed");
      return operation();
    });
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async recordDelivery(input: RuntimeDeliveryRecord): Promise<{ readonly created: boolean; readonly record: RuntimeDeliveryRecord }> {
    const candidate = clone(input);
    return this.enqueue(() => {
      const key = deliveryKey(candidate.tenant_id, candidate.delivery_id);
      const existing = this.deliveries.get(key);
      if (existing !== undefined) return { created: false, record: clone(existing) };
      this.deliveries.set(key, clone(candidate));
      return { created: true, record: clone(candidate) };
    });
  }

  async markDeliveryAcknowledged(tenantId: string, deliveryId: string, acknowledgedAt: string): Promise<boolean> {
    return this.enqueue(() => {
      const key = deliveryKey(tenantId, deliveryId);
      const current = this.deliveries.get(key);
      if (current === undefined || current.acknowledged_at !== null) return false;
      this.deliveries.set(key, clone({ ...current, acknowledged_at: acknowledgedAt }));
      return true;
    });
  }

  async createRunIfAbsent(tenantId: string, handoffId: string, now: string): Promise<{ readonly created: boolean; readonly run: RuntimeRunRecord }> {
    return this.enqueue(() => {
      const key = runKey(tenantId, handoffId);
      const existing = this.runs.get(key);
      if (existing !== undefined) return { created: false, run: clone(existing) };
      const run: RuntimeRunRecord = {
        tenant_id: tenantId,
        handoff_id: handoffId,
        state: "received",
        attempt: 0,
        owner: null,
        fencing_token: 0,
        lease_expires_at: null,
        last_progress_sequence: 0,
        result_digest: null,
        result: null,
        failure_code: null,
        updated_at: now,
      };
      this.runs.set(key, clone(run));
      return { created: true, run: clone(run) };
    });
  }

  async claimRun(input: Parameters<AgentRuntimeStateStore["claimRun"]>[0]): Promise<RuntimeRunRecord | null> {
    const candidate = clone(input);
    return this.enqueue(() => {
      const key = runKey(candidate.tenant_id, candidate.handoff_id);
      const current = this.runs.get(key);
      if (
        current === undefined ||
        terminalStates.has(current.state) ||
        !candidate.allowed_states.includes(current.state) ||
        !hasExpired(current.lease_expires_at, candidate.now)
      ) return null;
      const claimed: RuntimeRunRecord = {
        ...current,
        owner: candidate.owner,
        fencing_token: current.fencing_token + 1,
        lease_expires_at: addLeaseSeconds(candidate.now, candidate.lease_seconds),
        attempt: current.attempt + 1,
        updated_at: candidate.now,
      };
      this.runs.set(key, clone(claimed));
      return clone(claimed);
    });
  }

  async renewRun(tenantId: string, handoffId: string, owner: string, fencingToken: number, now: string, leaseSeconds: number): Promise<boolean> {
    return this.enqueue(() => {
      const key = runKey(tenantId, handoffId);
      const current = this.runs.get(key);
      if (!this.ownsActiveLease(current, owner, fencingToken, now)) return false;
      this.runs.set(key, clone({ ...current, lease_expires_at: addLeaseSeconds(now, leaseSeconds), updated_at: now }));
      return true;
    });
  }

  async transitionRun(input: Parameters<AgentRuntimeStateStore["transitionRun"]>[0]): Promise<boolean> {
    const candidate = clone(input);
    return this.enqueue(() => {
      const key = runKey(candidate.tenant_id, candidate.handoff_id);
      const current = this.runs.get(key);
      if (
        !this.ownsActiveLease(current, candidate.owner, candidate.fencing_token, candidate.now) ||
        current.state !== candidate.expected_state ||
        !allowedTransitions[candidate.expected_state].includes(candidate.next_state)
      ) return false;
      const next: RuntimeRunRecord = {
        ...current,
        state: candidate.next_state,
        updated_at: candidate.now,
        ...(candidate.result_digest === undefined ? {} : { result_digest: candidate.result_digest }),
        ...(candidate.result === undefined ? {} : { result: clone(candidate.result) }),
        ...(candidate.failure_code === undefined ? {} : { failure_code: candidate.failure_code }),
      };
      this.runs.set(key, clone(next));
      return true;
    });
  }

  async checkpointProgress(input: Parameters<AgentRuntimeStateStore["checkpointProgress"]>[0]): Promise<boolean> {
    const candidate = clone(input);
    return this.enqueue(() => {
      const key = runKey(candidate.tenant_id, candidate.handoff_id);
      const current = this.runs.get(key);
      if (!this.ownsActiveLease(current, candidate.owner, candidate.fencing_token, candidate.now) || candidate.sequence <= current.last_progress_sequence) return false;
      this.runs.set(key, clone({ ...current, last_progress_sequence: candidate.sequence, updated_at: candidate.now }));
      return true;
    });
  }

  async recordCommand(input: RuntimeCommandRecord): Promise<{ readonly created: boolean; readonly record: RuntimeCommandRecord }> {
    const candidate = clone(input);
    return this.enqueue(() => {
      const key = commandKey(candidate.tenant_id, candidate.handoff_id, candidate.idempotency_key);
      const existing = this.commands.get(key);
      if (existing !== undefined) {
        if (existing.command !== candidate.command || existing.resource_version !== candidate.resource_version) {
          throw new Error("Runtime command idempotency conflict");
        }
        return { created: false, record: clone(existing) };
      }
      this.commands.set(key, clone(candidate));
      return { created: true, record: clone(candidate) };
    });
  }

  async listCommands(tenantId: string, handoffId: string): Promise<readonly RuntimeCommandRecord[]> {
    return this.enqueue(() => [...this.commands.values()]
      .filter((record) => record.tenant_id === tenantId && record.handoff_id === handoffId)
      .map((record) => clone(record)));
  }

  async getRun(tenantId: string, handoffId: string): Promise<RuntimeRunRecord | null> {
    return this.enqueue(() => {
      const run = this.runs.get(runKey(tenantId, handoffId));
      return run === undefined ? null : clone(run);
    });
  }

  async listRecoverable(tenantId: string, now: string, limit: number): Promise<readonly RuntimeRunRecord[]> {
    return this.enqueue(() => [...this.runs.values()]
      .filter((run) => run.tenant_id === tenantId && !terminalStates.has(run.state) && hasExpired(run.lease_expires_at, now))
      .slice(0, limit)
      .map((run) => clone(run)));
  }

  async close(): Promise<void> {
    const result = this.mutationQueue.then(() => {
      this.closed = true;
      this.deliveries.clear();
      this.runs.clear();
      this.commands.clear();
    });
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private ownsActiveLease(
    run: RuntimeRunRecord | undefined,
    owner: string,
    fencingToken: number,
    now: string,
  ): run is RuntimeRunRecord {
    return run !== undefined &&
      run.owner === owner &&
      run.fencing_token === fencingToken &&
      !hasExpired(run.lease_expires_at, now);
  }
}
