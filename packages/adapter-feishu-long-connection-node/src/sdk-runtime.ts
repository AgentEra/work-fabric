import { Agent, type RequestOptions } from "node:https";
import type { Duplex } from "node:stream";

import * as lark from "@larksuiteoapi/node-sdk";

import { createFeishuSdkLogger } from "./redacting-logger.js";

export interface FeishuNodeSdkCallbacks {
  readonly onReady: () => void;
  readonly onError: () => void;
  readonly onReconnecting: () => void;
  readonly onReconnected: () => void;
}

export interface FeishuNodeWsClient {
  start(input: { readonly eventDispatcher: unknown }): Promise<void>;
  close(): void;
  getConnectionStatus():
    | "idle"
    | "connecting"
    | "connected"
    | "reconnecting"
    | "failed";
}

export interface FeishuNodeSdkRuntime {
  createClient(input: {
    readonly app_id: string;
    readonly app_secret: string;
    readonly callbacks: FeishuNodeSdkCallbacks;
  }): FeishuNodeWsClient;
  createMessageDispatcher(
    handler: (data: unknown) => Promise<unknown>,
  ): unknown;
}

interface FeishuSdkHttpInstance {
  request(options: unknown): Promise<unknown>;
}

interface FeishuSdkNetworkGuard {
  readonly agent: unknown;
  stop(): void;
  whenIdle(): Promise<void>;
}

interface FeishuRawWsClient {
  start(input: { readonly eventDispatcher: unknown }): Promise<void>;
  close(input: { readonly force: true }): void;
  getConnectionStatus(): {
    readonly state:
      | "idle"
      | "connecting"
      | "connected"
      | "reconnecting"
      | "failed";
  };
}

export interface FeishuNodeSdkRuntimeDependencies {
  readonly request: (
    options: unknown,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly createNetworkGuard: () => FeishuSdkNetworkGuard;
  readonly createClient: (input: {
    readonly appId: string;
    readonly appSecret: string;
    readonly autoReconnect: true;
    readonly handshakeTimeoutMs: 15_000;
    readonly logger: ReturnType<typeof createFeishuSdkLogger>;
    readonly loggerLevel: unknown;
    readonly onReady: () => void;
    readonly onError: () => void;
    readonly onReconnecting: () => void;
    readonly onReconnected: () => void;
    readonly httpInstance: FeishuSdkHttpInstance;
    readonly agent: unknown;
  }) => FeishuRawWsClient;
  readonly createMessageDispatcher: (
    handler: (data: unknown) => Promise<unknown>,
  ) => unknown;
  readonly infoLoggerLevel: unknown;
}

const CANCELLATION_RESPONSE = Object.freeze({
  code: 403,
  data: Object.freeze({
    URL: "",
    ClientConfig: Object.freeze({
      PingInterval: 0,
      ReconnectCount: 0,
      ReconnectInterval: 0,
      ReconnectNonce: 0,
    }),
  }),
  msg: "feishu_long_connection_stopping",
});

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class StoppableHttpsAgent extends Agent implements FeishuSdkNetworkGuard {
  readonly agent: unknown = this;
  private stopped = false;
  private readonly activeSockets = new Set<Duplex>();
  private readonly idleWaiters = new Set<() => void>();

  override createConnection(
    options: RequestOptions,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const connection = super.createConnection(options, callback);
    if (connection === null || connection === undefined) return connection;
    this.activeSockets.add(connection);
    connection.once("close", () => {
      this.activeSockets.delete(connection);
      this.resolveIdle();
    });
    if (this.stopped) connection.destroy();
    return connection;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const socket of this.activeSockets) socket.destroy();
    this.destroy();
    this.resolveIdle();
  }

  async whenIdle(): Promise<void> {
    while (this.activeSockets.size > 0) {
      await new Promise<void>((resolve) => {
        this.idleWaiters.add(resolve);
      });
    }
    await immediate();
    await immediate();
  }

  private resolveIdle(): void {
    if (this.activeSockets.size > 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

export function createFeishuNodeNetworkGuard(): FeishuSdkNetworkGuard {
  return new StoppableHttpsAgent();
}

function cancellableHttpInstance(
  request: FeishuNodeSdkRuntimeDependencies["request"],
): {
  readonly httpInstance: FeishuSdkHttpInstance;
  readonly stop: () => void;
  readonly whenIdle: () => Promise<void>;
} {
  const abortController = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let stopping = false;

  const httpInstance: FeishuSdkHttpInstance = {
    request: (options) => {
      if (stopping) return Promise.resolve(CANCELLATION_RESPONSE);
      const operation = (async () => {
        try {
          const response = await request(options, abortController.signal);
          return stopping ? CANCELLATION_RESPONSE : response;
        } catch (error) {
          if (stopping) return CANCELLATION_RESPONSE;
          throw error;
        }
      })();
      pending.add(operation);
      void operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation),
      );
      return operation;
    },
  };

  return {
    httpInstance,
    stop: () => {
      if (stopping) return;
      stopping = true;
      abortController.abort();
    },
    whenIdle: async () => {
      while (pending.size > 0) {
        await Promise.all([...pending].map(
          (operation) => operation.then(() => undefined, () => undefined),
        ));
      }
    },
  };
}

const productionDependencies: FeishuNodeSdkRuntimeDependencies = {
  request: (options, signal) => lark.defaultHttpInstance.request({
    ...(options as Record<string, unknown>),
    signal,
  }),
  createNetworkGuard: createFeishuNodeNetworkGuard,
  createClient: (input) => new lark.WSClient({
    appId: input.appId,
    appSecret: input.appSecret,
    autoReconnect: input.autoReconnect,
    handshakeTimeoutMs: input.handshakeTimeoutMs,
    logger: input.logger,
    loggerLevel: input.loggerLevel as lark.LoggerLevel,
    onReady: input.onReady,
    onError: input.onError,
    onReconnecting: input.onReconnecting,
    onReconnected: input.onReconnected,
    httpInstance: input.httpInstance as lark.HttpInstance,
    agent: input.agent,
  }) as FeishuRawWsClient,
  createMessageDispatcher: (handler) => {
    const dispatcher = new lark.EventDispatcher({});
    return dispatcher.register({
      "im.message.receive_v1": handler,
    });
  },
  infoLoggerLevel: lark.LoggerLevel.info,
};

export function createFeishuNodeSdkRuntime(
  dependencies: FeishuNodeSdkRuntimeDependencies = productionDependencies,
): FeishuNodeSdkRuntime {
  return {
    createClient: ({ app_id, app_secret, callbacks }) => {
      const networkGuard = dependencies.createNetworkGuard();
      const http = cancellableHttpInstance(dependencies.request);
      const client = dependencies.createClient({
        appId: app_id,
        appSecret: app_secret,
        autoReconnect: true,
        handshakeTimeoutMs: 15_000,
        logger: createFeishuSdkLogger(console),
        loggerLevel: dependencies.infoLoggerLevel,
        onReady: callbacks.onReady,
        onError: callbacks.onError,
        onReconnecting: callbacks.onReconnecting,
        onReconnected: callbacks.onReconnected,
        httpInstance: http.httpInstance,
        agent: networkGuard.agent,
      });
      let closeStarted = false;
      let lifecycleResolve!: () => void;
      const lifecycle = new Promise<void>((resolve) => {
        lifecycleResolve = resolve;
      });

      const forceClose = () => {
        try {
          client.close({ force: true });
        } catch {
          // Best effort, without allowing SDK exception content across the seam.
        }
      };

      return {
        start: ({ eventDispatcher }) => {
          let sdkStart: Promise<void>;
          try {
            sdkStart = client.start({ eventDispatcher });
          } catch {
            sdkStart = Promise.reject(new Error("feishu_long_connection_run_failed"));
          }
          void sdkStart.then(undefined, () => {
            try {
              callbacks.onError();
            } catch {
              // Callback failures must not create a derived unhandled rejection.
            }
          });
          return lifecycle;
        },
        close: () => {
          if (closeStarted) return;
          closeStarted = true;
          http.stop();
          networkGuard.stop();
          forceClose();
          void (async () => {
            try {
              await Promise.all([http.whenIdle(), networkGuard.whenIdle()]);
            } catch {
              // Cleanup remains best effort and never exposes dependency failures.
            } finally {
              forceClose();
              lifecycleResolve();
            }
          })();
        },
        getConnectionStatus: () => client.getConnectionStatus().state,
      };
    },
    createMessageDispatcher: dependencies.createMessageDispatcher,
  };
}

export const feishuNodeSdkRuntime = createFeishuNodeSdkRuntime();
