import type { ExchangeAdapter } from "@work-fabric/exchange-spi";

export const PARTITION_WORK_KINDS = [
  "outbox_wakeup",
  "handoff_projection",
  "collaboration_projection",
  "signal_delivery",
] as const;

export type PartitionWorkKind = typeof PARTITION_WORK_KINDS[number];

export const CLUSTER_REQUIRED_CAPABILITIES = [
  "tenant_isolation",
  "tenant_scoped_keyset_scan",
  "bounded_pages",
  "stable_work_ordering",
  "duplicate_wakeup_tolerance",
  "lost_wakeup_poll_recovery",
  "deep_clone",
] as const;

export interface ClusterCapabilityManifest {
  readonly profile: "workfabric.cluster.v1";
  readonly adapter: string;
  readonly capabilities: Readonly<Record<string, boolean>>;
}

export interface PartitionWorkItem {
  readonly tenant_id: string;
  readonly partition_id: string;
  readonly kind: PartitionWorkKind;
  readonly observed_position: number;
  readonly available_at: string;
}

export interface PartitionWorkPage {
  readonly items: readonly PartitionWorkItem[];
  readonly next_cursor: string | null;
}

export interface PartitionWorkCatalog extends ExchangeAdapter {
  readonly manifest: ClusterCapabilityManifest;
  scanReady(input: {
    readonly tenant_id: string;
    readonly kinds: readonly PartitionWorkKind[];
    readonly available_at_or_before: string;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<PartitionWorkPage>;
}

export interface PartitionWakeup {
  readonly wakeup_id: string;
  readonly exchange_id: string;
  readonly tenant_id: string;
  readonly partition_id: string;
  readonly kind: PartitionWorkKind;
  readonly observed_position: number;
  readonly occurred_at: string;
}

export interface PartitionWakeupPublisher extends ExchangeAdapter {
  readonly manifest: ClusterCapabilityManifest;
  publish(
    wakeup: PartitionWakeup,
  ): Promise<"accepted" | "retryable_failure">;
}

export interface WakeupDelivery {
  readonly wakeup: PartitionWakeup;
  acknowledge(): Promise<void>;
  retry(): Promise<void>;
}

export interface PartitionWakeupConsumer extends ExchangeAdapter {
  readonly manifest: ClusterCapabilityManifest;
  next(signal: AbortSignal): Promise<WakeupDelivery | null>;
}

export interface PartitionTurnContext {
  readonly item: PartitionWorkItem;
  readonly owner: string;
  readonly fencing_token: number;
  readonly signal: AbortSignal;
  assertOwnership(): Promise<void>;
}

export type PartitionTurnOutcome =
  | { readonly outcome: "idle"; readonly processed: 0 }
  | {
      readonly outcome: "advanced" | "waiting" | "blocked";
      readonly processed: number;
    };

export interface PartitionTurnHandler {
  readonly kind: PartitionWorkKind;
  run(
    context: PartitionTurnContext,
    limit: number,
  ): Promise<PartitionTurnOutcome>;
}

export interface ClusterHostLimits {
  readonly max_concurrent_turns: number;
  readonly max_ready_items: number;
  readonly catalog_page_size: number;
  readonly turn_item_limit: number;
  readonly lease_seconds: number;
  readonly drain_timeout_seconds: number;
  readonly poll_interval_ms: number;
  readonly max_tenants_per_host: number;
}
