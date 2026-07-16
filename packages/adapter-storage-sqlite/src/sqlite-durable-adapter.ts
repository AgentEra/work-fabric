import type { CapabilityManifest } from "@work-fabric/exchange-spi";

import type { SqliteSession } from "./sqlite-session.js";

const undefinedSentinel = "__work_fabric_undefined_3b1d1490__";

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item === undefined ? { [undefinedSentinel]: true } : item
  );
}

function deserialize(value: string): unknown[] {
  return JSON.parse(value, (_key, item: unknown) => {
    if (
      typeof item === "object" && item !== null && !Array.isArray(item) &&
      Object.keys(item).length === 1 &&
      (item as Record<string, unknown>)[undefinedSentinel] === true
    ) return undefined;
    return item;
  }) as unknown[];
}

type AdapterTarget = object & { readonly manifest?: CapabilityManifest };

export interface DurableAdapterOptions<T extends AdapterTarget> {
  readonly session: SqliteSession;
  readonly tenant_id: string;
  readonly store_kind: string;
  readonly target: T;
  readonly mutations: ReadonlySet<string>;
  readonly tenant_guard: (method: string, args: readonly unknown[]) => void;
}

class DurableAdapterDelegate<T extends AdapterTarget> {
  private readonly ready: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: DurableAdapterOptions<T>) {
    options.session.prepare(`
      DELETE FROM work_fabric_local_store_operations
      WHERE tenant_id=? AND store_kind=? AND state='pending'
    `).run(options.tenant_id, options.store_kind);
    this.ready = this.replay();
  }

  async read(method: string, args: readonly unknown[]): Promise<unknown> {
    await this.ready;
    await this.tail;
    return this.invoke(method, args);
  }

  mutate(method: string, args: readonly unknown[]): Promise<unknown> {
    const operation = this.tail.then(async () => {
      await this.ready;
      const inserted = this.options.session.prepare(`
        INSERT INTO work_fabric_local_store_operations
          (tenant_id,store_kind,operation,arguments_json,state,recorded_at)
        VALUES (?,?,?,?,'pending',?)
      `).run(
        this.options.tenant_id,
        this.options.store_kind,
        method,
        serialize(args),
        new Date().toISOString(),
      );
      const sequence = Number(inserted.lastInsertRowid);
      try {
        const result = await this.invoke(method, args);
        this.options.session.prepare(`
          UPDATE work_fabric_local_store_operations SET state='committed'
          WHERE sequence=? AND state='pending'
        `).run(sequence);
        return result;
      } catch (error) {
        this.options.session.prepare(`
          DELETE FROM work_fabric_local_store_operations
          WHERE sequence=? AND state='pending'
        `).run(sequence);
        throw error;
      }
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async replay(): Promise<void> {
    const rows = this.options.session.prepare(`
      SELECT operation,arguments_json
      FROM work_fabric_local_store_operations
      WHERE tenant_id=? AND store_kind=? AND state='committed'
      ORDER BY sequence
    `).all(this.options.tenant_id, this.options.store_kind) as unknown as readonly {
      operation: string;
      arguments_json: string;
    }[];
    for (const row of rows) {
      if (!this.options.mutations.has(row.operation)) {
        throw new Error(`unknown durable operation ${row.operation}`);
      }
      await this.invoke(row.operation, deserialize(row.arguments_json));
    }
  }

  private invoke(method: string, args: readonly unknown[]): Promise<unknown> {
    const member = Reflect.get(this.options.target, method, this.options.target);
    if (typeof member !== "function") throw new Error(`adapter method ${method} is missing`);
    return Promise.resolve(Reflect.apply(member, this.options.target, args));
  }
}

export function createSqliteDurableAdapter<T extends AdapterTarget>(
  options: DurableAdapterOptions<T>,
): T {
  const delegate = new DurableAdapterDelegate(options);
  return new Proxy(options.target, {
    get(target, property) {
      if (property === "manifest" && target.manifest !== undefined) {
        return {
          ...structuredClone(target.manifest),
          adapter: "sqlite",
          capabilities: {
            ...structuredClone(target.manifest.capabilities),
            local_file_durability: true,
            single_process_writer: true,
            clustered_claims: false,
          },
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof property !== "string" || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        try {
          options.tenant_guard(property, args);
        } catch (error) {
          return Promise.reject(error);
        }
        return options.mutations.has(property)
          ? delegate.mutate(property, args)
          : delegate.read(property, args);
      };
    },
  });
}
