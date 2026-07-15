import type { AuthenticationProvider } from "./authentication.js";

export interface RepresentationContext {
  readonly actorId: string;
  readonly endpointId: string;
  readonly delegationId?: string;
}

export interface QueryRetryPolicy {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxRetryAfterMs: number;
}

export interface StreamReconnectPolicy {
  readonly maxReconnects: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxFrameBytes: number;
}

export interface SdkClock {
  now(): string;
}

export interface MessageIdGenerator {
  nextMessageId(): string;
}

export interface WorkFabricClientOptions {
  readonly baseUrl: string;
  readonly authentication: AuthenticationProvider;
  readonly representation: RepresentationContext;
  readonly tenantId: string;
  readonly exchangeId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: SdkClock;
  readonly messageIdGenerator?: MessageIdGenerator;
  readonly requestTimeoutMs?: number;
  readonly queryRetry?: Partial<QueryRetryPolicy>;
  readonly streamReconnect?: Partial<StreamReconnectPolicy>;
}

export interface NormalizedClientOptions {
  readonly baseUrl: URL;
  readonly authentication: AuthenticationProvider;
  readonly representation: Readonly<RepresentationContext>;
  readonly tenantId: string;
  readonly exchangeId: string;
  readonly fetch: typeof globalThis.fetch;
  readonly clock: SdkClock;
  readonly messageIdGenerator: MessageIdGenerator;
  readonly requestTimeoutMs: number;
  readonly queryRetry: Readonly<QueryRetryPolicy>;
  readonly streamReconnect: Readonly<StreamReconnectPolicy>;
}

const queryDefaults: QueryRetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
  maxRetryAfterMs: 5_000,
};

const reconnectDefaults: StreamReconnectPolicy = {
  maxReconnects: 5,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  maxFrameBytes: 1_048_576,
};

function identity(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value
  ) {
    throw new TypeError(`${field} must be a bounded non-empty string`);
  }
  return value;
}

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function nonNegative(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function baseUrl(input: string): URL {
  let value: URL;
  try {
    value = new URL(input);
  } catch {
    throw new TypeError("baseUrl must be an absolute URL");
  }
  if (
    (value.protocol !== "http:" && value.protocol !== "https:") ||
    value.username !== "" ||
    value.password !== "" ||
    value.search !== "" ||
    value.hash !== ""
  ) {
    throw new TypeError("baseUrl is unsafe");
  }
  value.pathname = value.pathname.endsWith("/")
    ? value.pathname
    : `${value.pathname}/`;
  return value;
}

const defaultClock: SdkClock = {
  now: () => new Date().toISOString(),
};

const defaultMessageIds: MessageIdGenerator = {
  nextMessageId() {
    const randomUuid = globalThis.crypto?.randomUUID;
    if (typeof randomUuid !== "function") {
      throw new TypeError("messageIdGenerator is required in this runtime");
    }
    return `message_${randomUuid.call(globalThis.crypto)}`;
  },
};

export function normalizeClientOptions(
  input: WorkFabricClientOptions,
): NormalizedClientOptions {
  const queryRetry = { ...queryDefaults, ...input.queryRetry };
  const streamReconnect = { ...reconnectDefaults, ...input.streamReconnect };
  nonNegative(queryRetry.maxRetries, "maxRetries");
  positive(queryRetry.baseDelayMs, "baseDelayMs");
  positive(queryRetry.maxDelayMs, "maxDelayMs");
  positive(queryRetry.maxRetryAfterMs, "maxRetryAfterMs");
  if (queryRetry.baseDelayMs > queryRetry.maxDelayMs) {
    throw new TypeError("baseDelayMs must not exceed maxDelayMs");
  }
  nonNegative(streamReconnect.maxReconnects, "maxReconnects");
  positive(streamReconnect.baseDelayMs, "baseDelayMs");
  positive(streamReconnect.maxDelayMs, "maxDelayMs");
  positive(streamReconnect.maxFrameBytes, "maxFrameBytes");
  if (streamReconnect.baseDelayMs > streamReconnect.maxDelayMs) {
    throw new TypeError("baseDelayMs must not exceed maxDelayMs");
  }
  const fetchImplementation = input.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("fetch must be available");
  }
  const representation = Object.freeze({
    actorId: identity(input.representation.actorId, "actorId"),
    endpointId: identity(input.representation.endpointId, "endpointId"),
    ...(input.representation.delegationId === undefined
      ? {}
      : {
          delegationId: identity(
            input.representation.delegationId,
            "delegationId",
          ),
        }),
  });
  return Object.freeze({
    baseUrl: baseUrl(input.baseUrl),
    authentication: input.authentication,
    representation,
    tenantId: identity(input.tenantId, "tenantId"),
    exchangeId: identity(input.exchangeId, "exchangeId"),
    fetch: fetchImplementation,
    clock: input.clock ?? defaultClock,
    messageIdGenerator: input.messageIdGenerator ?? defaultMessageIds,
    requestTimeoutMs: positive(
      input.requestTimeoutMs ?? 30_000,
      "requestTimeoutMs",
    ),
    queryRetry: Object.freeze(queryRetry),
    streamReconnect: Object.freeze(streamReconnect),
  });
}

