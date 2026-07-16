import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const allowedOtelAttributes = new Set([
  "workfabric.operation", "workfabric.outcome", "workfabric.category", "workfabric.correlation_id",
]);

export interface ObservabilitySafetyReport {
  readonly observation_calls: number;
  readonly otel_attributes: number;
}

export async function checkSensitiveObservability(root = resolve(".")): Promise<ObservabilitySafetyReport> {
  const paths = [
    "packages/connector-runtime/src/connector-worker.ts",
    "packages/exchange-runtime/src/subscription/signal-dispatcher.ts",
    "packages/operations-runtime/src/collaboration-projector.ts",
    "packages/operations-runtime/src/recovery-worker.ts",
    "packages/transport-http/src/internal/create-server.ts",
    "packages/cluster-runtime/src/telemetry.ts",
  ];
  const violations: string[] = [];
  let calls = 0;
  for (const relative of paths) {
    const source = await readFile(resolve(root, relative), "utf8");
    const blocks = source.split("observeSemanticSafely(").slice(1).map((value) => value.split("});", 1)[0] ?? value);
    calls += blocks.length;
    for (const block of blocks) {
      for (const required of ["operation", "outcome", "category", "duration_ms", "count"]) {
        if (!new RegExp(`\\b${required}(?:\\s*:|\\s*[,}])`).test(block)) violations.push(`${relative} telemetry is missing ${required}`);
      }
      if (/\b(?:payload|body|content|message|token|secret|credential|tenant_id|actor_id|endpoint_id|handoff_id|event_id|resource_id)\s*:/.test(block)) {
        violations.push(`${relative} telemetry contains content or high-cardinality identity`);
      }
    }
  }

  const otelPath = resolve(root, "packages/operations-observability/src/otel-observer.ts");
  const otelSource = await readFile(otelPath, "utf8");
  const attributeKeys = [...otelSource.matchAll(/["'](workfabric\.[a-z_]+)["']\s*:/g)].map((match) => match[1]!);
  const attributes = attributeKeys.length;
  for (const attribute of attributeKeys) {
    if (!allowedOtelAttributes.has(attribute)) violations.push(`unsafe OpenTelemetry attribute ${attribute}`);
  }
  if (violations.length > 0) throw new Error(`Observability safety violations:\n${violations.join("\n")}`);
  return { observation_calls: calls, otel_attributes: attributes };
}

const invoked = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) {
  const report = await checkSensitiveObservability();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
