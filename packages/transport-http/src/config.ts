export interface HttpServiceConfig {
  readonly body_limit_bytes: number;
  readonly default_page_limit: number;
  readonly max_page_limit: number;
  readonly request_timeout_ms: number;
  readonly health_probe_timeout_ms: number;
  readonly sse_max_connections: number;
  readonly sse_poll_interval_ms: number;
  readonly sse_heartbeat_interval_ms: number;
  readonly sse_idle_timeout_ms: number;
  readonly shutdown_timeout_ms: number;
  readonly endpoint_min_lease_seconds: number;
  readonly endpoint_default_lease_seconds: number;
  readonly endpoint_max_lease_seconds: number;
  readonly endpoint_renew_ahead_seconds: number;
  readonly endpoint_max_capabilities: number;
  readonly endpoint_max_bindings: number;
  readonly endpoint_max_inbox_partitions: number;
}

const defaults: HttpServiceConfig = {
  body_limit_bytes: 1_048_576,
  default_page_limit: 50,
  max_page_limit: 200,
  request_timeout_ms: 30_000,
  health_probe_timeout_ms: 2_000,
  sse_max_connections: 1_000,
  sse_poll_interval_ms: 500,
  sse_heartbeat_interval_ms: 15_000,
  sse_idle_timeout_ms: 300_000,
  shutdown_timeout_ms: 15_000,
  endpoint_min_lease_seconds: 30,
  endpoint_default_lease_seconds: 60,
  endpoint_max_lease_seconds: 300,
  endpoint_renew_ahead_seconds: 10,
  endpoint_max_capabilities: 64,
  endpoint_max_bindings: 16,
  endpoint_max_inbox_partitions: 128,
};

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

export function normalizeHttpServiceConfig(
  input: Partial<HttpServiceConfig>,
): HttpServiceConfig {
  const config = { ...defaults, ...input };
  for (const [field, value] of Object.entries(config)) {
    positiveInteger(value, field);
  }
  if (config.default_page_limit > config.max_page_limit) {
    throw new TypeError("default_page_limit must not exceed max_page_limit");
  }
  if (config.sse_poll_interval_ms >= config.sse_idle_timeout_ms) {
    throw new TypeError(
      "sse_poll_interval_ms must be less than sse_idle_timeout_ms",
    );
  }
  if (
    config.endpoint_min_lease_seconds > config.endpoint_default_lease_seconds ||
    config.endpoint_default_lease_seconds > config.endpoint_max_lease_seconds
  ) {
    throw new TypeError(
      "endpoint lease bounds must satisfy min <= default <= max",
    );
  }
  if (
    config.endpoint_renew_ahead_seconds >= config.endpoint_min_lease_seconds
  ) {
    throw new TypeError(
      "endpoint_renew_ahead_seconds must be less than endpoint_min_lease_seconds",
    );
  }
  return Object.freeze(config);
}
