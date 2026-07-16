import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateConsoleConfig } from "../src/config.js";
import { parseRoute, routeHref } from "../src/router.js";
import { renderHandoffDetail } from "../src/views/handoff-detail.js";
import { renderResponsibilities } from "../src/views/responsibilities.js";

describe("Console boundary", () => {
  it("accepts bounded runtime configuration without embedding authentication", () => {
    expect(validateConsoleConfig({
      baseUrl: "http://127.0.0.1:8080",
      tenantId: "tenant-a",
      exchangeId: "exchange-a",
      actorId: "operator-a",
      endpointId: "console-a",
      invalidationSubscriptionId: "console-refresh-a",
    })).toEqual({
      baseUrl: "http://127.0.0.1:8080",
      tenantId: "tenant-a",
      exchangeId: "exchange-a",
      actorId: "operator-a",
      endpointId: "console-a",
      invalidationSubscriptionId: "console-refresh-a",
    });
    expect(() => validateConsoleConfig({ baseUrl: "file:///tmp/state" })).toThrow();
  });

  it("preserves partition navigation and decodes handoff routes", () => {
    expect(routeHref("/handoffs/a%2Fb", "north/east")).toBe(
      "/handoffs/a%2Fb?partition=north%2Feast",
    );
    expect(parseRoute(new URL("https://console/handoffs/a%2Fb?partition=north"))).toEqual({
      kind: "handoff",
      handoffId: "a/b",
      partitionId: "north",
    });
  });

  it("renders escaped collaboration facts and explicit freshness", () => {
    const html = renderResponsibilities([{
      tenant_id: "tenant-a",
      partition_id: "north",
      handoff_id: "handoff-<one>",
      thread_id: "thread-a",
      stream_version: 2,
      lifecycle_state: "accepted",
      initiator: { actor_id: "human-a", actor_type: "human" },
      recipient: { actor_id: "agent-a", actor_type: "agent" },
      current_responsible_actor: { actor_id: "agent-a", actor_type: "agent" },
      verifier: { actor_id: "human-a", actor_type: "human" },
      target_binding: null,
      work_reference: {},
      priority: "normal",
      accept_by: "2026-07-17T00:00:00.000Z",
      result_due_at: "2026-07-18T00:00:00.000Z",
      latest_status: null,
      parent_handoff_id: null,
      child_handoff_id: null,
      created_at: "2026-07-16T00:00:00.000Z",
      updated_at: "2026-07-16T00:00:00.000Z",
    }], "north", {
      projected_position: 3,
      journal_position: 4,
      observed_at: "2026-07-16T00:00:01.000Z",
    });
    expect(html).toContain("handoff-&lt;one&gt;");
    expect(html).toContain("1 events behind");
    expect(html).not.toContain("handoff-<one>");
  });

  it("renders public timeline and relationships without content payloads", () => {
    const html = renderHandoffDetail("handoff-a", [{
      tenant_id: "tenant-a",
      partition_id: "north",
      handoff_id: "handoff-a",
      thread_id: "thread-a",
      event_id: "event-a",
      event_type: "workfabric.handoff.accepted.v1",
      occurred_at: "2026-07-16T00:00:00.000Z",
      partition_position: 2,
      stream_version: 2,
      subject: "handoff-a",
      event_source: "exchange-a",
      actor_id: "agent-a",
      endpoint_id: "runtime-a",
      correlation_id: null,
      causation_id: null,
      change: {},
    }], [{
      tenant_id: "tenant-a",
      partition_id: "north",
      handoff_id: "handoff-a",
      thread_id: "thread-a",
      relationship_id: "relationship-a",
      relationship_kind: "thread_membership",
      source_id: "handoff-a",
      target_id: "thread-a",
      stream_version: 2,
      observed_at: "2026-07-16T00:00:00.000Z",
    }]);
    expect(html).toContain("agent-a via runtime-a");
    expect(html).toContain("thread-a");
    expect(html).not.toContain("payload");
  });

  it("imports Work Fabric behavior only from the public SDK", async () => {
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    const files = ["src/app.ts", "src/client.ts", "src/views/operations.ts"];
    const source = (await Promise.all(files.map((file) => readFile(`${packageRoot}/${file}`, "utf8")))).join("\n");
    expect(source).not.toMatch(/@work-fabric\/(exchange|operations|adapter|transport|connector)-/);
    expect(source).not.toMatch(/(?:postgres|sqlite|node:sqlite)/i);
  });
});
