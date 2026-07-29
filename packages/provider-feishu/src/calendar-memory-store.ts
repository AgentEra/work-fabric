import type {
  CalendarBinding,
  CalendarEventOwnership,
  CalendarExecutionRecord,
  FeishuCalendarStore,
} from "./calendar-contracts.js";

function key(tenantId: string, value: string): string {
  return JSON.stringify([tenantId, value]);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function same<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function bindingConflict(): never {
  throw new Error("calendar_binding_version_conflict");
}

function executionConflict(): never {
  throw new Error("calendar_execution_version_conflict");
}

function eventConflict(): never {
  throw new Error("calendar_event_version_conflict");
}

export class MemoryFeishuCalendarStore implements FeishuCalendarStore {
  private readonly bindings = new Map<string, CalendarBinding>();
  private readonly bindingResources = new Map<string, string>();
  private readonly executions = new Map<string, CalendarExecutionRecord>();
  private readonly events = new Map<string, CalendarEventOwnership>();
  private readonly eventCreateKeys = new Map<string, string>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  private enqueue<T>(operation: () => T): Promise<T> {
    const result = this.tail.then(() => {
      if (this.closed) throw new Error("Feishu Calendar store is closed");
      return operation();
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  bind(
    input: Omit<CalendarBinding, "version">,
    expectedVersion: number,
  ): Promise<CalendarBinding> {
    return this.enqueue(() => {
      const storageKey = key(input.tenant_id, input.alias);
      const existing = this.bindings.get(storageKey);
      if (existing === undefined) {
        if (expectedVersion !== 0) bindingConflict();
        const resourceKey = key(input.tenant_id, input.resource_uri);
        if (this.bindingResources.has(resourceKey)) {
          throw new Error("calendar_binding_resource_conflict");
        }
        if (
          input.is_default &&
          [...this.bindings.values()].some((binding) =>
            binding.tenant_id === input.tenant_id &&
            binding.is_default
          )
        ) throw new Error("calendar_default_conflict");
        const created: CalendarBinding = { ...clone(input), version: 1 };
        this.bindings.set(storageKey, created);
        this.bindingResources.set(resourceKey, storageKey);
        return clone(created);
      }
      const candidate: CalendarBinding = {
        ...clone(input),
        version: existing.version,
      };
      if (expectedVersion === 0 && same(existing, candidate)) {
        return clone(existing);
      }
      if (existing.version !== expectedVersion) bindingConflict();
      const resourceKey = key(input.tenant_id, input.resource_uri);
      const resourceOwner = this.bindingResources.get(resourceKey);
      if (resourceOwner !== undefined && resourceOwner !== storageKey) {
        throw new Error("calendar_binding_resource_conflict");
      }
      if (
        input.is_default &&
        [...this.bindings.values()].some((binding) =>
          binding.tenant_id === input.tenant_id &&
          binding.alias !== input.alias &&
          binding.is_default
        )
      ) throw new Error("calendar_default_conflict");
      this.bindingResources.delete(
        key(existing.tenant_id, existing.resource_uri),
      );
      const updated: CalendarBinding = {
        ...clone(input),
        created_at: existing.created_at,
        version: existing.version + 1,
      };
      this.bindings.set(storageKey, updated);
      this.bindingResources.set(resourceKey, storageKey);
      return clone(updated);
    });
  }

  getBinding(
    tenantId: string,
    alias: string,
  ): Promise<CalendarBinding | null> {
    return this.enqueue(() => {
      const value = this.bindings.get(key(tenantId, alias));
      return value === undefined ? null : clone(value);
    });
  }

  getDefault(tenantId: string): Promise<CalendarBinding | null> {
    return this.enqueue(() => {
      const value = [...this.bindings.values()].find((binding) =>
        binding.tenant_id === tenantId &&
        binding.is_default &&
        binding.active
      );
      return value === undefined ? null : clone(value);
    });
  }

  listBindings(input: {
    readonly tenant_id: string;
    readonly after_alias?: string;
    readonly limit: number;
  }): Promise<{
    readonly items: readonly CalendarBinding[];
    readonly next_after_alias: string | null;
  }> {
    return this.enqueue(() => {
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 100
      ) throw new RangeError("calendar_binding_page_invalid");
      const matches = [...this.bindings.values()]
        .filter((binding) =>
          binding.tenant_id === input.tenant_id &&
          (
            input.after_alias === undefined ||
            binding.alias > input.after_alias
          )
        )
        .sort((left, right) => left.alias.localeCompare(right.alias));
      const items = matches.slice(0, input.limit).map(clone);
      return {
        items,
        next_after_alias: matches.length > items.length
          ? items.at(-1)!.alias
          : null,
      };
    });
  }

  setDefault(input: {
    readonly tenant_id: string;
    readonly alias: string;
    readonly expected_version: number;
    readonly updated_at: string;
  }): Promise<CalendarBinding> {
    return this.enqueue(() => {
      const selectedKey = key(input.tenant_id, input.alias);
      const selected = this.bindings.get(selectedKey);
      if (
        selected === undefined ||
        selected.version !== input.expected_version
      ) bindingConflict();
      if (selected.is_default) return clone(selected);
      for (const [storageKey, binding] of this.bindings) {
        if (
          binding.tenant_id === input.tenant_id &&
          binding.is_default
        ) {
          this.bindings.set(storageKey, {
            ...binding,
            is_default: false,
            version: binding.version + 1,
            updated_at: input.updated_at,
          });
        }
      }
      const updated: CalendarBinding = {
        ...selected,
        is_default: true,
        version: selected.version + 1,
        updated_at: input.updated_at,
      };
      this.bindings.set(selectedKey, updated);
      return clone(updated);
    });
  }

  beginExecution(input: {
    readonly tenant_id: string;
    readonly idempotency_key: string;
    readonly capability_id: string;
    readonly input_digest: `sha256:${string}`;
    readonly created_at: string;
  }): Promise<{
    readonly created: boolean;
    readonly record: CalendarExecutionRecord;
  }> {
    return this.enqueue(() => {
      const storageKey = key(input.tenant_id, input.idempotency_key);
      const existing = this.executions.get(storageKey);
      if (existing !== undefined) {
        if (
          existing.capability_id !== input.capability_id ||
          existing.input_digest !== input.input_digest
        ) throw new Error("calendar_execution_idempotency_conflict");
        return { created: false, record: clone(existing) };
      }
      const record: CalendarExecutionRecord = {
        ...clone(input),
        state: "started",
        event_resource_uri: null,
        outcome: null,
        version: 1,
        updated_at: input.created_at,
      };
      this.executions.set(storageKey, record);
      return { created: true, record: clone(record) };
    });
  }

  checkpoint(
    input: Parameters<FeishuCalendarStore["checkpoint"]>[0],
  ): Promise<CalendarExecutionRecord> {
    return this.enqueue(() => {
      const storageKey = key(input.tenant_id, input.idempotency_key);
      const current = this.executions.get(storageKey);
      if (
        current === undefined ||
        current.version !== input.expected_version
      ) executionConflict();
      const updated: CalendarExecutionRecord = {
        ...current,
        state: input.state,
        event_resource_uri: input.event_resource_uri ??
          current.event_resource_uri,
        outcome: input.outcome === undefined
          ? current.outcome
          : clone(input.outcome),
        version: current.version + 1,
        updated_at: input.updated_at,
      };
      this.executions.set(storageKey, updated);
      return clone(updated);
    });
  }

  getExecution(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<CalendarExecutionRecord | null> {
    return this.enqueue(() => {
      const value = this.executions.get(key(tenantId, idempotencyKey));
      return value === undefined ? null : clone(value);
    });
  }

  putEventOwnership(input: CalendarEventOwnership): Promise<void> {
    return this.enqueue(() => {
      const storageKey = key(input.tenant_id, input.event_resource_uri);
      const createKey = key(
        input.tenant_id,
        input.create_idempotency_key,
      );
      const existing = this.events.get(storageKey);
      if (existing !== undefined) {
        if (!same(existing, input)) {
          throw new Error("calendar_event_ownership_conflict");
        }
        return;
      }
      const createOwner = this.eventCreateKeys.get(createKey);
      if (createOwner !== undefined && createOwner !== storageKey) {
        throw new Error("calendar_event_ownership_conflict");
      }
      this.events.set(storageKey, clone(input));
      this.eventCreateKeys.set(createKey, storageKey);
    });
  }

  getEventOwnership(
    tenantId: string,
    eventResourceUri: string,
  ): Promise<CalendarEventOwnership | null> {
    return this.enqueue(() => {
      const value = this.events.get(key(tenantId, eventResourceUri));
      return value === undefined ? null : clone(value);
    });
  }

  getEventOwnershipByCreateKey(
    tenantId: string,
    createIdempotencyKey: string,
  ): Promise<CalendarEventOwnership | null> {
    return this.enqueue(() => {
      const storageKey = this.eventCreateKeys.get(
        key(tenantId, createIdempotencyKey),
      );
      if (storageKey === undefined) return null;
      const value = this.events.get(storageKey);
      return value === undefined ? null : clone(value);
    });
  }

  updateEventVersion(
    input: Parameters<FeishuCalendarStore["updateEventVersion"]>[0],
  ): Promise<CalendarEventOwnership> {
    return this.enqueue(() => {
      const storageKey = key(
        input.tenant_id,
        input.event_resource_uri,
      );
      const current = this.events.get(storageKey);
      if (
        current === undefined ||
        current.provider_version !== input.expected_version ||
        current.deleted_at !== null
      ) eventConflict();
      const updated: CalendarEventOwnership = {
        ...current,
        provider_version: current.provider_version + 1,
        external_updated_at: input.external_updated_at,
      };
      this.events.set(storageKey, updated);
      return clone(updated);
    });
  }

  markEventDeleted(
    input: Parameters<FeishuCalendarStore["markEventDeleted"]>[0],
  ): Promise<CalendarEventOwnership> {
    return this.enqueue(() => {
      const storageKey = key(
        input.tenant_id,
        input.event_resource_uri,
      );
      const current = this.events.get(storageKey);
      if (current === undefined) eventConflict();
      if (
        current.deleted_at === input.deleted_at &&
        current.provider_version === input.expected_version
      ) return clone(current);
      if (
        current.deleted_at !== null ||
        current.provider_version !== input.expected_version
      ) eventConflict();
      const updated: CalendarEventOwnership = {
        ...current,
        provider_version: current.provider_version + 1,
        deleted_at: input.deleted_at,
      };
      this.events.set(storageKey, updated);
      return clone(updated);
    });
  }

  async close(): Promise<void> {
    await this.tail;
    this.closed = true;
  }
}
