import {
  SpanStatusCode,
  type Attributes,
  type Histogram,
  type Meter,
  type Tracer,
} from "@opentelemetry/api";
import {
  validateSemanticObservation,
  type SemanticObservation,
  type SemanticTelemetryObserver,
} from "@work-fabric/operations-spi";

export interface OtelSemanticObserverOptions {
  readonly meter: Meter;
  readonly tracer: Tracer;
}

function metricAttributes(observation: SemanticObservation): Attributes {
  return {
    "workfabric.operation": observation.operation,
    "workfabric.outcome": observation.outcome,
    "workfabric.category": observation.category,
  };
}

export class OtelSemanticObserver implements SemanticTelemetryObserver {
  private readonly operations;
  private readonly duration: Histogram;
  private readonly projectionLag: Histogram;

  constructor(private readonly options: OtelSemanticObserverOptions) {
    this.operations = options.meter.createCounter("workfabric.operation.count", {
      description: "Completed Work Fabric semantic operations",
      unit: "{operation}",
    });
    this.duration = options.meter.createHistogram("workfabric.operation.duration", {
      description: "Work Fabric semantic operation duration",
      unit: "ms",
    });
    this.projectionLag = options.meter.createHistogram("workfabric.projection.lag", {
      description: "Observed Work Fabric projection backlog",
      unit: "{event}",
    });
  }

  observe(input: SemanticObservation): void {
    const observation = validateSemanticObservation(input);
    const attributes = metricAttributes(observation);
    this.operations.add(observation.count, attributes);
    if (observation.operation === "projection_lag") {
      this.projectionLag.record(observation.count, attributes);
    } else {
      this.duration.record(observation.duration_ms, attributes);
    }

    const traceAttributes: Attributes = {
      ...attributes,
      ...(observation.correlation_id === undefined
        ? {}
        : { "workfabric.correlation_id": observation.correlation_id }),
    };
    const endedAt = Date.now();
    const span = this.options.tracer.startSpan(
      `workfabric.${observation.operation}`,
      {
        attributes: traceAttributes,
        startTime: endedAt - observation.duration_ms,
      },
    );
    span.setStatus({
      code: observation.outcome === "succeeded"
        ? SpanStatusCode.OK
        : SpanStatusCode.ERROR,
    });
    span.end(endedAt);
  }
}
