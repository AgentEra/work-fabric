import {
  observeSemanticSafely,
  type SemanticObservation,
  type SemanticTelemetryObserver,
} from "@work-fabric/operations-spi";

export type ClusterSemanticOperation = Extract<
  SemanticObservation["operation"],
  | "cluster_catalog_scan"
  | "cluster_lease_acquire"
  | "cluster_lease_lost"
  | "cluster_turn"
  | "cluster_queue_overload"
  | "cluster_drain"
>;

export function observeCluster(
  observer: SemanticTelemetryObserver | undefined,
  operation: ClusterSemanticOperation,
  outcome: SemanticObservation["outcome"],
  durationMs: number,
  count = 1,
): void {
  observeSemanticSafely(observer, {
    operation,
    outcome,
    category: "cluster",
    duration_ms: Math.max(0, durationMs),
    count,
  });
}
