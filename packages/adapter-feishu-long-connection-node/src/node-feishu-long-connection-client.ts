import type {
  FeishuLongConnectionClient,
  FeishuLongConnectionClientFactory,
  FeishuLongConnectionHandler,
  FeishuLongConnectionState,
  FeishuLongConnectionStatus,
  FeishuLongConnectionStatusCode,
} from "@work-fabric/connector-feishu";

import { reconstructFeishuMessageEvent } from "./event-envelope.js";
import {
  feishuNodeSdkRuntime,
  type FeishuNodeSdkRuntime,
  type FeishuNodeWsClient,
} from "./sdk-runtime.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
const FEISHU_APP_ID_PATTERN = /^cli_[0-9a-fA-F]{16}$/;

export interface NodeFeishuLongConnectionClientFactoryOptions {
  readonly clock?: { now(): string };
  readonly drain_timeout_ms?: number;
  readonly run_settle_timeout_ms?: number;
  readonly sdk?: FeishuNodeSdkRuntime;
}

interface ResolvedOptions {
  readonly clock: { now(): string };
  readonly drain_timeout_ms: number;
  readonly run_settle_timeout_ms: number;
  readonly sdk: FeishuNodeSdkRuntime;
}

function validTimeout(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value <= 0
    || value > MAX_TIMEOUT_MS
  ) {
    throw new TypeError("feishu_long_connection_timeout_invalid");
  }
  return value;
}

function waitWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    void promise.then(finish, finish);
  });
}

class NodeFeishuLongConnectionClient implements FeishuLongConnectionClient {
  private accepting = false;
  private activeHandlers = 0;
  private readonly drainWaiters = new Set<() => void>();
  private started = false;
  private stopping = false;
  private stopped = false;
  private sdkClient: FeishuNodeWsClient | undefined;
  private runPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private currentStatus: FeishuLongConnectionStatus;

  constructor(
    private readonly input: {
      readonly app_id: string;
      readonly app_secret: string;
      readonly instance_id: string;
    },
    private readonly options: ResolvedOptions,
  ) {
    this.currentStatus = {
      state: "idle",
      code: "idle",
      reconnect_attempts: 0,
      changed_at: options.clock.now(),
    };
  }

  async start(handler: FeishuLongConnectionHandler): Promise<void> {
    if (this.started || this.stopping || this.stopped) return;
    this.started = true;
    if (
      !FEISHU_APP_ID_PATTERN.test(this.input.app_id)
      || this.input.app_secret.length === 0
    ) {
      this.transition("failed", "connection_failed");
      return;
    }
    this.accepting = true;
    this.transition("connecting", "connecting");

    try {
      const sdkClient = this.options.sdk.createClient({
        app_id: this.input.app_id,
        app_secret: this.input.app_secret,
        callbacks: {
          onReady: () => {
            if (!this.stopping && !this.stopped) {
              this.transition("connected", "connected");
            }
          },
          onError: () => {
            if (!this.stopped) this.transition("failed", "connection_failed");
          },
          onReconnecting: () => {
            if (this.stopping || this.stopped) return;
            this.transition(
              "reconnecting",
              "reconnecting",
              this.currentStatus.reconnect_attempts + 1,
            );
          },
          onReconnected: () => {
            if (!this.stopping && !this.stopped) {
              this.transition("connected", "connected");
            }
          },
        },
      });
      this.sdkClient = sdkClient;
      const dispatcher = this.options.sdk.createMessageDispatcher(
        (data) => this.handleMessage(data, handler),
      );

      let launched: Promise<void>;
      try {
        launched = sdkClient.start({ eventDispatcher: dispatcher });
      } catch {
        launched = Promise.reject(new Error("feishu_long_connection_run_failed"));
      }
      this.runPromise = launched.catch(() => {
        if (!this.stopped) this.transition("failed", "connection_failed");
      });
    } catch {
      this.accepting = false;
      this.transition("failed", "connection_failed");
    }
  }

  status(): FeishuLongConnectionStatus {
    return Object.freeze({ ...this.currentStatus });
  }

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise;
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private async handleMessage(
    data: unknown,
    handler: FeishuLongConnectionHandler,
  ): Promise<unknown> {
    if (!this.accepting) {
      throw new Error("feishu_long_connection_stopping");
    }
    this.activeHandlers += 1;
    try {
      return await handler(reconstructFeishuMessageEvent(data));
    } finally {
      this.activeHandlers -= 1;
      if (this.activeHandlers === 0) {
        for (const waiter of this.drainWaiters) waiter();
        this.drainWaiters.clear();
      }
    }
  }

  private async stopInternal(): Promise<void> {
    this.accepting = false;
    this.stopping = true;

    if (this.activeHandlers > 0) {
      let resolveDrain!: () => void;
      const drained = new Promise<void>((resolve) => {
        resolveDrain = resolve;
      });
      this.drainWaiters.add(resolveDrain);
      await waitWithin(drained, this.options.drain_timeout_ms);
      this.drainWaiters.delete(resolveDrain);
    }

    try {
      this.sdkClient?.close();
    } catch {
      // Closing is best effort; SDK exception content must not cross the boundary.
    }

    if (this.runPromise !== undefined) {
      await waitWithin(this.runPromise, this.options.run_settle_timeout_ms);
    }

    this.stopped = true;
    this.stopping = false;
    this.transition("stopped", "stopped");
  }

  private transition(
    state: FeishuLongConnectionState,
    code: FeishuLongConnectionStatusCode,
    reconnectAttempts = this.currentStatus.reconnect_attempts,
  ): void {
    const changed = state !== this.currentStatus.state || code !== this.currentStatus.code;
    this.currentStatus = {
      state,
      code,
      reconnect_attempts: reconnectAttempts,
      changed_at: changed ? this.options.clock.now() : this.currentStatus.changed_at,
    };
  }
}

export class NodeFeishuLongConnectionClientFactory
implements FeishuLongConnectionClientFactory {
  private readonly options: ResolvedOptions;

  constructor(options: NodeFeishuLongConnectionClientFactoryOptions = {}) {
    this.options = {
      clock: options.clock ?? { now: () => new Date().toISOString() },
      drain_timeout_ms: validTimeout(options.drain_timeout_ms ?? DEFAULT_TIMEOUT_MS),
      run_settle_timeout_ms: validTimeout(
        options.run_settle_timeout_ms ?? DEFAULT_TIMEOUT_MS,
      ),
      sdk: options.sdk ?? feishuNodeSdkRuntime,
    };
  }

  create(input: {
    readonly app_id: string;
    readonly app_secret: string;
    readonly instance_id: string;
  }): FeishuLongConnectionClient {
    return new NodeFeishuLongConnectionClient(input, this.options);
  }
}
