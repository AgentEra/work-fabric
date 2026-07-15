import type {
  NormalizedClientOptions,
  RepresentationContext,
} from "./config.js";
import type { RequestOptions } from "./query-client.js";
import { decodeObject, identifier, positive } from "./query-client.js";
import { decodeEventDelivery } from "./sse-parser.js";
import { SseDeliveryParser } from "./sse-parser.js";
import { WorkFabricHttpError, WorkFabricTransportError } from "./errors.js";
import type {
  AckResult,
  DeliveryAck,
  EventDelivery,
  JsonObject,
  PullResult,
  SubscriptionDocument,
} from "./protocol-types.js";
import type { SdkTransport } from "./transport.js";

export interface PullInput {
  readonly partitionId: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface AcknowledgeDeliveryOptions extends RequestOptions {
  readonly details?: JsonObject;
  readonly extensions?: JsonObject;
}

export interface StreamInput {
  readonly partitionId: string;
  readonly cursor?: string | null;
}

function transportOptions(representation: RepresentationContext, options: RequestOptions) {
  return {
    representation: options.representation ?? representation,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function cursor(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (value.length === 0 || value.length > 2048) throw new TypeError("cursor is invalid");
  return value;
}

function decodeSubscription(value: unknown): SubscriptionDocument {
  const document = decodeObject<SubscriptionDocument>(value);
  identifier(document.subscription_id, "subscription_id");
  return document;
}

function decodePull(value: unknown): PullResult {
  const result = decodeObject<Record<string, unknown>>(value);
  if (result.kind === "idle" && typeof result.cursor === "string") {
    return result as unknown as PullResult;
  }
  if (result.kind === "delivery") {
    return { kind: "delivery", delivery: decodeEventDelivery(result.delivery) };
  }
  throw new TypeError("PullResult is invalid");
}

function decodeAck(value: unknown): AckResult {
  const result = decodeObject<Record<string, unknown>>(value);
  if (
    (result.kind === "acknowledged" || result.kind === "retry" || result.kind === "rejected") &&
    typeof result.cursor === "string"
  ) {
    return result as unknown as AckResult;
  }
  throw new TypeError("AckResult is invalid");
}

export class SubscriptionClient {
  constructor(
    private readonly config: NormalizedClientOptions,
    private readonly transport: SdkTransport,
    private readonly representation: RepresentationContext,
  ) {}

  get(subscriptionId: string, options: RequestOptions = {}): Promise<SubscriptionDocument> {
    return this.transport.request({ method: "GET", path: ["v1", "subscriptions", identifier(subscriptionId, "subscriptionId")], retry: "query", ...transportOptions(this.representation, options), decode: decodeSubscription });
  }

  put(subscription: SubscriptionDocument, options: RequestOptions = {}): Promise<SubscriptionDocument> {
    const id = identifier(subscription.subscription_id, "subscription_id");
    return this.transport.request({ method: "PUT", path: ["v1", "subscriptions", id], body: subscription, retry: "none", ...transportOptions(this.representation, options), decode: decodeSubscription });
  }

  pull(subscriptionId: string, input: PullInput, options: RequestOptions = {}): Promise<PullResult> {
    const limit = positive(input.limit, "limit");
    return this.transport.request({
      method: "POST",
      path: ["v1", "subscriptions", identifier(subscriptionId, "subscriptionId"), "pull"],
      body: { partition_id: identifier(input.partitionId, "partitionId"), cursor: cursor(input.cursor), ...(limit === undefined ? {} : { limit }) },
      retry: "none",
      ...transportOptions(this.representation, options),
      decode: decodePull,
    });
  }

  acknowledge(ack: DeliveryAck, options: RequestOptions = {}): Promise<AckResult> {
    identifier(ack.delivery_id, "delivery_id");
    const subscriptionId = identifier(ack.subscription_id, "subscription_id");
    return this.transport.request({ method: "POST", path: ["v1", "subscriptions", subscriptionId, "ack"], body: ack, retry: "none", ...transportOptions(this.representation, options), decode: decodeAck });
  }

  acknowledgeDelivery(
    delivery: EventDelivery,
    outcome: DeliveryAck["outcome"],
    options: AcknowledgeDeliveryOptions = {},
  ): Promise<AckResult> {
    const last = delivery.events.at(-1);
    if (last === undefined || typeof last.id !== "string") {
      throw new TypeError("delivery must contain at least one Event");
    }
    const ack: DeliveryAck = {
      delivery_id: delivery.delivery_id,
      subscription_id: delivery.subscription_id,
      outcome,
      acknowledged_at: this.config.clock.now(),
      last_event_id: last.id,
      cursor: delivery.next_cursor,
      ...(options.details === undefined ? {} : { details: options.details }),
      ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
    };
    return this.acknowledge(ack, options);
  }

  async *stream(
    subscriptionId: string,
    input: StreamInput,
    options: RequestOptions = {},
  ): AsyncIterable<EventDelivery> {
    const id = identifier(subscriptionId, "subscriptionId");
    const partitionId = identifier(input.partitionId, "partitionId");
    let resumeCursor = cursor(input.cursor);
    let reconnects = 0;
    const signal = options.signal;

    while (!signal?.aborted) {
      let opened: Awaited<ReturnType<SdkTransport["openStream"]>>;
      try {
        opened = await this.transport.openStream({
          path: ["v1", "subscriptions", id, "events"],
          query: { partition_id: partitionId },
          ...(resumeCursor === null
            ? {}
            : { headers: { "last-event-id": resumeCursor } }),
          ...transportOptions(this.representation, options),
        });
      } catch (error) {
        if (signal?.aborted || (error instanceof WorkFabricTransportError && error.code === "aborted")) {
          return;
        }
        if (!this.reconnectable(error)) throw error;
        if (reconnects >= this.config.streamReconnect.maxReconnects) {
          throw this.reconnectExhausted();
        }
        if (!(await this.backoff(reconnects, signal))) return;
        reconnects += 1;
        continue;
      }

      const reader = opened.body.getReader();
      let reconnect = true;
      try {
        const parser = new SseDeliveryParser(this.config.streamReconnect.maxFrameBytes);
        while (!signal?.aborted) {
          const item = await reader.read();
          const frames = item.done ? parser.finish() : parser.push(item.value);
          for (const frame of frames) {
            resumeCursor = frame.id;
            reconnects = 0;
            yield frame.data;
          }
          if (item.done) break;
        }
      } catch (error) {
        if (signal?.aborted || opened.signal.aborted) return;
        if (
          error instanceof WorkFabricTransportError &&
          error.code === "stream_protocol_error"
        ) {
          reconnect = false;
          throw error;
        }
      } finally {
        try { await reader.cancel(); } catch { /* transport close is authoritative */ }
        opened.close();
      }

      if (!reconnect || signal?.aborted) return;
      if (reconnects >= this.config.streamReconnect.maxReconnects) {
        throw this.reconnectExhausted();
      }
      if (!(await this.backoff(reconnects, signal))) return;
      reconnects += 1;
    }
  }

  private reconnectable(error: unknown): boolean {
    if (error instanceof WorkFabricHttpError) {
      return error.status === 429 || error.status === 503;
    }
    return error instanceof WorkFabricTransportError &&
      (error.code === "network_error" || error.code === "timeout");
  }

  private async backoff(index: number, signal: AbortSignal | undefined): Promise<boolean> {
    try {
      await this.transport.waitBeforeReconnect(index, signal);
      return !signal?.aborted;
    } catch {
      if (signal?.aborted) return false;
      throw new WorkFabricTransportError(
        "stream_reconnect_exhausted",
        "The Work Fabric event stream could not reconnect",
      );
    }
  }

  private reconnectExhausted(): WorkFabricTransportError {
    return new WorkFabricTransportError(
      "stream_reconnect_exhausted",
      "The Work Fabric event stream exhausted its reconnect limit",
    );
  }
}
