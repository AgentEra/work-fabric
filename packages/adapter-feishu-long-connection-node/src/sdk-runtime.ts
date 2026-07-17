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

export const feishuNodeSdkRuntime: FeishuNodeSdkRuntime = {
  createClient: ({ app_id, app_secret, callbacks }) => {
    const client = new lark.WSClient({
      appId: app_id,
      appSecret: app_secret,
      autoReconnect: true,
      handshakeTimeoutMs: 15_000,
      logger: createFeishuSdkLogger(console),
      loggerLevel: lark.LoggerLevel.info,
      onReady: callbacks.onReady,
      onError: callbacks.onError,
      onReconnecting: callbacks.onReconnecting,
      onReconnected: callbacks.onReconnected,
    });
    return {
      start: ({ eventDispatcher }) => client.start({
        eventDispatcher: eventDispatcher as lark.EventDispatcher,
      }),
      close: () => client.close(),
      getConnectionStatus: () => client.getConnectionStatus().state,
    };
  },
  createMessageDispatcher: (handler) => {
    const dispatcher = new lark.EventDispatcher({});
    return dispatcher.register({
      "im.message.receive_v1": handler,
    });
  },
};
