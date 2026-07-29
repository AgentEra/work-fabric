import { describe, expect, it } from "vitest";
import { MemoryDebugChannelStore } from "@work-fabric/adapter-debug-channel-memory";
import { MemoryChannelRouteStore } from "@work-fabric/adapter-storage-memory";
import type { ConnectorAcceptedReceipt } from "@work-fabric/connector-spi";
import { MemorySubscriptionStore } from "@work-fabric/exchange-runtime";
import {
  DebugIntakeReceiptHandler,
} from "../src/index.js";

function acceptedReceipt(): ConnectorAcceptedReceipt {
  return {
    tenant_id: "tenant-local",
    connector_id: "debug-local",
    ingress_id: "ingress-1",
    claim: {
      ingress_id: "ingress-1",
      envelope: {
        tenant_id: "tenant-local",
        connector_id: "debug-local",
        source_system: "workfabric-debug",
        external_tenant_id: "debug-fixtures",
        external_event_id: "submission-1",
        dedupe_key: "workfabric-debug:debug-local:submission-1",
        event_type: "debug.message.receive_v1",
        partition_key: "conversation-1",
        occurred_at: "2026-07-29T09:00:00.000Z",
        received_at: "2026-07-29T09:00:01.000Z",
        payload: {
          submission_id: "submission-1",
          conversation_id: "conversation-1",
          idempotency_key: "message-1",
          participant_ref: "internal-user",
          content: [{
            kind: "text",
            media_type: "text/plain",
            text: "hello",
          }],
        },
      },
      state: "processing",
      attempt: 1,
      available_at: "2026-07-29T09:00:01.000Z",
      accepted_at: "2026-07-29T09:00:01.000Z",
      updated_at: "2026-07-29T09:00:01.000Z",
      claim_owner: "debug-worker",
      claim_token: "claim-1",
      fencing_token: 1,
      lease_expires_at: "2026-07-29T09:00:31.000Z",
    },
    command: {
      operation: "handoff.offer",
      idempotency_key: "debug:debug-local:submission-1",
      identity: {
        actor_id: "actor-debug-user",
        actor_type: "human",
        endpoint_id: "endpoint-debug-user",
      },
      input: {},
    },
    accepted: {
      kind: "accepted",
      receipt_id: "receipt-1",
      event_ids: ["event-offered-1"],
      resource: {
        resource_type: "handoff",
        resource_id: "handoff-1",
        resource_version: 1,
      },
    },
  };
}

async function fixture() {
  const routes = new MemoryChannelRouteStore();
  const subscriptions = new MemorySubscriptionStore();
  const diagnostics = new MemoryDebugChannelStore();
  await diagnostics.createSubmission({
    submission: {
      tenant_id: "tenant-local",
      plugin_instance_id: "debug-local",
      submission_id: "submission-1",
      conversation_id: "conversation-1",
      idempotency_key: "message-1",
      request_digest: "a".repeat(64),
      ingress_id: "ingress-1",
      created_at: "2026-07-29T09:00:00.000Z",
      updated_at: "2026-07-29T09:00:01.000Z",
      expires_at: "2026-08-12T09:00:00.000Z",
    },
  });
  return { routes, subscriptions, diagnostics };
}

describe("DebugIntakeReceiptHandler", () => {
  it("links the submission and writes the route before one Result subscription", async () => {
    const stores = await fixture();
    const ready: string[] = [];
    const handler = new DebugIntakeReceiptHandler({
      plugin_instance_id: "debug-local",
      routes: stores.routes,
      subscriptions: stores.subscriptions,
      diagnostics: stores.diagnostics,
      max_delivery_attempts: 8,
      on_handoff_ready: (handoffId) => { ready.push(handoffId); },
    });
    await expect(handler.record(acceptedReceipt())).resolves.toEqual({
      kind: "accepted",
      receipt_id: "debug-channel-route:handoff-1",
      event_ids: [],
    });
    await expect(stores.routes.get({
      tenant_id: "tenant-local",
      plugin_instance_id: "debug-local",
      handoff_id: "handoff-1",
    })).resolves.toMatchObject({
      external_conversation_id: "conversation-1",
      external_message_id: "submission-1",
    });
    await expect(stores.diagnostics.getSubmission({
      tenant_id: "tenant-local",
      plugin_instance_id: "debug-local",
      submission_id: "submission-1",
    })).resolves.toMatchObject({ handoff_id: "handoff-1" });
    const active = await stores.subscriptions.listActiveSubscriptions("tenant-local");
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      owner: { actor_id: "actor-debug-user", actor_type: "human" },
      endpoint_id: "endpoint-debug-user",
      filter: {
        event_types: ["workfabric.handoff.result_returned.v1"],
        handoff_ids: ["handoff-1"],
      },
      destination: {
        destination_id: "handoff:handoff-1",
        binding: "collaboration-channel",
        configuration: {
          plugin_instance_id: "debug-local",
          route_mode: "handoff",
        },
      },
    });
    expect(ready).toEqual(["handoff-1"]);
    await expect(handler.record(acceptedReceipt())).resolves.toMatchObject({
      kind: "accepted",
    });
    expect(await stores.subscriptions.listActiveSubscriptions("tenant-local")).toHaveLength(1);
  });

  it("fails permanently when accepted ingress has no persisted submission", async () => {
    const stores = await fixture();
    const handler = new DebugIntakeReceiptHandler({
      plugin_instance_id: "debug-local",
      routes: stores.routes,
      subscriptions: stores.subscriptions,
      diagnostics: new MemoryDebugChannelStore(),
      max_delivery_attempts: 8,
    });
    await expect(handler.record(acceptedReceipt())).resolves.toEqual({
      kind: "permanent_failure",
      error_code: "debug_submission_missing",
    });
  });
});
