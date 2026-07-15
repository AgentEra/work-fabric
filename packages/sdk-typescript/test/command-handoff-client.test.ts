import { describe, expect, it, vi } from "vitest";

import {
  BearerTokenProvider,
  CommandClient,
  HandoffClient,
  type CommandEnvelope,
  type JsonObject,
  type OperationResult,
} from "../src/index.js";
import { normalizeClientOptions } from "../src/config.js";
import { SdkTransport } from "../src/transport.js";

const accepted = (messageId: string): OperationResult => ({
  spec_version: "1.0",
  request_message_id: messageId,
  operation_status: "accepted",
  resource: { handoff_id: "handoff_01" },
  receipt: null,
  error: null,
});

function fixture(fetch: typeof globalThis.fetch) {
  const config = normalizeClientOptions({
    baseUrl: "https://fabric.example.test",
    tenantId: "tenant_01",
    exchangeId: "exchange_01",
    representation: {
      actorId: "agent_01",
      endpointId: "endpoint_01",
      delegationId: "delegation_01",
    },
    authentication: new BearerTokenProvider("token"),
    fetch,
    clock: { now: () => "2026-07-15T10:00:00.000Z" },
    messageIdGenerator: { nextMessageId: () => "message_generated" },
  });
  const commands = new CommandClient(new SdkTransport(config));
  return { commands, handoffs: new HandoffClient(config, commands) };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("CommandClient", () => {
  it("sends a canonical Envelope unchanged and does not retry", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const envelope: CommandEnvelope = {
      spec_version: "1.0",
      message_id: "message_direct",
      message_type: "vendor.custom.command.v1",
      sent_at: "2026-07-15T09:00:00.000Z",
      tenant_id: "tenant_01",
      exchange_id: "exchange_01",
      actor_id: "agent_01",
      endpoint_id: "endpoint_01",
      delegation_id: "delegation_01",
      correlation_id: "correlation_01",
      causation_id: "event_01",
      idempotency_key: "direct-key",
      expected_version: 3,
      payload: { custom: true },
    };
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: String(init?.body) });
      throw new Error("network failure");
    }) as unknown as typeof globalThis.fetch;
    const { commands } = fixture(fetch);

    await expect(commands.send(envelope)).rejects.toMatchObject({ code: "network_error" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(requests).toEqual([{
      url: "https://fabric.example.test/v1/commands",
      body: JSON.stringify(envelope),
    }]);
  });

  it.each([
    [200, "accepted"],
    [400, "rejected"],
    [409, "conflict"],
    [503, "temporarily_unavailable"],
  ] as const)("returns the canonical OperationResult for HTTP %s", async (status, operationStatus) => {
    const result: OperationResult = {
      ...accepted("message_direct"),
      operation_status: operationStatus,
      ...(operationStatus === "accepted"
        ? {}
        : { resource: null, error: { code: operationStatus } }),
    };
    const fetch = vi.fn(async () => response(result, status)) as unknown as typeof globalThis.fetch;
    const { commands } = fixture(fetch);
    const envelope: CommandEnvelope = {
      spec_version: "1.0",
      message_id: "message_direct",
      message_type: "vendor.command.v1",
      sent_at: "2026-07-15T09:00:00.000Z",
      tenant_id: "tenant_01",
      exchange_id: "exchange_01",
      actor_id: "agent_01",
      endpoint_id: "endpoint_01",
      idempotency_key: "key",
      payload: {},
    };

    await expect(commands.send(envelope)).resolves.toEqual(result);
  });
});

describe("HandoffClient", () => {
  it("builds every canonical Handoff interaction through one command surface", async () => {
    const envelopes: CommandEnvelope[] = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body)) as CommandEnvelope;
      envelopes.push(envelope);
      return response(accepted(envelope.message_id));
    }) as unknown as typeof globalThis.fetch;
    const { handoffs } = fixture(fetch);
    const content = [{ type: "text", text: "because" }] as readonly JsonObject[];
    const offer = {
      thread_id: "thread_01",
      work_reference: { uri: "urn:work:01", title: "Implement feature" },
      target: { capability_requirement: { capability_id: "typescript" } },
      intent: content,
      authority_scope: {
        delegation_id: "delegation_01",
        scopes: ["code:write"],
        resource_refs: ["urn:repo:01"],
        expires_at: "2026-07-16T10:00:00.000Z",
        may_redelegate: false,
      },
      acceptance_criteria: [{
        criterion_id: "criterion_01",
        description: "Tests pass",
        required: true,
        result_schema_ref: null,
        required_evidence_types: ["test_report"],
      }],
      verifier: { actor_id: "human_01", actor_type: "human" },
      priority: "high",
      accept_by: "2026-07-15T11:00:00.000Z",
      result_due_at: "2026-07-16T09:00:00.000Z",
    } as const;
    const next = {
      expectedVersion: 7,
      idempotencyKey: "mutation-key",
      messageId: "message_explicit",
      correlationId: "correlation_01",
      causationId: "event_01",
    } as const;

    await handoffs.offer(offer, { idempotencyKey: "offer-key" });
    await handoffs.resolveTarget({ handoff_id: "handoff_01", resolved_target: { actor_id: "agent_02" } }, next);
    await handoffs.reportTargetUnavailable({ handoff_id: "handoff_01", reason_code: "no_candidate", reason: content, evidence: [] }, next);
    await handoffs.accept({ handoff_id: "handoff_01" }, next);
    await handoffs.decline({ handoff_id: "handoff_01" }, next);
    await handoffs.expire({ handoff_id: "handoff_01" }, next);
    await handoffs.cancel({ handoff_id: "handoff_01", reason: content }, next);
    await handoffs.reportStatus({ handoff_id: "handoff_01", status: { state: "working" } }, next);
    await handoffs.returnResult({ handoff_id: "handoff_01", result: { artifacts: [] } }, next);
    await handoffs.verify({ handoff_id: "handoff_01", satisfied_criterion_ids: ["criterion_01"], summary: content, evidence: [] }, next);
    await handoffs.close({ handoff_id: "handoff_01" }, next);
    await handoffs.requestRework({ handoff_id: "handoff_01", criterion_ids: ["criterion_01"], reason: content }, next);
    await handoffs.transfer({ parent_handoff_id: "handoff_01", child_offer: offer }, next);

    expect(envelopes.map((item) => item.message_type)).toEqual([
      "workfabric.handoff.offer.v1",
      "workfabric.handoff.resolve_target.v1",
      "workfabric.handoff.report_target_unavailable.v1",
      "workfabric.handoff.accept.v1",
      "workfabric.handoff.decline.v1",
      "workfabric.handoff.expire.v1",
      "workfabric.handoff.cancel.v1",
      "workfabric.handoff.report_status.v1",
      "workfabric.handoff.return_result.v1",
      "workfabric.handoff.verify.v1",
      "workfabric.handoff.close.v1",
      "workfabric.handoff.request_rework.v1",
      "workfabric.handoff.transfer.v1",
    ]);
    expect(envelopes[0]).toEqual({
      spec_version: "1.0",
      message_id: "message_generated",
      message_type: "workfabric.handoff.offer.v1",
      sent_at: "2026-07-15T10:00:00.000Z",
      tenant_id: "tenant_01",
      exchange_id: "exchange_01",
      actor_id: "agent_01",
      endpoint_id: "endpoint_01",
      delegation_id: "delegation_01",
      idempotency_key: "offer-key",
      payload: offer,
    });
    expect(envelopes[1]).toMatchObject({
      message_id: "message_explicit",
      expected_version: 7,
      correlation_id: "correlation_01",
      causation_id: "event_01",
      payload: { handoff_id: "handoff_01", resolved_target: { actor_id: "agent_02" }, evidence: [] },
    });
    expect(envelopes[12]?.payload).toEqual({ parent_handoff_id: "handoff_01", child_offer: offer });
  });

  it("rejects unsafe command metadata before I/O", async () => {
    const fetch = vi.fn(async () => response(accepted("unused"))) as unknown as typeof globalThis.fetch;
    const { handoffs } = fixture(fetch);

    expect(() => handoffs.accept({ handoff_id: "" }, { expectedVersion: 1, idempotencyKey: "key" })).toThrow(TypeError);
    expect(() => handoffs.accept({ handoff_id: "handoff_01" }, { expectedVersion: 0, idempotencyKey: "key" })).toThrow(TypeError);
    expect(() => handoffs.accept({ handoff_id: "handoff_01" }, { expectedVersion: 1, idempotencyKey: " " })).toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
