import { appendFile } from "node:fs/promises";

import { AgentGateway } from "@work-fabric/agent-gateway";
import {
  BearerTokenProvider,
  WorkFabricClient,
  type SubscriptionDocument,
} from "@work-fabric/sdk-typescript";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function operatorDecision(): "accept" | "decline" {
  const value = required("WF_DECISION");
  if (value !== "accept" && value !== "decline") {
    throw new Error("WF_DECISION must be explicitly set to accept or decline");
  }
  return value;
}

const endpointId = required("WF_ENDPOINT_ID");
const actorId = required("WF_ACTOR_ID");
const subscriptionId = required("WF_SUBSCRIPTION_ID");
const deliveryJournal = process.env.WF_DELIVERY_JOURNAL ?? ".work-fabric-deliveries";

const client = new WorkFabricClient({
  baseUrl: required("WF_BASE_URL"),
  tenantId: required("WF_TENANT_ID"),
  exchangeId: required("WF_EXCHANGE_ID"),
  representation: { actorId, endpointId },
  authentication: new BearerTokenProvider(() => required("WF_ACCESS_TOKEN")),
});

const now = new Date().toISOString();
const subscription: SubscriptionDocument = {
  subscription_id: subscriptionId,
  owner: { actor_id: actorId, actor_type: "agent" },
  endpoint_id: endpointId,
  filter: {
    event_types: [],
    actor_ids: [],
    endpoint_ids: [],
    thread_ids: [],
    handoff_ids: [],
    work_reference_uris: [],
    capability_ids: [],
    lifecycle_states: [],
  },
  delivery: { mode: "sse" },
  state: "active",
  cursor: null,
  created_at: now,
  updated_at: now,
};

const gateway = new AgentGateway(client, {
  endpoint_id: endpointId,
  subscription,
  open_session: {
    client_session_id: required("WF_CLIENT_SESSION_ID"),
    protocol_version: "1.0",
    capabilities: [{
      capability_id: "software.implementation",
      version: "1.0.0",
      name: "Software implementation",
      description: "External implementation capability",
      input_media_types: ["text/markdown"],
      output_media_types: ["application/json"],
      input_schema_refs: [],
      output_schema_refs: [],
      interaction_modes: ["asynchronous", "status_updates"],
      constraints: {},
      extensions: {},
    }],
    availability: "available",
    requested_lease_seconds: 60,
    expected_registration_version: 1,
  },
  inbox_refresh_ms: 1_000,
  max_active_partitions: 32,
  incoming_queue_capacity: 16,
  heartbeat_retry_count: 2,
  heartbeat_backoff_ms: 500,
  graceful_close_timeout_ms: 5_000,
});

const session = await gateway.start();
const close = () => { void session.close(); };
process.once("SIGINT", close);
process.once("SIGTERM", close);

try {
  for await (const incoming of session.incoming()) {
    const handoffId = incoming.handoff.handoff_id;

    // The external Runtime persists its receive fact before acknowledging the
    // transport signal. Production code should use a durable local store.
    await appendFile(
      deliveryJournal,
      `${JSON.stringify({
        delivery_id: incoming.delivery.delivery_id,
        handoff_id: handoffId,
        persisted_at: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    await incoming.acknowledgeSignal("acknowledged");

    const decision = operatorDecision();
    const expectedVersion = incoming.handoff.stream_version;
    if (decision === "decline") {
      await session.handoffs.decline(
        { handoff_id: handoffId },
        {
          expectedVersion,
          idempotencyKey: `runtime-decline-${handoffId}-${expectedVersion}`,
        },
      );
      console.log({ handoff_id: handoffId, decision: "decline" });
      continue;
    }

    await session.handoffs.accept(
      { handoff_id: handoffId },
      {
        expectedVersion,
        idempotencyKey: `runtime-accept-${handoffId}-${expectedVersion}`,
      },
    );
    console.log({ handoff_id: handoffId, decision: "accept" });

    // Planning, model/tool selection, Codex invocation and actual work belong
    // here in the external Runtime. The Gateway deliberately has no callback
    // that can perform or auto-accept the work.
  }
} finally {
  await session.close();
}
