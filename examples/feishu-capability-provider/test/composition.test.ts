import { describe, expect, it, vi } from "vitest";

import {
  ManagedFeishuProviderComposition,
  resolveFeishuContextRequest,
} from "../src/composition.js";

describe("ManagedFeishuProviderComposition", () => {
  it("routes the conversation declaration to the conversation provider without changing document context", async () => {
    const bundle = {
      context_id: "context-feishu-1",
      version: 1,
      items: [],
      visibility_scope: {
        actor_ids: ["actor-assistant-1"],
        endpoint_ids: ["endpoint-assistant-1"],
        expires_at: "2026-07-28T13:00:00.000Z",
      },
      digest: { algorithm: "sha-256", value: "abc" },
      extensions: {},
    };
    const materialize = vi.fn(async () => ({
      kind: "materialized" as const,
      bundle,
    }));
    const documentRead = vi.fn();
    const input = {
      tenant_id: "tenant-1",
      provider_family: "feishu",
      external_tenant_id: "tenant-key-1",
      conversation_id: "oc-chat-1",
      trigger_message_id: "om-trigger",
      triggered_at: "2026-07-28T12:00:00.000Z",
      represented_actor_id: "actor-human-1",
      recipient_actor_id: "actor-assistant-1",
      recipient_endpoint_id: "endpoint-assistant-1",
      delegation_id: "delegation-1",
      delegation_scopes: ["conversation:read"],
      delegation_expires_at: "2026-07-28T13:00:00.000Z",
      policy: {
        lookback_seconds: 86_400,
        maximum_messages: 20,
        maximum_bytes: 65_536,
      },
    };
    const signal = new AbortController().signal;

    await expect(resolveFeishuContextRequest({
      document: { read: documentRead },
      conversation: { materialize },
    }, {
      declaration_id: "feishu.conversation.context",
      input,
    }, signal)).resolves.toEqual(bundle);

    expect(materialize).toHaveBeenCalledWith(input, signal);
    expect(documentRead).not.toHaveBeenCalled();
  });

  it("starts Citizens and Handoff Host without a configured document container", async () => {
    const calls: string[] = [];
    const composition = new ManagedFeishuProviderComposition({
      capability_citizen_id: "citizen-capability",
      context_citizen_id: "citizen-context",
      capability_citizen: {
        start: vi.fn(async () => { calls.push("capability:start"); }),
        health: vi.fn(async () => ({ status: "available" as const })),
        close: vi.fn(async () => { calls.push("capability:close"); }),
      },
      context_citizen: {
        start: vi.fn(async () => { calls.push("context:start"); }),
        health: vi.fn(async () => ({ status: "available" as const })),
        close: vi.fn(async () => { calls.push("context:close"); }),
      },
      host: {
        start: vi.fn(async () => { calls.push("host:start"); }),
        close: vi.fn(async () => { calls.push("host:close"); }),
      },
      close_provider_store: async () => { calls.push("provider-store:close"); },
    });
    await composition.start();
    expect(calls).toEqual([
      "capability:start",
      "context:start",
      "host:start",
    ]);
    await expect(composition.health()).resolves.toEqual({
      provider: "ready",
      capability_citizen: "citizen-capability",
      context_citizen: "citizen-context",
    });
    await composition.close();
    expect(calls.slice(3)).toEqual([
      "host:close",
      "context:close",
      "capability:close",
      "provider-store:close",
    ]);
  });

  it("rolls back partial startup in reverse order", async () => {
    const calls: string[] = [];
    const composition = new ManagedFeishuProviderComposition({
      capability_citizen_id: "citizen-capability",
      context_citizen_id: "citizen-context",
      capability_citizen: {
        start: async () => { calls.push("capability:start"); },
        health: async () => ({ status: "available" as const }),
        close: async () => { calls.push("capability:close"); },
      },
      context_citizen: {
        start: async () => {
          calls.push("context:start");
          throw new Error("context failed");
        },
        health: async () => ({ status: "unavailable" as const }),
        close: async () => { calls.push("context:close"); },
      },
      host: {
        start: async () => { calls.push("host:start"); },
        close: async () => { calls.push("host:close"); },
      },
      close_provider_store: async () => { calls.push("provider-store:close"); },
    });
    await expect(composition.start()).rejects.toThrow("context failed");
    expect(calls).toEqual([
      "capability:start",
      "context:start",
      "context:close",
      "capability:close",
      "provider-store:close",
    ]);
    await expect(composition.health()).resolves.toMatchObject({
      provider: "failed",
    });
  });
});
