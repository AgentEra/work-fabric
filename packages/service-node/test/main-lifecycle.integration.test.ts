import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { FeishuLongConnectionClientFactory } from "@work-fabric/connector-feishu";

import {
  composeNodeService,
  parseServiceConfig,
  startListeningNodeService,
} from "../src/index.js";

describe("Node service main lifecycle", () => {
  it("closes listener, pump, plugin client and SQLite when startup rejects after listen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "work-fabric-startup-"));
    const config = parseServiceConfig({
      storage_profile: "sqlite-local",
      role: "api",
      tenant_id: "tenant-local",
      exchange_id: "exchange-local",
      cursor_secret: "x".repeat(32),
      sqlite: { location: join(directory, "work-fabric.db") },
      listen: { host: "127.0.0.1", port: 0 },
      identities: [{
        authentication_evidence: { bearer_token: "token" },
        principal: {
          principal_id: "principal",
          tenant_id: "tenant-local",
          actor_claims: [{ actor_id: "actor", actor_type: "human", endpoint_ids: ["endpoint"] }],
          attributes: {},
        },
      }],
      authority_rules: [{
        tenant_id: "tenant-local",
        principal_id: "principal",
        actor_id: "actor",
        actor_type: "human",
        endpoint_id: "endpoint",
        action: "workfabric.operations.health.read.v1",
        resource_id: null,
      }],
    });
    const client = {
      start: vi.fn(async () => { throw new Error("long start failed"); }),
      status: () => ({
        state: "connecting" as const,
        code: "connecting" as const,
        reconnect_attempts: 0,
        changed_at: "2026-07-17T00:00:00.000Z",
      }),
      stop: vi.fn(async () => {}),
    };
    const factory: FeishuLongConnectionClientFactory = { create: () => client };
    const service = await composeNodeService(config, {
      plugins: {
        "feishu-primary": {
          type: "collaboration-channel.feishu",
          enabled: true,
          config: {
            connector_id: "feishu-primary",
            external_tenant_id: "tenant-key",
            bot_open_id: "ou-bot",
            credentials: {
              app_id: "app",
              app_secret: "secret",
              work_fabric_access_token: "connector-token",
            },
            inbound: {
              enabled: true,
              transport: "long_connection",
              mention_only: true,
              intake_target: { actor_id: "actor-agent", endpoint_id: "endpoint-agent" },
            },
            outbound: { enabled: false, default_render_mode: "card", channels: {}, subscriptions: {} },
            identities: [],
            worker: { poll_interval_ms: 1_000, lease_seconds: 30, batch_limit: 100, max_attempts: 8 },
          },
        },
      },
      feishu_long_connection_client_factory: factory,
    });
    const { origin } = await service.listen();

    try {
      vi.useFakeTimers();
      await expect(startListeningNodeService(service))
        .rejects.toThrow("long start failed");
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();

      await expect(fetch(`${origin}/health/live`, {
        signal: AbortSignal.timeout(1_000),
      })).rejects.toThrow();
      await expect(service.runProjection("partition-empty", 10))
        .rejects.toThrow();
      expect(client.stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
