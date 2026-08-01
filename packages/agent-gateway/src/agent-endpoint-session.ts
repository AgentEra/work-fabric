import {
  WorkFabricHttpError,
  WorkFabricTransportError,
  type AckResult,
  type EndpointClient,
  type EndpointClaimableHandoffPage,
  type EndpointHeartbeatInput,
  type EndpointInboxPartitionInput,
  type EndpointSession,
  type EventDelivery,
  type HandoffClient,
  type HandoffReadModel,
  type QueryClient,
  type RequestOptions,
  type SubscriptionClient,
  type SubscriptionDocument,
} from "@work-fabric/sdk-typescript";

import {
  normalizeAgentGatewayConfig,
  type AgentGatewayConfig,
  type NormalizedAgentGatewayConfig,
} from "./config.js";
import { AgentGatewayError } from "./errors.js";
import { BoundedAsyncQueue } from "./bounded-async-queue.js";
import { PartitionMultiplexer } from "./partition-multiplexer.js";

export interface AgentGatewayClient {
  readonly endpoints: Pick<
    EndpointClient,
    | "openSession"
    | "heartbeat"
    | "closeSession"
    | "listInboxPartitions"
    | "listClaimableHandoffs"
  >;
  readonly subscriptions: Pick<
    SubscriptionClient,
    "get" | "put" | "acknowledgeDelivery" | "stream"
  >;
  readonly queries: Pick<QueryClient, "getHandoff" | "listHandoffEvents">;
  readonly handoffs: HandoffClient;
}

export interface IncomingHandoff {
  readonly partition_id: string;
  readonly delivery: EventDelivery;
  readonly handoff: HandoffReadModel;
  acknowledgeSignal(
    outcome: "acknowledged" | "retry" | "rejected",
    options?: RequestOptions,
  ): Promise<AckResult>;
}

export interface AgentEndpointSession {
  readonly session_id: string;
  readonly handoffs: HandoffClient;
  readonly closed: Promise<{
    readonly reason: "closed" | "aborted" | "fenced" | "failed";
  }>;
  incoming(): AsyncIterable<IncomingHandoff>;
  close(options?: { readonly signal?: AbortSignal }): Promise<void>;
}

export interface ClaimCapableAgentEndpointSession extends AgentEndpointSession {
  claimableHandoffs(
    input?: EndpointInboxPartitionInput,
    options?: RequestOptions,
  ): Promise<EndpointClaimableHandoffPage>;
}

export interface AgentGatewayStartOptions {
  readonly signal?: AbortSignal;
}

export interface AgentGatewayInternals {
  readonly now?: () => string;
  readonly sleep?: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
}

function defaultSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(complete, milliseconds);
    function complete() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function sameSubscription(
  existing: SubscriptionDocument,
  expected: SubscriptionDocument,
): boolean {
  return (
    existing.subscription_id === expected.subscription_id &&
    existing.owner.actor_id === expected.owner.actor_id &&
    existing.owner.actor_type === expected.owner.actor_type &&
    existing.endpoint_id === expected.endpoint_id &&
    existing.delivery.mode === "sse" &&
    existing.state === "active" &&
    JSON.stringify(existing.filter) === JSON.stringify(expected.filter)
  );
}

function replayable(error: unknown): boolean {
  return error instanceof WorkFabricTransportError &&
    (error.code === "network_error" || error.code === "timeout");
}

function fenced(error: unknown): boolean {
  return error instanceof WorkFabricHttpError &&
    error.status === 409 &&
    ["session_fenced", "stale_sequence"].includes(error.code);
}

class AgentEndpointSessionImpl implements ClaimCapableAgentEndpointSession {
  readonly session_id: string;
  readonly handoffs: HandoffClient;
  readonly closed: Promise<{
    readonly reason: "closed" | "aborted" | "fenced" | "failed";
  }>;
  private readonly queue: BoundedAsyncQueue<IncomingHandoff>;
  private readonly renewalController = new AbortController();
  private readonly multiplexer: PartitionMultiplexer;
  private current: EndpointSession;
  private finishPromise: Promise<void> | null = null;
  private resolveClosed!: (value: {
    readonly reason: "closed" | "aborted" | "fenced" | "failed";
  }) => void;

  constructor(
    private readonly client: AgentGatewayClient,
    private readonly config: NormalizedAgentGatewayConfig,
    session: EndpointSession,
    private readonly now: () => string,
    private readonly sleep: (
      milliseconds: number,
      signal: AbortSignal,
    ) => Promise<void>,
    externalSignal?: AbortSignal,
  ) {
    this.current = session;
    this.session_id = session.session_id;
    this.handoffs = client.handoffs;
    this.queue = new BoundedAsyncQueue(config.incoming_queue_capacity);
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.multiplexer = new PartitionMultiplexer({
      client,
      endpointId: config.endpoint_id,
      subscriptionId: config.subscription.subscription_id,
      refreshMs: config.inbox_refresh_ms,
      maxPartitions: config.max_active_partitions,
      queue: this.queue,
      sleep,
      incoming: (partitionId, delivery, handoff, deliveryAcknowledged, terminalAcknowledged) => ({
        partition_id: partitionId,
        delivery,
        handoff,
        acknowledgeSignal: async (outcome, options = {}) => {
          const acknowledgement = await this.client.subscriptions.acknowledgeDelivery(
            delivery,
            outcome,
            options,
          );
          if (
            acknowledgement.kind === "acknowledged" ||
            acknowledgement.kind === "rejected"
          ) {
            deliveryAcknowledged?.(acknowledgement.cursor);
            terminalAcknowledged?.();
          }
          return acknowledgement;
        },
      }),
      failed: (error) => { void this.fail("failed", error); },
    });
    if (externalSignal !== undefined) {
      if (externalSignal.aborted) void this.fail("aborted");
      else externalSignal.addEventListener(
        "abort",
        () => { void this.fail("aborted"); },
        { once: true },
      );
    }
  }

  start(): void {
    if (this.finishPromise !== null) return;
    this.multiplexer.start();
    void this.renew();
  }

  incoming(): AsyncIterable<IncomingHandoff> {
    return this.queue;
  }

  claimableHandoffs(
    input: EndpointInboxPartitionInput = {},
    options: RequestOptions = {},
  ): Promise<EndpointClaimableHandoffPage> {
    return this.client.endpoints.listClaimableHandoffs(
      this.config.endpoint_id,
      input,
      options,
    );
  }

  async close(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    if (this.finishPromise !== null) return this.finishPromise;
    this.finishPromise = this.gracefulClose(options.signal);
    return this.finishPromise;
  }

  private async gracefulClose(signal?: AbortSignal): Promise<void> {
    this.renewalController.abort();
    await this.multiplexer.stop();
    const timeout = AbortSignal.timeout(this.config.graceful_close_timeout_ms);
    const closeSignal = signal === undefined
      ? timeout
      : AbortSignal.any([signal, timeout]);
    try {
      const draining = await this.replayWrite(
        () => this.client.endpoints.heartbeat(
          this.config.endpoint_id,
          this.current.session_id,
          {
            fencing_token: this.current.fencing_token,
            heartbeat_sequence: this.current.heartbeat_sequence + 1,
            availability: "draining",
            capabilities: this.current.capabilities,
            expected_registration_version: this.current.registration_version,
          },
          { signal: closeSignal },
        ),
        closeSignal,
      );
      this.current = draining;
      await this.replayWrite(
        () => this.client.endpoints.closeSession(
          this.config.endpoint_id,
          this.current.session_id,
          {
            fencing_token: this.current.fencing_token,
            heartbeat_sequence: this.current.heartbeat_sequence + 1,
            expected_registration_version: this.current.registration_version,
          },
          { signal: closeSignal },
        ),
        closeSignal,
      );
      this.queue.close();
      this.resolveClosed({ reason: "closed" });
    } catch (error) {
      this.queue.close();
      this.resolveClosed({ reason: fenced(error) ? "fenced" : "failed" });
    }
  }

  private async renew(): Promise<void> {
    while (!this.renewalController.signal.aborted) {
      const wait = Math.max(
        0,
        Date.parse(this.current.renew_after) - Date.parse(this.now()),
      );
      try {
        await this.sleep(wait, this.renewalController.signal);
        if (this.renewalController.signal.aborted) return;
        const input: EndpointHeartbeatInput = {
          fencing_token: this.current.fencing_token,
          heartbeat_sequence: this.current.heartbeat_sequence + 1,
          availability: this.current.availability,
          capabilities: this.current.capabilities,
          expected_registration_version: this.current.registration_version,
        };
        this.current = await this.replayWrite(
          () => this.client.endpoints.heartbeat(
            this.config.endpoint_id,
            this.current.session_id,
            input,
            { signal: this.renewalController.signal },
          ),
          this.renewalController.signal,
        );
      } catch (error) {
        if (this.renewalController.signal.aborted) return;
        await this.fail(fenced(error) ? "fenced" : "failed", error);
        return;
      }
    }
  }

  private async replayWrite<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (
          !replayable(error) ||
          attempt >= this.config.heartbeat_retry_count ||
          signal.aborted
        ) {
          throw error;
        }
        attempt += 1;
        await this.sleep(
          this.config.heartbeat_backoff_ms * attempt,
          signal,
        );
      }
    }
  }

  private async fail(
    reason: "aborted" | "fenced" | "failed",
    error?: unknown,
  ): Promise<void> {
    if (this.finishPromise !== null) return this.finishPromise;
    this.finishPromise = (async () => {
      this.renewalController.abort();
      await this.multiplexer.stop();
      this.queue.close(error);
      this.resolveClosed({ reason });
    })();
    return this.finishPromise;
  }
}

export class AgentGateway {
  private readonly config: NormalizedAgentGatewayConfig;
  private readonly now: () => string;
  private readonly sleep: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
  private started = false;

  constructor(
    private readonly client: AgentGatewayClient,
    config: AgentGatewayConfig,
    internals: AgentGatewayInternals = {},
  ) {
    this.config = normalizeAgentGatewayConfig(config);
    this.now = internals.now ?? (() => new Date().toISOString());
    this.sleep = internals.sleep ?? defaultSleep;
  }

  async start(
    options: AgentGatewayStartOptions = {},
  ): Promise<ClaimCapableAgentEndpointSession> {
    if (this.started) {
      throw new AgentGatewayError(
        "invalid_config",
        "AgentGateway can start only one Endpoint session",
      );
    }
    this.started = true;
    await this.ensureSubscription(options.signal);
    const signal = options.signal ?? new AbortController().signal;
    const session = await this.replayOpen(signal);
    const result = new AgentEndpointSessionImpl(
      this.client,
      this.config,
      session,
      this.now,
      this.sleep,
      options.signal,
    );
    result.start();
    return result;
  }

  private async ensureSubscription(signal?: AbortSignal): Promise<void> {
    let existing: SubscriptionDocument;
    try {
      existing = await this.client.subscriptions.get(
        this.config.subscription.subscription_id,
        { ...(signal === undefined ? {} : { signal }) },
      );
    } catch (error) {
      if (!(error instanceof WorkFabricHttpError) || error.status !== 404) {
        throw error;
      }
      await this.client.subscriptions.put(
        this.config.subscription,
        { ...(signal === undefined ? {} : { signal }) },
      );
      return;
    }
    if (!sameSubscription(existing, this.config.subscription)) {
      throw new AgentGatewayError(
        "subscription_mismatch",
        "Existing Subscription ownership, Endpoint, mode, state, or filter does not match",
      );
    }
  }

  private async replayOpen(signal: AbortSignal): Promise<EndpointSession> {
    let attempt = 0;
    while (true) {
      try {
        return await this.client.endpoints.openSession(
          this.config.endpoint_id,
          this.config.open_session,
          { signal },
        );
      } catch (error) {
        if (
          !replayable(error) ||
          attempt >= this.config.heartbeat_retry_count ||
          signal.aborted
        ) {
          throw error;
        }
        attempt += 1;
        await this.sleep(
          this.config.heartbeat_backoff_ms * attempt,
          signal,
        );
      }
    }
  }
}
