import type {
  NormalizedClientOptions,
  RepresentationContext,
} from "./config.js";
import type { RequestOptions } from "./query-client.js";
import { decodeObject, identifier, positive } from "./query-client.js";
import { decodeEventDelivery } from "./sse-parser.js";
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
}
