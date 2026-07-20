import type {
  FeishuLongConnectionAcceptance,
  FeishuLongConnectionClient,
  FeishuLongConnectionHandler,
  FeishuLongConnectionStatus,
} from "@work-fabric/connector-feishu";
import type { JsonObject } from "@work-fabric/exchange-spi";
import { describe, expect, it } from "vitest";

import { composeNodeService, parseServiceConfig } from "../src/index.js";

interface LocalCommand {
  readonly body: Record<string, unknown>;
  readonly authorization: string | null;
  readonly status: number;
  readonly response: Record<string, unknown>;
}

class CapturingLongConnection implements FeishuLongConnectionClient {
  handler: FeishuLongConnectionHandler | undefined;
  private snapshot: FeishuLongConnectionStatus = {
    state: "connecting",
    code: "connecting",
    reconnect_attempts: 0,
    changed_at: "2026-07-20T00:00:00.000Z",
  };

  start(handler: FeishuLongConnectionHandler): Promise<void> {
    this.handler = handler;
    this.snapshot = { ...this.snapshot, state: "connected", code: "connected" };
    return Promise.resolve();
  }

  status(): FeishuLongConnectionStatus { return { ...this.snapshot }; }

  stop(): Promise<void> {
    this.snapshot = { ...this.snapshot, state: "stopped", code: "stopped" };
    return Promise.resolve();
  }

  emit(body: JsonObject): Promise<FeishuLongConnectionAcceptance> {
    if (this.handler === undefined) throw new Error("long_connection_not_started");
    return this.handler(body);
  }
}

function event(eventId: string, subject: string, text = eventId): JsonObject {
  return {
    schema: "2.0",
    header: {
      event_id: eventId,
      event_type: "im.message.receive_v1",
      create_time: "1784505600000",
      tenant_key: "tenant-key",
      token: "verify-placeholder",
    },
    event: {
      sender: { sender_id: { open_id: subject }, sender_type: "user" },
      message: {
        message_id: `message-${eventId}`,
        chat_id: "chat-original",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: `@_bot ${text}` }),
        mentions: [{ key: "@_bot", id: { open_id: "bot-open-id" }, name: "Work Fabric" }],
      },
    },
  };
}

function policy() {
  return {
    evidence_providers: {
      "feishu-directory": {
        type: "feishu.directory",
        config: { plugin_instance_id: "feishu-primary" },
      },
    },
    policies: {
      "feishu-participants": {
        policy_id: "feishu-participants",
        revision: "1",
        tenant_id: "tenant-local",
        connector_id: "feishu-primary",
        source_system: "feishu",
        external_tenant_id: "tenant-key",
        default: "deny" as const,
        allow: {
          all_internal_members: true,
          external_subject_ids: ["subject-exact", "subject-duplicate"],
        },
        deny: { external_subject_ids: ["subject-denied"] },
        internal_membership: {
          evidence_provider_ref: "feishu-directory",
          positive_ttl_seconds: 300,
          negative_ttl_seconds: 60,
        },
        binding: { actor_type: "human" as const, store_ref: "participant-bindings" },
      },
    },
  };
}

function serviceConfig() {
  return parseServiceConfig({
    storage_profile: "memory-demo",
    development_mode: true,
    role: "all",
    tenant_id: "tenant-local",
    exchange_id: "exchange-local",
    cursor_secret: "c".repeat(32),
    admission: {
      subject_fingerprint_key: "f".repeat(32),
      grant_active_key_id: "primary",
      grant_keys: { primary: "g".repeat(32) },
      grant_ttl_seconds: 60,
      max_evidence_cache_entries: 100,
    },
    identities: [{
      authentication_evidence: { bearer_token: "unused-local-token" },
      principal: {
        principal_id: "unused-local-principal",
        tenant_id: "tenant-local",
        actor_claims: [{
          actor_id: "unused-local-actor",
          actor_type: "human" as const,
          endpoint_ids: ["unused-local-endpoint"],
        }],
        attributes: {},
      },
    }],
    authority_rules: [{
      tenant_id: "tenant-local",
      principal_id: "unused-local-principal",
      actor_id: "unused-local-actor",
      actor_type: "human" as const,
      endpoint_id: "unused-local-endpoint",
      action: "workfabric.operations.health.read.v1",
      resource_id: null,
    }, {
      tenant_id: "tenant-local",
      principal_id: "unused-local-principal",
      actor_id: "unused-local-actor",
      actor_type: "human" as const,
      endpoint_id: "unused-local-endpoint",
      action: "workfabric.operations.connector-ingress.read.v1",
      resource_id: "feishu-primary",
    }],
    listen: { host: "127.0.0.1", port: 0 },
  });
}

function plugin(transport: "webhook" | "long_connection") {
  return {
    connector_id: "feishu-primary",
    external_tenant_id: "tenant-key",
    bot_open_id: "bot-open-id",
    credentials: {
      app_id: "app-id-placeholder",
      app_secret: "app-secret-placeholder",
      ...(transport === "webhook" ? { verification_token: "verify-placeholder" } : {}),
      work_fabric_access_token: "bootstrap-token-placeholder",
    },
    inbound: {
      enabled: true,
      transport,
      ...(transport === "webhook" ? { route_id: "primary" } : {}),
      mention_only: true as const,
      intake_target: { actor_id: "intake-agent", endpoint_id: "intake-endpoint" },
      accept_within_seconds: 60,
      result_due_within_seconds: 3_600,
    },
    outbound: {
      enabled: false,
      default_render_mode: "text" as const,
      channels: {},
      subscriptions: {},
    },
    identity_admission: { policy_id: "feishu-participants" },
    worker: { poll_interval_ms: 10, lease_seconds: 30, batch_limit: 20, max_attempts: 4 },
  };
}

function responseBody(items: readonly string[]): string {
  return JSON.stringify({
    code: 0,
    data: {
      items: items.map((openId) => ({
        open_id: openId,
        status: { is_activated: true, is_exited: false },
      })),
    },
  });
}

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 6_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("timed_out_waiting_for_admission_e2e");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function commandIntent(command: LocalCommand): string {
  const payload = command.body.payload as { intent: Array<{ text: string }> };
  return payload.intent[0]!.text;
}

describe("Feishu Collaboration Admission E2E", () => {
  it("enforces precedence, stable bindings, fail-closed evidence and duplicate-safe recovery through the public SDK", async () => {
    const commands: LocalCommand[] = [];
    const contactCalls = new Map<string, number>();
    const systemFetch = globalThis.fetch.bind(globalThis);
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname !== "open.feishu.cn") {
        const body = JSON.parse(await request.clone().text()) as Record<string, unknown>;
        const response = await systemFetch(request);
        const responseText = await response.clone().text();
        if (request.method === "POST" && url.pathname === "/v1/commands") {
          commands.push({
            body,
            authorization: request.headers.get("authorization"),
            status: response.status,
            response: JSON.parse(responseText) as Record<string, unknown>,
          });
        }
        return response;
      }
      if (url.pathname.includes("tenant_access_token")) {
        return new Response(JSON.stringify({
          code: 0,
          tenant_access_token: "tenant-token-placeholder",
          expire: 7_200,
        }), { status: 200 });
      }
      if (url.pathname.includes("/contact/v3/users/batch")) {
        const subject = url.searchParams.get("user_ids") ?? "";
        const calls = (contactCalls.get(subject) ?? 0) + 1;
        contactCalls.set(subject, calls);
        if (subject === "subject-outage" && calls === 1) {
          return new Response("temporarily unavailable", { status: 503 });
        }
        const internal = new Set(["subject-internal", "subject-outage", "subject-denied"]);
        return new Response(responseBody(internal.has(subject) ? [subject] : []), { status: 200 });
      }
      throw new Error(`unexpected Feishu request ${url.pathname}`);
    }) as typeof globalThis.fetch;
    const service = await composeNodeService(serviceConfig(), {
      configuration_revision: "admission-e2e",
      plugins: {
        "feishu-primary": {
          type: "collaboration-channel.feishu",
          enabled: true,
          config: plugin("webhook"),
        },
      },
      admission: policy(),
      fetch,
    });
    await service.listen();
    await service.start();
    const dispatch = (body: JsonObject) => service.http.dispatch({
      method: "POST",
      url: "/v1/connectors/feishu/feishu-primary/events",
      headers: { "content-type": "application/json" },
      payload: body,
    });
    const waitForIngressState = (eventId: string, state: string) => waitFor(async () => {
      const response = await service.http.dispatch({
        method: "GET",
        url: "/v1/operations/connectors/feishu-primary/ingress",
        headers: {
          authorization: "Bearer unused-local-token",
          "x-wf-actor-id": "unused-local-actor",
          "x-wf-endpoint-id": "unused-local-endpoint",
        },
      });
      if (response.status_code !== 200) throw new Error("ingress_query_failed");
      const item = (response.json() as { items: Array<{ external_event_id: string; state: string }> })
        .items.find((candidate) => candidate.external_event_id === eventId);
      return item?.state === state ? item : undefined;
    });
    try {
      await dispatch(event("exact", "subject-exact", "exact allow"));
      await waitFor(() => commands.find((item) => commandIntent(item) === "exact allow"));
      expect(commands.filter((item) => commandIntent(item) === "exact allow")).toHaveLength(1);

      await dispatch(event("denied", "subject-denied", "exact deny"));
      await waitForIngressState("denied", "dead_letter");
      expect(commands.some((item) => commandIntent(item) === "exact deny")).toBe(false);
      expect(contactCalls.get("subject-denied")).toBeUndefined();

      await dispatch(event("internal-one", "subject-internal", "internal one"));
      await dispatch(event("internal-two", "subject-internal", "internal two"));
      await waitFor(() => commands.filter((item) => commandIntent(item).startsWith("internal ")).length === 2
        ? true
        : undefined);
      const internalCommands = commands.filter((item) => commandIntent(item).startsWith("internal "));
      expect(internalCommands.map((item) => item.body.actor_id)).toEqual([
        internalCommands[0]!.body.actor_id,
        internalCommands[0]!.body.actor_id,
      ]);
      expect(internalCommands.map((item) => item.body.endpoint_id)).toEqual([
        internalCommands[0]!.body.endpoint_id,
        internalCommands[0]!.body.endpoint_id,
      ]);
      expect(internalCommands[0]!.body.actor_id).not.toBe(
        commands.find((item) => commandIntent(item) === "exact allow")!.body.actor_id,
      );
      expect(internalCommands[0]!.body.endpoint_id).not.toBe(
        commands.find((item) => commandIntent(item) === "exact allow")!.body.endpoint_id,
      );

      await dispatch(event("unknown", "subject-unknown", "unknown"));
      await dispatch(event("guest", "subject-guest", "guest"));
      await Promise.all([
        waitForIngressState("unknown", "dead_letter"),
        waitForIngressState("guest", "dead_letter"),
      ]);
      expect(commands.some((item) => ["unknown", "guest"].includes(commandIntent(item)))).toBe(false);

      const duplicateEvent = event("duplicate", "subject-duplicate", "duplicate");
      const accepted = await dispatch(duplicateEvent);
      const duplicate = await dispatch(duplicateEvent);
      expect(accepted.json()).toMatchObject({ accepted: true, duplicate: false });
      expect(duplicate.json()).toMatchObject({ accepted: true, duplicate: true });
      const duplicateCommand = await waitFor(() => commands.find((item) => commandIntent(item) === "duplicate"));
      expect(commands.filter((item) => commandIntent(item) === "duplicate")).toHaveLength(1);
      const ingressId = (accepted.json() as { ingress_id: string }).ingress_id;
      const admissionRequest = {
        tenant_id: "tenant-local",
        connector_id: "feishu-primary",
        source_system: "feishu",
        external_tenant_id: "tenant-key",
        external_subject_type: "human" as const,
        external_subject_id: "subject-duplicate",
        ingress_id: ingressId,
      };
      const firstDecision = await service.admission!.admit("feishu-participants", admissionRequest);
      const reusedDecision = await service.admission!.admit("feishu-participants", admissionRequest);
      expect(reusedDecision.decision).toEqual(firstDecision.decision);
      expect(duplicateCommand.response).toMatchObject({
        operation_status: "accepted",
        resource: { resource_type: "handoff", resource_version: 1 },
      });

      await dispatch(event("outage", "subject-outage", "outage recovered"));
      const recovered = await waitFor(
        () => commands.find((item) => commandIntent(item) === "outage recovered"),
        7_000,
      );
      expect(contactCalls.get("subject-outage")).toBe(2);
      expect(recovered.status).toBe(200);

      const handoffIds = commands.map((item) =>
        (item.response.resource as { resource_id: string }).resource_id
      );
      expect(new Set(handoffIds).size).toBe(commands.length);
      expect(commands).toHaveLength(5);
      expect(commands.every((item) => {
        const credential = item.authorization?.replace(/^Bearer /, "");
        return credential !== undefined
          && credential !== "bootstrap-token-placeholder"
          && credential.split(".").length === 2;
      })).toBe(true);
      expect(commands.every((item) => item.status === 200)).toBe(true);
    } finally {
      await service.close();
    }
  }, 15_000);

  it("produces the same admitted Handoff result for webhook and long-connection envelopes", async () => {
    const run = async (transport: "webhook" | "long_connection") => {
      const commands: LocalCommand[] = [];
      const longConnection = new CapturingLongConnection();
      const systemFetch = globalThis.fetch.bind(globalThis);
      const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.hostname === "open.feishu.cn") {
          if (url.pathname.includes("tenant_access_token")) {
            return new Response(JSON.stringify({ code: 0, tenant_access_token: "token", expire: 7_200 }), { status: 200 });
          }
          return new Response(responseBody([]), { status: 200 });
        }
        const body = JSON.parse(await request.clone().text()) as Record<string, unknown>;
        const response = await systemFetch(request);
        if (url.pathname === "/v1/commands") {
          commands.push({
            body,
            authorization: request.headers.get("authorization"),
            status: response.status,
            response: JSON.parse(await response.clone().text()) as Record<string, unknown>,
          });
        }
        return response;
      }) as typeof globalThis.fetch;
      const service = await composeNodeService(serviceConfig(), {
        plugins: {
          "feishu-primary": {
            type: "collaboration-channel.feishu",
            enabled: true,
            config: plugin(transport),
          },
        },
        admission: policy(),
        fetch,
        feishu_long_connection_client_factory: { create: () => longConnection },
      });
      await service.listen();
      await service.start();
      try {
        const body = event("transport-equivalence", "subject-exact", "transport equivalent");
        if (transport === "webhook") {
          const result = await service.http.dispatch({
            method: "POST",
            url: "/v1/connectors/feishu/feishu-primary/events",
            headers: { "content-type": "application/json" },
            payload: body,
          });
          expect(result.status_code).toBe(200);
        } else {
          await expect(longConnection.emit(body)).resolves.toMatchObject({ accepted: true, duplicate: false });
        }
        const command = await waitFor(() => commands[0]);
        return {
          actor_id: command.body.actor_id,
          endpoint_id: command.body.endpoint_id,
          intent: commandIntent(command),
          status: command.status,
          operation_status: command.response.operation_status,
          resource_type: (command.response.resource as { resource_type: string }).resource_type,
        };
      } finally {
        await service.close();
      }
    };

    const webhook = await run("webhook");
    await expect(run("long_connection")).resolves.toEqual(webhook);
  }, 15_000);
});
