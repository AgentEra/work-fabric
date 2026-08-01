import { describe, expect, it } from "vitest";

import type { Meter, Span, Tracer } from "@opentelemetry/api";
import {
  NoopSemanticObserver,
  OtelSemanticObserver,
  normalizeTelemetryExportConfig,
} from "../src/index.js";

const observation = {
  operation: "collaboration_query" as const,
  outcome: "succeeded" as const,
  category: "http" as const,
  duration_ms: 12.5,
  count: 1,
  correlation_id: "request-42",
};

describe("semantic telemetry observers", () => {
  it("bounds deployment-owned exporter queues and batches", () => {
    expect(normalizeTelemetryExportConfig({
      max_queue_size: 2048,
      max_export_batch_size: 512,
      scheduled_delay_ms: 5_000,
      export_timeout_ms: 30_000,
    })).toEqual({
      max_queue_size: 2048,
      max_export_batch_size: 512,
      scheduled_delay_ms: 5_000,
      export_timeout_ms: 30_000,
    });
    expect(() => normalizeTelemetryExportConfig({
      max_queue_size: 100,
      max_export_batch_size: 101,
      scheduled_delay_ms: 5_000,
      export_timeout_ms: 30_000,
    })).toThrow(/batch/i);
    expect(() => normalizeTelemetryExportConfig({
      max_queue_size: 1_000_000,
      max_export_batch_size: 512,
      scheduled_delay_ms: 5_000,
      export_timeout_ms: 30_000,
    })).toThrow(/queue/i);
  });

  it("provides a safe no-op through the semantic port", () => {
    expect(() => new NoopSemanticObserver().observe(observation)).not.toThrow();
  });

  it("records only enumerated low-cardinality metric attributes", () => {
    const metricCalls: unknown[][] = [];
    const meter = {
      createCounter: () => ({ add: (...input: unknown[]) => metricCalls.push(input) }),
      createHistogram: () => ({ record: (...input: unknown[]) => metricCalls.push(input) }),
    } as unknown as Meter;
    const tracer = { startSpan: () => span() } as unknown as Tracer;

    new OtelSemanticObserver({ meter, tracer }).observe(observation);

    expect(metricCalls).toHaveLength(2);
    for (const call of metricCalls) {
      expect(call[1]).toEqual({
        "workfabric.operation": "collaboration_query",
        "workfabric.outcome": "succeeded",
        "workfabric.category": "http",
      });
      expect(JSON.stringify(call)).not.toContain("request-42");
    }
  });

  it("keeps cluster measurements out of metric attributes", () => {
    const metricCalls: unknown[][] = [];
    const meter = {
      createCounter: () => ({ add: (...input: unknown[]) => metricCalls.push(input) }),
      createHistogram: () => ({ record: (...input: unknown[]) => metricCalls.push(input) }),
    } as unknown as Meter;
    const tracer = { startSpan: () => span() } as unknown as Tracer;

    new OtelSemanticObserver({ meter, tracer }).observe({
      operation: "cluster_queue_overload",
      outcome: "retryable",
      category: "cluster",
      duration_ms: 0,
      count: 19,
    });

    for (const call of metricCalls) {
      expect(call[1]).toEqual({
        "workfabric.operation": "cluster_queue_overload",
        "workfabric.outcome": "retryable",
        "workfabric.category": "cluster",
      });
      expect(JSON.stringify(call[1])).not.toMatch(
        /tenant|partition|worker|fencing|queue_depth/i,
      );
    }
  });

  it("exports only an enumerated discovery reason", () => {
    const metricCalls: unknown[][] = [];
    const meter = {
      createCounter: () => ({ add: (...input: unknown[]) => metricCalls.push(input) }),
      createHistogram: () => ({ record: (...input: unknown[]) => metricCalls.push(input) }),
    } as unknown as Meter;
    const tracer = { startSpan: () => span() } as unknown as Tracer;
    new OtelSemanticObserver({ meter, tracer }).observe({
      operation: "discovery_query", outcome: "denied", category: "discovery",
      reason: "rate_limited", duration_ms: 1, count: 1,
    });
    expect(metricCalls[0]?.[1]).toMatchObject({
      "workfabric.operation": "discovery_query",
      "workfabric.reason": "rate_limited",
    });
  });

  it("traces only stable semantics and a validated correlation id", () => {
    const spans: Array<{ name: string; attributes: Record<string, unknown>; ended: boolean }> = [];
    const tracer = {
      startSpan(name: string, options: { attributes: Record<string, unknown> }) {
        const record = { name, attributes: options.attributes, ended: false };
        spans.push(record);
        return span(() => { record.ended = true; });
      },
    } as unknown as Tracer;
    const meter = {
      createCounter: () => ({ add() {} }),
      createHistogram: () => ({ record() {} }),
    } as unknown as Meter;

    new OtelSemanticObserver({ meter, tracer }).observe(observation);

    expect(spans).toEqual([{
      name: "workfabric.collaboration_query",
      attributes: {
        "workfabric.operation": "collaboration_query",
        "workfabric.outcome": "succeeded",
        "workfabric.category": "http",
        "workfabric.correlation_id": "request-42",
      },
      ended: true,
    }]);
  });

  it("rejects content-bearing or unbounded correlation ids before export", () => {
    const meter = {
      createCounter: () => ({ add() { throw new Error("must not export"); } }),
      createHistogram: () => ({ record() { throw new Error("must not export"); } }),
    } as unknown as Meter;
    const tracer = { startSpan() { throw new Error("must not export"); } } as unknown as Tracer;
    const observer = new OtelSemanticObserver({ meter, tracer });

    expect(() => observer.observe({
      ...observation,
      correlation_id: "Authorization: Bearer secret",
    })).toThrow(/correlation/i);
    expect(() => observer.observe({
      ...observation,
      correlation_id: "x".repeat(129),
    })).toThrow(/correlation/i);
  });
});

function span(onEnd: () => void = () => {}): Span {
  return {
    setAttribute() { return this; },
    setAttributes() { return this; },
    addEvent() { return this; },
    addLink() { return this; },
    addLinks() { return this; },
    setStatus() { return this; },
    updateName() { return this; },
    end() { onEnd(); },
    isRecording() { return true; },
    recordException() {},
    spanContext() {
      return { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 };
    },
  };
}
