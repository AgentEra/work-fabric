export interface NatsWakeupRuntimeConfigInput {
  readonly pull_expires_ms?: number;
  readonly retry_delay_ms?: number;
  readonly max_poison_per_pull?: number;
}

export interface NatsWakeupRuntimeConfig {
  readonly pull_expires_ms: number;
  readonly retry_delay_ms: number;
  readonly max_poison_per_pull: number;
}

function bounded(
  value: number | undefined,
  fallback: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const normalized = value ?? fallback;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < minimum || normalized > maximum
  ) throw new RangeError(`${field} must be between ${minimum} and ${maximum}`);
  return normalized;
}

export function normalizeNatsWakeupRuntimeConfig(
  input: NatsWakeupRuntimeConfigInput,
): NatsWakeupRuntimeConfig {
  return {
    pull_expires_ms: bounded(
      input.pull_expires_ms,
      1_000,
      "pull_expires_ms",
      100,
      30_000,
    ),
    retry_delay_ms: bounded(
      input.retry_delay_ms,
      1_000,
      "retry_delay_ms",
      100,
      60_000,
    ),
    max_poison_per_pull: bounded(
      input.max_poison_per_pull,
      10,
      "max_poison_per_pull",
      1,
      100,
    ),
  };
}
