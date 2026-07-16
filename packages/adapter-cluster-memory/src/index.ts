import {
  CLUSTER_REQUIRED_CAPABILITIES,
  PARTITION_WORK_KINDS,
  clusterIdentifier,
  clusterTimestamp,
  type ClusterCapabilityManifest,
  type PartitionWakeup,
  type PartitionWakeupConsumer,
  type PartitionWakeupPublisher,
  type PartitionWorkCatalog,
  type PartitionWorkItem,
  type PartitionWorkKind,
  type PartitionWorkPage,
  type WakeupDelivery,
  validatePartitionWakeup,
  validatePartitionWorkItem,
} from "@work-fabric/cluster-spi";

const manifest: ClusterCapabilityManifest = {
  profile: "workfabric.cluster.v1",
  adapter: "memory",
  capabilities: Object.fromEntries(
    CLUSTER_REQUIRED_CAPABILITIES.map((capability) => [capability, true]),
  ),
};

interface CursorValue {
  readonly tenant_id: string;
  readonly kinds: readonly PartitionWorkKind[];
  readonly available_at_or_before: string;
  readonly after: readonly [string, string, PartitionWorkKind];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareItems(left: PartitionWorkItem, right: PartitionWorkItem): number {
  return compareStrings(left.available_at, right.available_at) ||
    compareStrings(left.partition_id, right.partition_id) ||
    PARTITION_WORK_KINDS.indexOf(left.kind) - PARTITION_WORK_KINDS.indexOf(right.kind);
}

function compareItemToCursor(
  item: PartitionWorkItem,
  after: CursorValue["after"],
): number {
  return compareStrings(item.available_at, after[0]) ||
    compareStrings(item.partition_id, after[1]) ||
    PARTITION_WORK_KINDS.indexOf(item.kind) - PARTITION_WORK_KINDS.indexOf(after[2]);
}

function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string): CursorValue {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as
      Partial<CursorValue>;
    if (
      typeof parsed.tenant_id !== "string" || !Array.isArray(parsed.kinds) ||
      typeof parsed.available_at_or_before !== "string" ||
      !Array.isArray(parsed.after) || parsed.after.length !== 3
    ) throw new Error("shape");
    return parsed as CursorValue;
  } catch {
    throw new TypeError("cursor is invalid");
  }
}

function workIdentity(item: PartitionWorkItem): string {
  return JSON.stringify([item.tenant_id, item.partition_id, item.kind]);
}

export class MemoryClusterAdapter
  implements PartitionWorkCatalog, PartitionWakeupPublisher, PartitionWakeupConsumer
{
  private readonly work = new Map<string, PartitionWorkItem>();
  private readonly pending: PartitionWakeup[] = [];

  constructor(seed: readonly PartitionWorkItem[] = []) {
    for (const candidate of seed) {
      const item = validatePartitionWorkItem(candidate);
      const key = workIdentity(item);
      const existing = this.work.get(key);
      if (existing === undefined || item.observed_position > existing.observed_position) {
        this.work.set(key, clone(item));
      }
    }
  }

  get manifest(): ClusterCapabilityManifest {
    return clone(manifest);
  }

  async scanReady(input: {
    readonly tenant_id: string;
    readonly kinds: readonly PartitionWorkKind[];
    readonly available_at_or_before: string;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<PartitionWorkPage> {
    const tenantId = clusterIdentifier(input.tenant_id, "tenant_id");
    const availableAt = clusterTimestamp(
      input.available_at_or_before,
      "available_at_or_before",
    );
    if (
      !Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > 1_000
    ) throw new RangeError("limit must be between 1 and 1000");
    if (input.kinds.length === 0 || new Set(input.kinds).size !== input.kinds.length) {
      throw new TypeError("kinds must be non-empty and unique");
    }
    for (const kind of input.kinds) {
      if (!PARTITION_WORK_KINDS.includes(kind)) throw new TypeError("kinds is invalid");
    }
    const normalizedKinds = [...input.kinds].sort();
    const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    if (
      cursor !== undefined &&
      (cursor.tenant_id !== tenantId ||
        cursor.available_at_or_before !== availableAt ||
        JSON.stringify(cursor.kinds) !== JSON.stringify(normalizedKinds))
    ) throw new TypeError("cursor context does not match scan");

    const values = [...this.work.values()]
      .filter((item) =>
        item.tenant_id === tenantId && input.kinds.includes(item.kind) &&
        item.available_at <= availableAt
      )
      .sort(compareItems)
      .filter((item) => cursor === undefined || compareItemToCursor(
        item,
        cursor.after,
      ) > 0);
    const items = values.slice(0, input.limit);
    const last = items.at(-1);
    return {
      items: clone(items),
      next_cursor: items.length < values.length && last !== undefined
        ? encodeCursor({
          tenant_id: tenantId,
          kinds: normalizedKinds,
          available_at_or_before: availableAt,
          after: [last.available_at, last.partition_id, last.kind],
        })
        : null,
    };
  }

  async publish(candidate: PartitionWakeup): Promise<"accepted"> {
    this.pending.push(clone(validatePartitionWakeup(candidate)));
    return "accepted";
  }

  async next(signal: AbortSignal): Promise<WakeupDelivery | null> {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
    }
    const wakeup = this.pending.shift();
    if (wakeup === undefined) return null;
    let settled = false;
    const settle = (): void => {
      if (settled) throw new Error("wakeup delivery is already settled");
      settled = true;
    };
    return {
      wakeup: clone(wakeup),
      acknowledge: async () => settle(),
      retry: async () => {
        settle();
        this.pending.unshift(clone(wakeup));
      },
    };
  }
}
