import {
  type PartitionWorkItem,
  validatePartitionWorkItem,
} from "@work-fabric/cluster-spi";

export type ReadyQueueOfferResult = "queued" | "coalesced" | "dropped";

function identity(item: PartitionWorkItem): string {
  return `${item.partition_id}\u0000${item.kind}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class TenantFairReadyQueue {
  private readonly tenants = new Map<string, Map<string, PartitionWorkItem>>();
  private readonly tenantOrder: string[] = [];
  private nextTenant = 0;
  private itemCount = 0;
  private droppedCount = 0;

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError("capacity must be a positive safe integer");
    }
  }

  get size(): number {
    return this.itemCount;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  offer(candidate: PartitionWorkItem): ReadyQueueOfferResult {
    const item = validatePartitionWorkItem(candidate);
    const tenantItems = this.tenants.get(item.tenant_id);
    const key = identity(item);
    const existing = tenantItems?.get(key);
    if (existing !== undefined) {
      tenantItems?.set(key, {
        ...clone(existing),
        observed_position: Math.max(
          existing.observed_position,
          item.observed_position,
        ),
        available_at: existing.available_at > item.available_at
          ? existing.available_at
          : item.available_at,
      });
      return "coalesced";
    }
    if (this.itemCount >= this.capacity) {
      this.droppedCount += 1;
      return "dropped";
    }

    if (tenantItems === undefined) {
      this.tenants.set(item.tenant_id, new Map([[key, clone(item)]]));
      this.tenantOrder.push(item.tenant_id);
    } else {
      tenantItems.set(key, clone(item));
    }
    this.itemCount += 1;
    return "queued";
  }

  take(): PartitionWorkItem | null {
    if (this.itemCount === 0 || this.tenantOrder.length === 0) return null;
    this.nextTenant %= this.tenantOrder.length;
    const tenantId = this.tenantOrder[this.nextTenant];
    if (tenantId === undefined) return null;
    const tenantItems = this.tenants.get(tenantId);
    const first = tenantItems?.entries().next().value as
      | [string, PartitionWorkItem]
      | undefined;
    if (tenantItems === undefined || first === undefined) {
      throw new Error("ready queue tenant index is inconsistent");
    }

    tenantItems.delete(first[0]);
    this.itemCount -= 1;
    if (tenantItems.size === 0) {
      this.tenants.delete(tenantId);
      this.tenantOrder.splice(this.nextTenant, 1);
      if (this.tenantOrder.length > 0) this.nextTenant %= this.tenantOrder.length;
      else this.nextTenant = 0;
    } else {
      this.nextTenant = (this.nextTenant + 1) % this.tenantOrder.length;
    }
    return clone(first[1]);
  }

  clear(): void {
    this.tenants.clear();
    this.tenantOrder.splice(0);
    this.nextTenant = 0;
    this.itemCount = 0;
  }
}
