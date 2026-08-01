import type {
  FeishuCapabilityExecutionStore,
  FeishuCapabilityOutcome,
  FeishuExecutionRecord,
  FeishuResourceOwnership,
  FeishuResourceOwnershipStore,
} from "./contracts.js";

function key(tenantId: string, id: string): string {
  return JSON.stringify([tenantId, id]);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryFeishuProviderStore
  implements FeishuCapabilityExecutionStore, FeishuResourceOwnershipStore {
  private readonly executions = new Map<string, FeishuExecutionRecord>();
  private readonly ownership = new Map<string, FeishuResourceOwnership>();
  private tail: Promise<void> = Promise.resolve();

  private enqueue<T>(operation: () => T): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  begin(
    input: Omit<FeishuExecutionRecord, "outcome" | "completed_at">,
  ): Promise<{
    readonly created: boolean;
    readonly record: FeishuExecutionRecord;
  }> {
    return this.enqueue(() => {
      const storageKey = key(input.tenant_id, input.idempotency_key);
      const existing = this.executions.get(storageKey);
      if (existing !== undefined) {
        if (
          existing.capability_id !== input.capability_id ||
          existing.input_digest !== input.input_digest
        ) {
          throw new Error("Feishu Provider idempotency conflict");
        }
        return { created: false, record: clone(existing) };
      }
      const record: FeishuExecutionRecord = {
        ...clone(input),
        outcome: null,
        completed_at: null,
      };
      this.executions.set(storageKey, record);
      return { created: true, record: clone(record) };
    });
  }

  complete(
    tenantId: string,
    idempotencyKey: string,
    outcome: FeishuCapabilityOutcome,
    completedAt: string,
  ): Promise<void> {
    return this.enqueue(() => {
      const storageKey = key(tenantId, idempotencyKey);
      const current = this.executions.get(storageKey);
      if (current === undefined) throw new Error("Execution record not found");
      if (current.outcome !== null) {
        if (JSON.stringify(current.outcome) !== JSON.stringify(outcome)) {
          throw new Error("Execution outcome conflict");
        }
        return;
      }
      this.executions.set(storageKey, {
        ...current,
        outcome: clone(outcome),
        completed_at: completedAt,
      });
    });
  }

  putOwnership(input: FeishuResourceOwnership): Promise<void> {
    return this.enqueue(() => {
      const storageKey = key(input.tenant_id, input.document_token);
      const existing = this.ownership.get(storageKey);
      if (
        existing !== undefined &&
        existing.create_idempotency_key !== input.create_idempotency_key
      ) {
        throw new Error("Feishu document ownership conflict");
      }
      this.ownership.set(storageKey, clone(existing ?? input));
    });
  }

  getOwnership(
    tenantId: string,
    documentToken: string,
  ): Promise<FeishuResourceOwnership | null> {
    return this.enqueue(() => {
      const value = this.ownership.get(key(tenantId, documentToken));
      return value === undefined ? null : clone(value);
    });
  }

  updateRevision(
    tenantId: string,
    documentToken: string,
    revision: string,
  ): Promise<void> {
    return this.enqueue(() => {
      const storageKey = key(tenantId, documentToken);
      const current = this.ownership.get(storageKey);
      if (current === undefined) return;
      this.ownership.set(storageKey, {
        ...current,
        last_known_revision: revision,
      });
    });
  }

  markDeleted(
    tenantId: string,
    documentToken: string,
    deletedAt: string,
  ): Promise<void> {
    return this.enqueue(() => {
      const storageKey = key(tenantId, documentToken);
      const current = this.ownership.get(storageKey);
      if (current === undefined) throw new Error("Ownership record not found");
      this.ownership.set(storageKey, { ...current, deleted_at: deletedAt });
    });
  }
}
