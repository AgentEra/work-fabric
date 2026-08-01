import {
  normalizeRepresentationContext,
  type RepresentationContext,
} from "./config.js";
import type {
  HandoffReadModel,
  JsonObject,
  ProtocolEvent,
} from "./protocol-types.js";
import type { SdkTransport } from "./transport.js";

export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly representation?: RepresentationContext;
}

export interface HandoffEventQuery extends RequestOptions {
  readonly fromVersion?: number;
  readonly limit?: number;
}

export interface PartitionHandoffQuery extends RequestOptions {
  readonly limit?: number;
}

export interface PartitionEventQuery extends RequestOptions {
  readonly afterPosition?: number;
  readonly limit?: number;
}

export interface ContextReferenceInput {
  readonly contextId: string;
  readonly version: number;
  readonly digest: string | null;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("response must be an object");
  }
  return value as Record<string, unknown>;
}

export function decodeObject<T>(value: unknown): T {
  return object(value) as T;
}

export function decodeObjectArrayProperty<T>(
  value: unknown,
  property: string,
): readonly T[] {
  const candidate = object(value)[property];
  if (!Array.isArray(candidate) || candidate.some((item) => {
    try { object(item); return false; } catch { return true; }
  })) {
    throw new TypeError(`${property} must be an object array`);
  }
  return candidate as readonly T[];
}

export function identifier(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || value.trim() !== value) {
    throw new TypeError(`${field} must be a bounded non-empty string`);
  }
  return value;
}

export function positive(value: number | undefined, field: string): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

export function nonNegative(value: number | undefined, field: string): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function requestOptions(
  defaultRepresentation: RepresentationContext,
  options: RequestOptions,
) {
  return {
    representation: options.representation === undefined
      ? defaultRepresentation
      : normalizeRepresentationContext(options.representation),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function contextDigest(value: string | null): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    !/^(?:sha-256|sha-384|sha-512):[^\s:][^\s]*$/.test(value)
  ) {
    throw new TypeError("digest must be a bounded canonical digest");
  }
  return value;
}

export class QueryClient {
  constructor(
    private readonly transport: SdkTransport,
    private readonly representation: RepresentationContext,
  ) {}

  getHandoff(handoffId: string, options: RequestOptions = {}): Promise<HandoffReadModel> {
    return this.transport.request({
      method: "GET",
      path: ["v1", "handoffs", identifier(handoffId, "handoffId")],
      retry: "query",
      ...requestOptions(this.representation, options),
      decode: decodeObject<HandoffReadModel>,
    });
  }

  getContextBundle(
    reference: ContextReferenceInput,
    options: RequestOptions = {},
  ): Promise<JsonObject> {
    const version = positive(reference.version, "version");
    if (version === undefined) throw new TypeError("version is required");
    const digest = contextDigest(reference.digest);
    return this.transport.request({
      method: "GET",
      path: [
        "v1",
        "contexts",
        identifier(reference.contextId, "contextId"),
        "versions",
        String(version),
      ],
      query: digest === null ? {} : { digest },
      retry: "query",
      ...requestOptions(this.representation, options),
      decode: decodeObject<JsonObject>,
    });
  }

  listHandoffEvents(
    handoffId: string,
    options: HandoffEventQuery = {},
  ): Promise<readonly ProtocolEvent[]> {
    const fromVersion = positive(options.fromVersion, "fromVersion");
    const limit = positive(options.limit, "limit");
    return this.transport.request({
      method: "GET",
      path: ["v1", "handoffs", identifier(handoffId, "handoffId"), "events"],
      query: {
        ...(fromVersion === undefined ? {} : { from_version: fromVersion }),
        ...(limit === undefined ? {} : { limit }),
      },
      retry: "query",
      ...requestOptions(this.representation, options),
      decode: (value) => decodeObjectArrayProperty<ProtocolEvent>(value, "events"),
    });
  }

  listPartitionHandoffs(
    partitionId: string,
    options: PartitionHandoffQuery = {},
  ): Promise<readonly HandoffReadModel[]> {
    const limit = positive(options.limit, "limit");
    return this.transport.request({
      method: "GET",
      path: ["v1", "partitions", identifier(partitionId, "partitionId"), "handoffs"],
      query: limit === undefined ? {} : { limit },
      retry: "query",
      ...requestOptions(this.representation, options),
      decode: (value) => decodeObjectArrayProperty<HandoffReadModel>(value, "handoffs"),
    });
  }

  listPartitionEvents(
    partitionId: string,
    options: PartitionEventQuery = {},
  ): Promise<readonly ProtocolEvent[]> {
    const afterPosition = nonNegative(options.afterPosition, "afterPosition");
    const limit = positive(options.limit, "limit");
    return this.transport.request({
      method: "GET",
      path: ["v1", "partitions", identifier(partitionId, "partitionId"), "events"],
      query: {
        ...(afterPosition === undefined ? {} : { after_position: afterPosition }),
        ...(limit === undefined ? {} : { limit }),
      },
      retry: "query",
      ...requestOptions(this.representation, options),
      decode: (value) => decodeObjectArrayProperty<ProtocolEvent>(value, "events"),
    });
  }
}
