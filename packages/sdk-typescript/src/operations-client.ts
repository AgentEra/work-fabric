import type { RepresentationContext } from "./config.js";
import {
  decodeObject,
  decodeObjectArrayProperty,
  identifier,
  positive,
  type RequestOptions,
} from "./query-client.js";
import type {
  DeliveryAttempt,
  ProjectionFailureRecord,
  RuntimeSubscription,
} from "./protocol-types.js";
import type { SdkTransport } from "./transport.js";

export interface PageOptions extends RequestOptions { readonly limit?: number }
export interface ProjectionFailureQuery extends PageOptions { readonly projectorId: string; readonly partitionId: string }
export interface DeliveryAttemptQuery extends PageOptions { readonly subscriptionId: string; readonly eventId: string }
export interface DeliveryPositionQuery extends RequestOptions { readonly subscriptionId: string; readonly partitionId: string }
export interface DependencyHealth { readonly dependency_id: string; readonly status: "healthy" | "unhealthy"; readonly observed_at: string; readonly latency_ms: number }
export interface HealthReport { readonly status: "ready" | "not_ready"; readonly dependencies: readonly DependencyHealth[] }
export interface LivenessReport { readonly status: "live" }
export interface ReadinessReport { readonly status: "ready" | "not_ready" }

function requestOptions(representation: RepresentationContext, options: RequestOptions) {
  return {
    representation: options.representation ?? representation,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

export class OperationsClient {
  constructor(private readonly transport: SdkTransport, private readonly representation: RepresentationContext) {}

  listSubscriptions(options: PageOptions = {}): Promise<readonly RuntimeSubscription[]> {
    const limit = positive(options.limit, "limit");
    return this.transport.request({ method: "GET", path: ["v1", "admin", "subscriptions"], query: limit === undefined ? {} : { limit }, retry: "query", ...requestOptions(this.representation, options), decode: (value) => decodeObjectArrayProperty<RuntimeSubscription>(value, "subscriptions") });
  }

  listProjectionFailures(input: ProjectionFailureQuery): Promise<readonly ProjectionFailureRecord[]> {
    const limit = positive(input.limit, "limit");
    return this.transport.request({ method: "GET", path: ["v1", "admin", "projection-failures"], query: { projector_id: identifier(input.projectorId, "projectorId"), partition_id: identifier(input.partitionId, "partitionId"), ...(limit === undefined ? {} : { limit }) }, retry: "query", ...requestOptions(this.representation, input), decode: (value) => decodeObjectArrayProperty<ProjectionFailureRecord>(value, "failures") });
  }

  listDeliveryAttempts(input: DeliveryAttemptQuery): Promise<readonly DeliveryAttempt[]> {
    const limit = positive(input.limit, "limit");
    return this.transport.request({ method: "GET", path: ["v1", "admin", "delivery-attempts"], query: { subscription_id: identifier(input.subscriptionId, "subscriptionId"), event_id: identifier(input.eventId, "eventId"), ...(limit === undefined ? {} : { limit }) }, retry: "query", ...requestOptions(this.representation, input), decode: (value) => decodeObjectArrayProperty<DeliveryAttempt>(value, "attempts") });
  }

  getDeliveryPosition(input: DeliveryPositionQuery): Promise<number> {
    return this.transport.request({ method: "GET", path: ["v1", "admin", "delivery-position"], query: { subscription_id: identifier(input.subscriptionId, "subscriptionId"), partition_id: identifier(input.partitionId, "partitionId") }, retry: "query", ...requestOptions(this.representation, input), decode(value) { const position = decodeObject<{ position: unknown }>(value).position; if (!Number.isSafeInteger(position) || (position as number) < 0) throw new TypeError("invalid position"); return position as number; } });
  }

  getHealth(options: RequestOptions = {}): Promise<HealthReport> {
    return this.transport.request({ method: "GET", path: ["v1", "admin", "health"], retry: "none", ...requestOptions(this.representation, options), decode: decodeObject<HealthReport>, decodeError: decodeObject<HealthReport> });
  }

  getLiveness(options: Omit<RequestOptions, "representation"> = {}): Promise<LivenessReport> {
    return this.transport.request({ method: "GET", path: ["health", "live"], retry: "query", representation: null, ...(options.signal === undefined ? {} : { signal: options.signal }), decode: decodeObject<LivenessReport> });
  }

  getReadiness(options: Omit<RequestOptions, "representation"> = {}): Promise<ReadinessReport> {
    return this.transport.request({ method: "GET", path: ["health", "ready"], retry: "none", representation: null, ...(options.signal === undefined ? {} : { signal: options.signal }), decode: decodeObject<ReadinessReport>, decodeError: decodeObject<ReadinessReport> });
  }
}
