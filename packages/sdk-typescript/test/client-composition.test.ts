import { describe, expect, it, vi } from "vitest";

import {
  BearerTokenProvider,
  WorkFabricClient,
  type RepresentationContext,
} from "../src/index.js";

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("WorkFabricClient composition", () => {
  it("shares one transport configuration while representation remains immutable and overridable", async () => {
    const headers: Headers[] = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      headers.push(new Headers(init?.headers));
      return json({ handoff_id: "handoff_01" });
    }) as unknown as typeof globalThis.fetch;
    const base = new WorkFabricClient({
      baseUrl: "https://fabric.example.test",
      tenantId: "tenant_01",
      exchangeId: "exchange_01",
      representation: { actorId: "human_01", endpointId: "web_01" },
      authentication: new BearerTokenProvider("token"),
      fetch,
      queryRetry: { maxRetries: 0 },
    });
    const agentRepresentation: RepresentationContext = {
      actorId: "agent_01",
      endpointId: "runtime_01",
      delegationId: "delegation_01",
    };
    const agent = base.withRepresentation(agentRepresentation);

    expect(base).not.toBe(agent);
    expect(base.commands).not.toBe(agent.commands);
    expect(base.handoffs).not.toBe(agent.handoffs);
    expect(Object.isFrozen(base)).toBe(true);
    expect(Object.isFrozen(agentRepresentation)).toBe(false);

    await base.queries.getHandoff("handoff_01");
    await agent.queries.getHandoff("handoff_01");
    await base.queries.getHandoff("handoff_01", {
      representation: { actorId: "system_01", endpointId: "service_01" },
    });

    expect(headers.map((value) => [
      value.get("x-wf-actor-id"),
      value.get("x-wf-endpoint-id"),
      value.get("x-wf-delegation-id"),
    ])).toEqual([
      ["human_01", "web_01", null],
      ["agent_01", "runtime_01", "delegation_01"],
      ["system_01", "service_01", null],
    ]);
  });

  it("derives isolated authentication transports for sequential and concurrent calls", async () => {
    const headers: Headers[] = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      headers.push(new Headers(init?.headers));
      return json({ handoff_id: "handoff_01" });
    }) as unknown as typeof globalThis.fetch;
    const base = new WorkFabricClient({
      baseUrl: "https://fabric.example.test",
      tenantId: "tenant_01",
      exchangeId: "exchange_01",
      representation: { actorId: "human_01", endpointId: "web_01" },
      authentication: new BearerTokenProvider("base-token"),
      fetch,
      queryRetry: { maxRetries: 0 },
    });
    const first = base.withAuthentication(new BearerTokenProvider("scoped-one"));
    const second = base.withAuthentication(new BearerTokenProvider("scoped-two"));

    expect(first).not.toBe(base);
    expect(second).not.toBe(base);
    expect(first).not.toBe(second);

    await base.queries.getHandoff("base-before");
    await first.queries.getHandoff("scoped-one");
    await base.queries.getHandoff("base-after");
    await Promise.all([
      first.queries.getHandoff("concurrent-one"),
      second.queries.getHandoff("concurrent-two"),
    ]);

    expect(headers.map((value) => value.get("authorization"))).toEqual([
      "Bearer base-token",
      "Bearer scoped-one",
      "Bearer base-token",
      "Bearer scoped-one",
      "Bearer scoped-two",
    ]);
  });
});
