import {
  validateSemanticObservation,
  type SemanticObservation,
  type SemanticTelemetryObserver,
} from "@work-fabric/operations-spi";

export class NoopSemanticObserver implements SemanticTelemetryObserver {
  observe(observation: SemanticObservation): void {
    validateSemanticObservation(observation);
  }
}

export interface TelemetryExportConfig {
  readonly max_queue_size: number;
  readonly max_export_batch_size: number;
  readonly scheduled_delay_ms: number;
  readonly export_timeout_ms: number;
}

function boundedInteger(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${field} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function normalizeTelemetryExportConfig(
  input: TelemetryExportConfig,
): TelemetryExportConfig {
  const config = {
    max_queue_size: boundedInteger(input.max_queue_size, "max_queue_size", 1, 65_536),
    max_export_batch_size: boundedInteger(
      input.max_export_batch_size,
      "max_export_batch_size",
      1,
      8_192,
    ),
    scheduled_delay_ms: boundedInteger(
      input.scheduled_delay_ms,
      "scheduled_delay_ms",
      1,
      60_000,
    ),
    export_timeout_ms: boundedInteger(
      input.export_timeout_ms,
      "export_timeout_ms",
      1,
      120_000,
    ),
  };
  if (config.max_export_batch_size > config.max_queue_size) {
    throw new RangeError("max_export_batch_size must not exceed max_queue_size");
  }
  return config;
}
