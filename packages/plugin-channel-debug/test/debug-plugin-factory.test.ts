import { createServer } from "node:net";

import type { CollaborationAdmissionService } from "@work-fabric/admission-spi";
import { MemoryConnectorIngressStore } from "@work-fabric/adapter-connector-memory";
import { MemoryDebugChannelStore } from "@work-fabric/adapter-debug-channel-memory";
import { MemoryChannelRouteStore } from "@work-fabric/adapter-storage-memory";
import {
  channelHandoffSnapshotSourceManifest,
  type ChannelHandoffSnapshotSource,
} from "@work-fabric/channel-spi";
import { MemorySubscriptionStore } from "@work-fabric/exchange-runtime";
import type { ConnectorCommandSink } from "@work-fabric/connector-spi";
import type { SignalAdapter } from "@work-fabric/exchange-spi";
import { describe, expect, it, vi } from "vitest";

import {
  DebugPluginFactory,
  type DebugChannelSignalRegistration,
} from "../src/index.js";
import { validDebugConfig } from "./fixtures.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test listener has no TCP port");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function snapshotSource(): ChannelHandoffSnapshotSource {
  return {
    manifest: channelHandoffSnapshotSourceManifest("test"),
    async get() {
      return { kind: "not_found" };
    },
  };
}

async function fixture(options: {
  readonly development_mode?: boolean;
  readonly admission?: CollaborationAdmissionService | null;
  readonly port?: number;
} = {}) {
  const registered = new Map<string, SignalAdapter>();
  const signals: DebugChannelSignalRegistration = {
    register(instanceId, adapter) {
      if (registered.has(instanceId)) throw new Error("duplicate registration");
      registered.set(instanceId, adapter);
    },
    unregister(instanceId) {
      registered.delete(instanceId);
    },
  };
  const services = new Map<string, unknown>([
    ["workfabric.tenant_id", "tenant-local"],
    ["workfabric.development_mode", options.development_mode ?? true],
    ["channel.routes", new MemoryChannelRouteStore()],
    ["channel.handoff_snapshot_source", snapshotSource()],
    ["exchange.subscriptions", new MemorySubscriptionStore()],
    ["connector.ingress", new MemoryConnectorIngressStore()],
    ["connector.command_sink", {
      manifest: {
        profile: "connector.command-sink.v1",
        adapter: "test",
        capabilities: {},
      },
      async execute() {
        return {
          kind: "accepted" as const,
          receipt_id: "receipt-1",
          event_ids: [],
        };
      },
    } satisfies ConnectorCommandSink],
    ["channel.signal_registry", signals],
    ["debug.channel_store", new MemoryDebugChannelStore()],
    ["runtime.clock", {
      now: () => "2026-07-29T09:00:00.000Z",
      nowEpochSeconds: () => 1_785_316_800,
    }],
    ["runtime.debug_ids", {
      requestId: () => "debug_request_1",
      submissionId: () => "submission-1",
    }],
    ["runtime.debug_cursor", {
      async encode() { return "cursor"; },
      async decode() {
        return {
          captured_at: "2026-07-29T09:00:00.000Z",
          capture_id: "capture-1",
        };
      },
    }],
    ["runtime.handoff_wakeup", vi.fn()],
  ]);
  const admission = options.admission === undefined
    ? { async admit() { throw new Error("unused"); } }
    : options.admission;
  if (admission !== null) {
    services.set("collaboration.admission", admission);
  }
  const requested: string[] = [];
  const context = {
    configuration_revision: "test-revision",
    service: {
      get<T>(capability: string): T {
        requested.push(capability);
        if (!services.has(capability)) throw new Error(capability);
        return services.get(capability) as T;
      },
    },
  };
  const config = {
    ...validDebugConfig(),
    listen: {
      host: "127.0.0.1",
      port: options.port ?? await freePort(),
    },
    credentials: { bearer_token: "debug-token" },
  };
  return { context, config, requested, registered };
}

describe("DebugPluginFactory", () => {
  it("refuses to compose outside explicit development mode", async () => {
    const setup = await fixture({ development_mode: false });
    await expect(new DebugPluginFactory().create(setup.context, {
      instance_id: "debug-local",
      type: "collaboration-channel.debug",
      config: setup.config,
    })).rejects.toThrow("development_mode");
    expect(setup.registered).toHaveLength(0);
  });

  it("requires connector identity to equal the plugin instance", async () => {
    const setup = await fixture({ admission: null });
    await expect(new DebugPluginFactory().create(setup.context, {
      instance_id: "another-instance",
      type: "collaboration-channel.debug",
      config: setup.config,
    })).rejects.toThrow("connector_id");
  });

  it("prepares without listening, starts loopback HTTP, and cleans up idempotently", async () => {
    const setup = await fixture();
    const plugin = await new DebugPluginFactory().create(setup.context, {
      instance_id: "debug-local",
      type: "collaboration-channel.debug",
      config: setup.config,
    });
    await plugin.prepare();
    expect(setup.registered.has("debug-local")).toBe(true);
    await expect(fetch(
      `http://127.0.0.1:${setup.config.listen.port}/health`,
    )).rejects.toThrow();
    await plugin.start();
    await expect((await fetch(
      `http://127.0.0.1:${setup.config.listen.port}/health`,
    )).json()).resolves.toEqual({ state: "healthy", code: "listening" });
    await expect(plugin.health()).resolves.toEqual({
      state: "healthy",
      code: "ready",
    });
    await plugin.stop();
    await plugin.stop();
    expect(setup.registered.has("debug-local")).toBe(false);
  });

  it("does not request Admission for an all-static participant set", async () => {
    const setup = await fixture();
    const staticOnly = {
      ...setup.config,
      participants: {
        "internal-user": setup.config.participants["internal-user"],
      },
    };
    const plugin = await new DebugPluginFactory().create(setup.context, {
      instance_id: "debug-local",
      type: "collaboration-channel.debug",
      config: staticOnly,
    });
    expect(setup.requested).not.toContain("collaboration.admission");
    await plugin.stop();
  });

  it("requires Admission only when a participant declares Admission mode", async () => {
    const setup = await fixture({ admission: null });
    await expect(new DebugPluginFactory().create(setup.context, {
      instance_id: "debug-local",
      type: "collaboration-channel.debug",
      config: setup.config,
    })).rejects.toThrow("collaboration.admission");
  });

  it("rolls back registrations when HTTP startup hits a port conflict", async () => {
    const port = await freePort();
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(port, "127.0.0.1", () => resolve());
    });
    const setup = await fixture({
      port,
      admission: { async admit() { throw new Error("unused"); } },
    });
    const plugin = await new DebugPluginFactory().create(setup.context, {
      instance_id: "debug-local",
      type: "collaboration-channel.debug",
      config: setup.config,
    });
    try {
      await plugin.prepare();
      await expect(plugin.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await plugin.stop();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
    expect(setup.registered.has("debug-local")).toBe(false);
  });
});
