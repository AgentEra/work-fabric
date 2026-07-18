import { request as httpsRequest, type Agent } from "node:https";
import { createServer } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFeishuNodeNetworkGuard,
  createFeishuNodeSdkRuntime,
  type FeishuNodeSdkRuntimeDependencies,
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

function dependencies() {
  const endpoint = deferred<unknown>();
  const requests: Array<{ readonly signal: AbortSignal }> = [];
  const closeInputs: unknown[] = [];
  const readyCalls: unknown[] = [];
  let guardStopped = false;
  const guardIdle = deferred<void>();
  let sdkStartSettled = false;

  const sdk: FeishuNodeSdkRuntimeDependencies = {
    request: async (_options, signal) => {
      requests.push({ signal });
      return endpoint.promise;
    },
    createNetworkGuard: () => ({
      agent: { kind: "fake-agent" },
      stop: () => {
        guardStopped = true;
      },
      whenIdle: () => guardIdle.promise,
    }),
    createClient: (input) => ({
      start: () => {
        expect(input.autoReconnect).toBe(true);
        expect(input.handshakeTimeoutMs).toBe(15_000);
        expect(input.loggerLevel).toBe(3);
        expect(input.agent).toEqual({ kind: "fake-agent" });
        void input.httpInstance.request({}).then((response) => {
          if (
            !guardStopped
            && (response as { readonly code?: number }).code === 0
          ) {
            readyCalls.push(undefined);
            input.onReady();
          }
        });
        sdkStartSettled = true;
        return Promise.resolve();
      },
      close: (closeInput) => {
        closeInputs.push(closeInput);
      },
      getConnectionStatus: () => ({ state: "connecting", reconnectAttempts: 0 }),
    }),
    createMessageDispatcher: () => ({ kind: "dispatcher" }),
    infoLoggerLevel: 3,
  };

  return {
    closeInputs,
    endpoint,
    guardIdle,
    readyCalls,
    requests,
    sdk,
    sdkStartSettled: () => sdkStartSettled,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Feishu production SDK runtime lifecycle adaptation", () => {
  it("uses a bounded pong watchdog and exposes reconnect state after a blackhole", async () => {
    vi.useFakeTimers();
    const guardIdle = deferred<void>();
    let rawStatus: {
      state: "idle" | "connecting" | "connected" | "reconnecting" | "failed";
      reconnectAttempts: number;
      lastConnectTime: number;
      nextConnectTime: number;
      requestId?: string;
      detail?: string;
    } = {
      state: "connected" as const,
      reconnectAttempts: 0,
      lastConnectTime: 123,
      nextConnectTime: 456,
      requestId: "request-must-not-cross-seam",
      detail: "private sdk detail",
    };
    let recover!: () => void;
    const sdk: FeishuNodeSdkRuntimeDependencies = {
      request: async () => ({ code: 0, data: {}, msg: "ok" }),
      createNetworkGuard: () => ({
        agent: {},
        stop: () => undefined,
        whenIdle: () => guardIdle.promise,
      }),
      createClient: (input) => ({
        start: () => {
          input.onReady();
          setTimeout(() => {
            rawStatus = {
              state: "reconnecting",
              reconnectAttempts: 1,
              lastConnectTime: 789,
              nextConnectTime: 999,
            };
            input.onReconnecting();
          }, input.wsConfig.pingTimeout * 1_000);
          recover = () => {
            rawStatus = {
              state: "connected",
              reconnectAttempts: 0,
              lastConnectTime: 1_000,
              nextConnectTime: 0,
            };
            input.onReconnected();
          };
          return Promise.resolve();
        },
        close: () => undefined,
        getConnectionStatus: () => rawStatus,
      }),
      createMessageDispatcher: () => ({}),
      infoLoggerLevel: 3,
    };
    const transitions: string[] = [];
    const client = createFeishuNodeSdkRuntime(sdk).createClient({
      app_id: "cli_0123456789abcdef",
      app_secret: "secret",
      callbacks: {
        onReady: () => transitions.push("connected"),
        onError: () => transitions.push("failed"),
        onReconnecting: () => transitions.push("reconnecting"),
        onReconnected: () => transitions.push("reconnected"),
      },
    });

    const run = client.start({ eventDispatcher: {} });
    expect(client.getConnectionStatus()).toEqual({
      state: "connected",
      reconnect_attempts: 0,
    });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(transitions).toEqual(["connected"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(transitions).toEqual(["connected", "reconnecting"]);
    expect(client.getConnectionStatus()).toEqual({
      state: "reconnecting",
      reconnect_attempts: 1,
    });

    recover();
    expect(transitions).toEqual(["connected", "reconnecting", "reconnected"]);
    expect(client.getConnectionStatus()).toEqual({
      state: "connected",
      reconnect_attempts: 0,
    });

    client.close();
    guardIdle.resolve(undefined);
    await run;
  });

  it("force-terminates a socket stalled in the TLS handshake", async () => {
    const sockets = new Set<import("node:net").Socket>();
    let resolveConnected!: () => void;
    const connected = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      resolveConnected();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("local_test_server_address_unavailable");
    }
    const guard = createFeishuNodeNetworkGuard();
    const requestError = new Promise<void>((resolve) => {
      const request = httpsRequest({
        host: "127.0.0.1",
        port: address.port,
        method: "GET",
        agent: guard.agent as Agent,
        rejectUnauthorized: false,
      });
      request.once("error", () => resolve());
      request.end();
    });

    try {
      await connected;
      guard.stop();
      await guard.whenIdle();
      await requestError;
      expect(sockets.size).toBe(0);
    } finally {
      guard.stop();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps its run pending when pinned SDK start resolves immediately", async () => {
    const fixture = dependencies();
    const runtime = createFeishuNodeSdkRuntime(fixture.sdk);
    const client = runtime.createClient({
      app_id: "cli_0123456789abcdef",
      app_secret: "secret",
      callbacks: {
        onReady: () => undefined,
        onError: () => undefined,
        onReconnecting: () => undefined,
        onReconnected: () => undefined,
      },
    });

    const run = client.start({ eventDispatcher: {} });
    await Promise.resolve();

    expect(fixture.sdkStartSettled()).toBe(true);
    await expect(Promise.race([
      run.then(() => "settled"),
      new Promise<string>((resolve) => setImmediate(() => resolve("pending"))),
    ])).resolves.toBe("pending");

    client.close();
    fixture.endpoint.resolve({ code: 403, data: {}, msg: "cancelled" });
    fixture.guardIdle.resolve(undefined);
    await run;
  });

  it("cancels initial setup and force-closes before its adapted run settles", async () => {
    const fixture = dependencies();
    const runtime = createFeishuNodeSdkRuntime(fixture.sdk);
    let ready = 0;
    const client = runtime.createClient({
      app_id: "cli_0123456789abcdef",
      app_secret: "secret",
      callbacks: {
        onReady: () => {
          ready += 1;
        },
        onError: () => undefined,
        onReconnecting: () => undefined,
        onReconnected: () => undefined,
      },
    });
    const run = client.start({ eventDispatcher: {} });
    await Promise.resolve();

    client.close();
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.signal.aborted).toBe(true);
    expect(fixture.closeInputs[0]).toEqual({ force: true });

    fixture.endpoint.resolve({ code: 0, data: { URL: "wss://late" }, msg: "ok" });
    fixture.guardIdle.resolve(undefined);
    await run;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(fixture.closeInputs).toEqual([{ force: true }, { force: true }]);
    expect(fixture.readyCalls).toEqual([]);
    expect(ready).toBe(0);
  });

  it("clears a reconnect timer scheduled after the first force close", async () => {
    const handshakeStarted = deferred<void>();
    const handshakeReleased = deferred<void>();
    const closeInputs: unknown[] = [];
    let reconnectTimer: NodeJS.Timeout | undefined;
    let ready = 0;
    const sdk: FeishuNodeSdkRuntimeDependencies = {
      request: async () => ({ code: 0, data: {}, msg: "ok" }),
      createNetworkGuard: () => ({
        agent: {},
        stop: () => handshakeReleased.resolve(undefined),
        whenIdle: () => new Promise((resolve) => setImmediate(resolve)),
      }),
      createClient: (input) => ({
        start: () => {
          void input.httpInstance.request({}).then(async () => {
            handshakeStarted.resolve(undefined);
            await handshakeReleased.promise;
            reconnectTimer = setTimeout(() => input.onReady(), 25);
          });
          return Promise.resolve();
        },
        close: (closeInput) => {
          closeInputs.push(closeInput);
          if (reconnectTimer !== undefined) {
            clearTimeout(reconnectTimer);
            reconnectTimer = undefined;
          }
        },
        getConnectionStatus: () => ({ state: "connecting", reconnectAttempts: 0 }),
      }),
      createMessageDispatcher: () => ({}),
      infoLoggerLevel: 3,
    };
    const client = createFeishuNodeSdkRuntime(sdk).createClient({
      app_id: "cli_0123456789abcdef",
      app_secret: "secret",
      callbacks: {
        onReady: () => {
          ready += 1;
        },
        onError: () => undefined,
        onReconnecting: () => undefined,
        onReconnected: () => undefined,
      },
    });
    const run = client.start({ eventDispatcher: {} });
    await handshakeStarted.promise;

    client.close();
    await run;
    await new Promise<void>((resolve) => setTimeout(resolve, 35));

    expect(closeInputs).toEqual([{ force: true }, { force: true }]);
    expect(ready).toBe(0);
  });

  it("consumes cleanup rejection and still settles its adapted run", async () => {
    const fixture = dependencies();
    const sdk: FeishuNodeSdkRuntimeDependencies = {
      ...fixture.sdk,
      createNetworkGuard: () => ({
        agent: {},
        stop: () => undefined,
        whenIdle: () => Promise.reject(new Error("private cleanup failure")),
      }),
    };
    const unhandled: unknown[] = [];
    const sentinel = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", sentinel);
    const client = createFeishuNodeSdkRuntime(sdk).createClient({
      app_id: "cli_0123456789abcdef",
      app_secret: "secret",
      callbacks: {
        onReady: () => undefined,
        onError: () => undefined,
        onReconnecting: () => undefined,
        onReconnected: () => undefined,
      },
    });

    try {
      const run = client.start({ eventDispatcher: {} });
      await Promise.resolve();
      client.close();
      fixture.endpoint.resolve({ code: 403, data: {}, msg: "cancelled" });

      await expect(Promise.race([
        run.then(() => "settled"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 20)),
      ])).resolves.toBe("settled");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", sentinel);
    }
  });
});
