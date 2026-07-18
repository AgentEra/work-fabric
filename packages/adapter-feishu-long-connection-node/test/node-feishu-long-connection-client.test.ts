import type { FeishuLongConnectionHandler } from "@work-fabric/connector-feishu";
import { describe, expect, it } from "vitest";

import { NodeFeishuLongConnectionClientFactory } from "../src/node-feishu-long-connection-client.js";
import type {
  FeishuNodeSdkCallbacks,
  FeishuNodeSdkRuntime,
  FeishuNodeSdkStatus,
  FeishuNodeWsClient,
} from "../src/sdk-runtime.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function messageEvent() {
  return {
    event_id: "event-1",
    event_type: "im.message.receive_v1",
    create_time: "1700000000000",
    tenant_key: "tenant-1",
    sender: {
      sender_id: { open_id: "open-1" },
      sender_type: "user",
    },
    message: {
      message_id: "message-1",
      chat_id: "chat-1",
      chat_type: "p2p",
      message_type: "text",
      content: "{\"text\":\"hello\"}",
    },
  };
}

class FakeRuntime implements FeishuNodeSdkRuntime {
  createClientCalls = 0;
  createDispatcherCalls = 0;
  startCalls = 0;
  closeCalls = 0;
  callbacks: FeishuNodeSdkCallbacks | undefined;
  dispatcherHandler: ((data: unknown) => Promise<unknown>) | undefined;
  throwDuringDispatcherCreation = false;
  settleRunOnClose = true;
  readonly run = deferred<void>();
  throwStatus = false;
  sdkStatus: FeishuNodeSdkStatus = {
    state: "connecting" as const,
    reconnect_attempts: 0,
  };

  createClient(input: {
    readonly app_id: string;
    readonly app_secret: string;
    readonly callbacks: FeishuNodeSdkCallbacks;
  }): FeishuNodeWsClient {
    this.createClientCalls += 1;
    this.callbacks = input.callbacks;
    return {
      start: ({ eventDispatcher }) => {
        expect(eventDispatcher).toEqual({ kind: "fake-dispatcher" });
        this.startCalls += 1;
        return this.run.promise;
      },
      close: () => {
        this.closeCalls += 1;
        if (this.settleRunOnClose) this.run.resolve(undefined);
      },
      getConnectionStatus: () => {
        if (this.throwStatus) throw new Error("private status failure");
        return { ...this.sdkStatus };
      },
    };
  }

  createMessageDispatcher(
    handler: (data: unknown) => Promise<unknown>,
  ): unknown {
    this.createDispatcherCalls += 1;
    if (this.throwDuringDispatcherCreation) {
      throw new Error("private dispatcher exception");
    }
    this.dispatcherHandler = handler;
    return { kind: "fake-dispatcher" };
  }
}

function createClient(
  sdk: FakeRuntime,
  options: {
    readonly now?: () => string;
    readonly drain_timeout_ms?: number;
    readonly run_settle_timeout_ms?: number;
  } = {},
) {
  return new NodeFeishuLongConnectionClientFactory({
    sdk,
    clock: { now: options.now ?? (() => "2026-01-01T00:00:00.000Z") },
    ...(options.drain_timeout_ms === undefined
      ? {}
      : { drain_timeout_ms: options.drain_timeout_ms }),
    ...(options.run_settle_timeout_ms === undefined
      ? {}
      : { run_settle_timeout_ms: options.run_settle_timeout_ms }),
  }).create({
    app_id: "cli_0123456789abcdef",
    app_secret: "app-secret",
    instance_id: "instance-1",
  });
}

const acceptance = {
  accepted: true,
  duplicate: false,
  ingress_id: "ingress-1",
} as const;

describe("NodeFeishuLongConnectionClient", () => {
  it("performs no network or SDK construction during factory create", () => {
    const sdk = new FakeRuntime();
    const client = createClient(sdk);

    expect(sdk.createClientCalls).toBe(0);
    expect(sdk.createDispatcherCalls).toBe(0);
    expect(sdk.startCalls).toBe(0);
    expect(client.status()).toEqual({
      state: "idle",
      code: "idle",
      reconnect_attempts: 0,
      changed_at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("launches exactly one run without waiting for readiness and start is idempotent", async () => {
    const sdk = new FakeRuntime();
    const client = createClient(sdk);
    const handler: FeishuLongConnectionHandler = async () => acceptance;

    await client.start(handler);
    await client.start(handler);

    expect(sdk.createClientCalls).toBe(1);
    expect(sdk.createDispatcherCalls).toBe(1);
    expect(sdk.startCalls).toBe(1);
    expect(client.status()).toMatchObject({ state: "connecting", code: "connecting" });

    await client.stop();
  });

  it("does not start after stop has already completed", async () => {
    const sdk = new FakeRuntime();
    const client = createClient(sdk);

    await client.stop();
    await client.start(async () => acceptance);

    expect(sdk.createClientCalls).toBe(0);
    expect(sdk.startCalls).toBe(0);
    expect(client.status()).toMatchObject({ state: "stopped", code: "stopped" });
  });

  it("reports invalid app configuration as a stable failure without SDK launch", async () => {
    const sdk = new FakeRuntime();
    const client = new NodeFeishuLongConnectionClientFactory({ sdk }).create({
      app_id: "invalid-app-id",
      app_secret: "app-secret",
      instance_id: "instance-1",
    });

    await client.start(async () => acceptance);

    expect(sdk.createClientCalls).toBe(0);
    expect(sdk.startCalls).toBe(0);
    expect(client.status()).toMatchObject({
      state: "failed",
      code: "connection_failed",
    });
    await client.stop();
  });

  it("tracks ready, reconnecting, reconnected, and error using stable status snapshots", async () => {
    const sdk = new FakeRuntime();
    let clockIndex = 0;
    const times = [
      "idle-at",
      "connecting-at",
      "connected-at",
      "reconnecting-at",
      "reconnected-at",
      "failed-at",
      "stopped-at",
    ];
    const client = createClient(sdk, { now: () => times[clockIndex++] ?? "unexpected-at" });
    await client.start(async () => acceptance);

    const connecting = client.status();
    expect(Object.isFrozen(connecting)).toBe(true);
    expect(connecting).toEqual({
      state: "connecting",
      code: "connecting",
      reconnect_attempts: 0,
      changed_at: "connecting-at",
    });

    sdk.sdkStatus = { state: "connected", reconnect_attempts: 0 };
    sdk.callbacks?.onReady();
    expect(client.status()).toEqual({
      state: "connected",
      code: "connected",
      reconnect_attempts: 0,
      changed_at: "connected-at",
    });

    sdk.sdkStatus = { state: "reconnecting", reconnect_attempts: 1 };
    sdk.callbacks?.onReconnecting();
    const reconnecting = client.status();
    expect(reconnecting).toEqual({
      state: "reconnecting",
      code: "reconnecting",
      reconnect_attempts: 1,
      changed_at: "reconnecting-at",
    });
    sdk.sdkStatus = { state: "reconnecting", reconnect_attempts: 2 };
    sdk.callbacks?.onReconnecting();
    expect(client.status()).toEqual({
      state: "reconnecting",
      code: "reconnecting",
      reconnect_attempts: 2,
      changed_at: "reconnecting-at",
    });

    sdk.sdkStatus = { state: "connected", reconnect_attempts: 0 };
    sdk.callbacks?.onReconnected();
    expect(client.status()).toEqual({
      state: "connected",
      code: "connected",
      reconnect_attempts: 2,
      changed_at: "reconnected-at",
    });

    sdk.callbacks?.onError();
    expect(client.status()).toEqual({
      state: "failed",
      code: "connection_failed",
      reconnect_attempts: 2,
      changed_at: "failed-at",
    });

    await client.stop();
  });

  it("reconciles callback and polled SDK state without decreasing attempts or changing timestamps for counters", async () => {
    const sdk = new FakeRuntime();
    let clockIndex = 0;
    const times = ["idle-at", "connecting-at", "connected-at", "reconnecting-at", "failed-at"];
    const client = createClient(sdk, { now: () => times[clockIndex++] ?? "unexpected-at" });
    await client.start(async () => acceptance);

    sdk.sdkStatus = { state: "connected", reconnect_attempts: 0 };
    sdk.callbacks?.onReady();
    expect(client.status()).toMatchObject({
      state: "connected",
      reconnect_attempts: 0,
      changed_at: "connected-at",
    });

    sdk.sdkStatus = { state: "reconnecting", reconnect_attempts: 4 };
    expect(client.status()).toEqual({
      state: "reconnecting",
      code: "reconnecting",
      reconnect_attempts: 4,
      changed_at: "reconnecting-at",
    });

    sdk.sdkStatus = { state: "reconnecting", reconnect_attempts: 2 };
    expect(client.status()).toEqual({
      state: "reconnecting",
      code: "reconnecting",
      reconnect_attempts: 4,
      changed_at: "reconnecting-at",
    });

    sdk.sdkStatus = { state: "failed", reconnect_attempts: 5 };
    expect(client.status()).toEqual({
      state: "failed",
      code: "connection_failed",
      reconnect_attempts: 5,
      changed_at: "failed-at",
    });

    sdk.sdkStatus = { state: "connected", reconnect_attempts: 0 };
    sdk.callbacks?.onReconnected();
    expect(client.status()).toEqual({
      state: "failed",
      code: "connection_failed",
      reconnect_attempts: 5,
      changed_at: "failed-at",
    });

    await client.stop();
    expect(client.status()).toMatchObject({ state: "stopped", reconnect_attempts: 5 });
    sdk.sdkStatus = { state: "connected", reconnect_attempts: 0 };
    expect(client.status()).toMatchObject({ state: "stopped", reconnect_attempts: 5 });
  });

  it("keeps the last bounded status when SDK polling throws", async () => {
    const sdk = new FakeRuntime();
    const client = createClient(sdk);
    await client.start(async () => acceptance);
    sdk.sdkStatus = { state: "connected", reconnect_attempts: 0 };
    sdk.callbacks?.onReady();
    sdk.throwStatus = true;

    expect(client.status()).toMatchObject({
      state: "connected",
      code: "connected",
      reconnect_attempts: 0,
    });
    expect(JSON.stringify(client.status())).not.toContain("private status failure");

    await client.stop();
  });

  it("consumes run rejection immediately and exposes only a stable failure", async () => {
    const sdk = new FakeRuntime();
    const client = createClient(sdk);
    const unhandled: unknown[] = [];
    const sentinel = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", sentinel);

    try {
      await client.start(async () => acceptance);
      sdk.run.reject(new Error("app-secret and private exception content"));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
      expect(client.status()).toMatchObject({
        state: "failed",
        code: "connection_failed",
      });
      expect(JSON.stringify(client.status())).not.toContain("private exception content");
    } finally {
      process.off("unhandledRejection", sentinel);
      await client.stop();
    }
  });

  it("retains an SDK client for one close when dispatcher construction fails", async () => {
    const sdk = new FakeRuntime();
    sdk.throwDuringDispatcherCreation = true;
    const client = createClient(sdk);

    await client.start(async () => acceptance);
    expect(client.status()).toMatchObject({
      state: "failed",
      code: "connection_failed",
    });

    await client.stop();
    await client.stop();
    expect(sdk.closeCalls).toBe(1);
    expect(JSON.stringify(client.status())).not.toContain("private dispatcher exception");
  });

  it("refuses new callback work, drains durable acceptance, closes, settles, and stops once", async () => {
    const sdk = new FakeRuntime();
    const accepted = deferred<typeof acceptance>();
    const client = createClient(sdk);
    await client.start(async () => accepted.promise);

    const active = sdk.dispatcherHandler?.(messageEvent());
    expect(active).toBeDefined();
    const stopping = client.stop();
    await Promise.resolve();

    await expect(sdk.dispatcherHandler?.(messageEvent())).rejects.toThrow(
      "feishu_long_connection_stopping",
    );
    expect(sdk.closeCalls).toBe(0);

    accepted.resolve(acceptance);
    await expect(active).resolves.toEqual(acceptance);
    await stopping;

    expect(sdk.closeCalls).toBe(1);
    expect(client.status()).toMatchObject({ state: "stopped", code: "stopped" });
    await client.stop();
    expect(sdk.closeCalls).toBe(1);
  });

  it("bounds drain waiting and still closes an unsettled callback", async () => {
    const sdk = new FakeRuntime();
    const never = deferred<typeof acceptance>();
    const client = createClient(sdk, {
      drain_timeout_ms: 5,
      run_settle_timeout_ms: 5,
    });
    await client.start(async () => never.promise);
    const active = sdk.dispatcherHandler?.(messageEvent());

    await client.stop();

    expect(sdk.closeCalls).toBe(1);
    expect(client.status()).toMatchObject({ state: "stopped", code: "stopped" });
    never.resolve(acceptance);
    await expect(active).resolves.toEqual(acceptance);
  });

  it("bounds run settlement and consumes a rejection that arrives after stop", async () => {
    const sdk = new FakeRuntime();
    sdk.settleRunOnClose = false;
    const client = createClient(sdk, {
      drain_timeout_ms: 5,
      run_settle_timeout_ms: 5,
    });
    const unhandled: unknown[] = [];
    const sentinel = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", sentinel);

    try {
      await client.start(async () => acceptance);
      await client.stop();
      sdk.run.reject(new Error("late private run rejection"));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
      expect(client.status()).toMatchObject({ state: "stopped", code: "stopped" });
    } finally {
      process.off("unhandledRejection", sentinel);
    }
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 60_001])(
    "rejects invalid timeout %s",
    (timeout) => {
      expect(
        () => new NodeFeishuLongConnectionClientFactory({ drain_timeout_ms: timeout }),
      ).toThrow(TypeError);
      expect(
        () => new NodeFeishuLongConnectionClientFactory({ run_settle_timeout_ms: timeout }),
      ).toThrow(TypeError);
    },
  );
});
