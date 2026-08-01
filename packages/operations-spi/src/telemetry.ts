export const SEMANTIC_OPERATIONS = [
  "authentication",
  "authorization",
  "http_request",
  "command",
  "collaboration_query",
  "operations_query",
  "projection_batch",
  "projection_lag",
  "delivery_attempt",
  "connector_mapping",
  "recovery_action",
  "worker_lease_loss",
  "cluster_catalog_scan",
  "cluster_lease_acquire",
  "cluster_lease_lost",
  "cluster_turn",
  "cluster_queue_overload",
  "cluster_drain",
  "cluster_wakeup_transport",
  "discovery_query",
  "discovery_sync",
  "discovery_export",
  "discovery_prune",
] as const;

export const SEMANTIC_OUTCOMES = [
  "succeeded",
  "failed",
  "denied",
  "conflicted",
  "retryable",
  "dead_lettered",
] as const;

export const SEMANTIC_CATEGORIES = [
  "http",
  "projector",
  "delivery",
  "connector",
  "recovery",
  "cluster",
  "discovery",
] as const;

export const SEMANTIC_REASONS = [
  "accepted",
  "denied",
  "expired",
  "invalid_signature",
  "conflict",
  "budget_exhausted",
  "rate_limited",
  "unavailable",
] as const;

export interface SemanticObservation {
  readonly operation: (typeof SEMANTIC_OPERATIONS)[number];
  readonly outcome: (typeof SEMANTIC_OUTCOMES)[number];
  readonly category: (typeof SEMANTIC_CATEGORIES)[number];
  readonly duration_ms: number;
  readonly count: number;
  readonly correlation_id?: string;
  readonly reason?: (typeof SEMANTIC_REASONS)[number];
}

export interface SemanticTelemetryObserver {
  observe(observation: SemanticObservation): void;
}

export function safeSemanticCorrelationId(
  input: string | null | undefined,
): string | undefined {
  return input !== null &&
    input !== undefined &&
    /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(input)
    ? input
    : undefined;
}

export function validateSemanticObservation(
  input: SemanticObservation,
): SemanticObservation {
  if (!SEMANTIC_OPERATIONS.includes(input.operation)) {
    throw new TypeError("telemetry operation is invalid");
  }
  if (!SEMANTIC_OUTCOMES.includes(input.outcome)) {
    throw new TypeError("telemetry outcome is invalid");
  }
  if (!SEMANTIC_CATEGORIES.includes(input.category)) {
    throw new TypeError("telemetry category is invalid");
  }
  if (input.reason !== undefined && !SEMANTIC_REASONS.includes(input.reason)) {
    throw new TypeError("telemetry reason is invalid");
  }
  if (!Number.isFinite(input.duration_ms) || input.duration_ms < 0) {
    throw new TypeError("telemetry duration is invalid");
  }
  if (!Number.isSafeInteger(input.count) || input.count <= 0) {
    throw new TypeError("telemetry count is invalid");
  }
  if (
    input.correlation_id !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(input.correlation_id)
  ) {
    throw new TypeError("telemetry correlation_id is invalid");
  }
  return { ...input };
}

export function observeSemanticSafely(
  observer: SemanticTelemetryObserver | undefined,
  observation: SemanticObservation,
): void {
  try {
    observer?.observe(validateSemanticObservation(observation));
  } catch {
    // Telemetry must never change an exchange or recovery outcome.
  }
}
