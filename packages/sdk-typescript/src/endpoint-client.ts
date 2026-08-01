import {
  normalizeRepresentationContext,
  type RepresentationContext,
} from "./config.js";
import {
  decodeObject,
  identifier,
  positive,
  type RequestOptions,
} from "./query-client.js";
import type {
  CapabilityDescriptor,
  EndpointAvailability,
  EndpointCapabilityCard,
  EndpointCapabilityContract,
  EndpointCapabilityPage,
  EndpointClaimableHandoff,
  EndpointClaimableHandoffPage,
  EndpointDescriptor,
  EndpointDiscoveryPage,
  EndpointIdentityCard,
  EndpointIdentityPage,
  EndpointInboxPartitionPage,
  EndpointRegistration,
  EndpointSession,
} from "./protocol-types.js";
import type { SdkTransport } from "./transport.js";

export interface EndpointSessionOpenInput {
  readonly client_session_id: string;
  readonly protocol_version: string;
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly availability: EndpointAvailability;
  readonly requested_lease_seconds?: number;
  readonly expected_registration_version: number;
}

export interface EndpointHeartbeatInput {
  readonly fencing_token: number;
  readonly heartbeat_sequence: number;
  readonly availability: EndpointAvailability;
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly expected_registration_version: number;
}

export interface EndpointSessionCloseInput {
  readonly fencing_token: number;
  readonly heartbeat_sequence: number;
  readonly expected_registration_version: number;
}

export interface EndpointDiscoveryInput {
  readonly capability_id?: string;
  readonly version_constraint?: string;
  readonly required_input_media_types?: readonly string[];
  readonly required_output_media_types?: readonly string[];
  readonly availability?: readonly EndpointAvailability[];
  readonly cursor?: string;
  readonly limit?: number;
}

export interface EndpointInboxPartitionInput {
  readonly cursor?: string;
  readonly limit?: number;
}

function requestOptions(
  representation: RepresentationContext,
  options: RequestOptions,
) {
  return {
    representation: options.representation === undefined
      ? representation
      : normalizeRepresentationContext(options.representation),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function bounded(value: string | undefined, field: string): string | undefined {
  if (value !== undefined && (value.length === 0 || value.length > 2048)) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function strings(
  values: readonly string[] | undefined,
  field: string,
): readonly string[] | undefined {
  if (values === undefined) return undefined;
  if (
    values.length === 0 ||
    values.some((value) => value.length === 0 || value.length > 255)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return [...values];
}

function endpointRegistration(value: unknown): EndpointRegistration {
  const result = decodeObject<EndpointRegistration>(value);
  identifier(result.endpoint_id, "endpoint_id");
  return result;
}

function endpointDescriptor(value: unknown): EndpointDescriptor {
  const result = decodeObject<EndpointDescriptor>(value);
  identifier(result.endpoint_id, "endpoint_id");
  return result;
}

function endpointIdentityCard(value: unknown): EndpointIdentityCard {
  const result = decodeObject<EndpointIdentityCard>(value);
  identifier(result.endpoint_id, "endpoint_id");
  return result;
}

function endpointCapabilityCard(value: unknown): EndpointCapabilityCard {
  const result = decodeObject<EndpointCapabilityCard>(value);
  identifier(result.endpoint_id, "endpoint_id");
  if (!Array.isArray(result.capabilities)) {
    throw new TypeError("capabilities must be an array");
  }
  return result;
}

function endpointCapabilityContract(value: unknown): EndpointCapabilityContract {
  const result = decodeObject<EndpointCapabilityContract>(value);
  identifier(result.endpoint_id, "endpoint_id");
  const capability = decodeObject<{ readonly capability_id: string }>(
    result.capability,
  );
  identifier(capability.capability_id, "capability_id");
  return result;
}

function endpointSession(value: unknown): EndpointSession {
  const result = decodeObject<EndpointSession>(value);
  identifier(result.endpoint_id, "endpoint_id");
  identifier(result.session_id, "session_id");
  return result;
}

function page<T>(value: unknown, itemId: (item: T) => string): {
  readonly items: readonly T[];
  readonly next_cursor?: string;
} {
  const result = decodeObject<Record<string, unknown>>(value);
  if (!Array.isArray(result.items)) throw new TypeError("items must be an array");
  const items = result.items.map((item) => {
    const decoded = decodeObject<T>(item);
    itemId(decoded);
    return decoded;
  });
  if (
    result.next_cursor !== undefined &&
    (typeof result.next_cursor !== "string" || result.next_cursor.length === 0)
  ) {
    throw new TypeError("next_cursor is invalid");
  }
  return {
    items,
    ...(result.next_cursor === undefined
      ? {}
      : { next_cursor: result.next_cursor as string }),
  };
}

export class EndpointClient {
  constructor(
    private readonly transport: SdkTransport,
    private readonly representation: RepresentationContext,
  ) {}

  provision(
    endpointId: string,
    input: EndpointRegistration,
    options: RequestOptions = {},
  ): Promise<EndpointRegistration> {
    return this.transport.request({
      method: "PUT",
      path: ["v1", "admin", "endpoints", identifier(endpointId, "endpointId")],
      body: input,
      retry: "none",
      ...requestOptions(this.representation, options),
      decode: endpointRegistration,
    });
  }

  get(
    endpointId: string,
    options: RequestOptions = {},
  ): Promise<EndpointDescriptor> {
    return this.transport.request({
      method: "GET",
      path: ["v1", "endpoints", identifier(endpointId, "endpointId")],
      retry: "query",
      ...requestOptions(this.representation, options),
      decode: endpointDescriptor,
    });
  }

  discover(
    input: EndpointDiscoveryInput = {},
    options: RequestOptions = {},
  ): Promise<EndpointDiscoveryPage> {
    const limit = positive(input.limit, "limit");
    const inputMedia = strings(input.required_input_media_types, "required_input_media_types");
    const outputMedia = strings(input.required_output_media_types, "required_output_media_types");
    const availability = strings(input.availability, "availability");
    return this.transport.request({
      method: "GET",
      path: ["v1", "endpoints"],
      query: {
        ...(input.capability_id === undefined ? {} : { capability_id: input.capability_id }),
        ...(input.version_constraint === undefined ? {} : { version_constraint: input.version_constraint }),
        ...(inputMedia === undefined ? {} : { input_media_type: inputMedia }),
        ...(outputMedia === undefined ? {} : { output_media_type: outputMedia }),
        ...(availability === undefined ? {} : { availability }),
        ...(input.cursor === undefined ? {} : { cursor: bounded(input.cursor, "cursor") }),
        ...(limit === undefined ? {} : { limit }),
      },
      retry: "query",
      ...requestOptions(this.representation, options),
      decode: (value) => page<EndpointDescriptor>(value, (item) =>
        identifier(item.endpoint_id, "endpoint_id"),
      ),
    });
  }

  discoverIdentities(
    input: EndpointDiscoveryInput = {},
    options: RequestOptions = {},
  ): Promise<EndpointIdentityPage> {
    return this.discoverProgressively(
      "identity",
      input,
      options,
      endpointIdentityCard,
    );
  }

  discoverCapabilityCards(
    input: EndpointDiscoveryInput = {},
    options: RequestOptions = {},
  ): Promise<EndpointCapabilityPage> {
    return this.discoverProgressively(
      "summary",
      input,
      options,
      endpointCapabilityCard,
    );
  }

  getCapability(
    endpointId: string,
    capabilityId: string,
    options: RequestOptions = {},
  ): Promise<EndpointCapabilityContract> {
    return this.transport.request({
      method: "GET",
      path: [
        "v1",
        "endpoints",
        identifier(endpointId, "endpointId"),
        "capabilities",
        identifier(capabilityId, "capabilityId"),
      ],
      retry: "query",
      ...requestOptions(this.representation, options),
      decode: endpointCapabilityContract,
    });
  }

  openSession(
    endpointId: string,
    input: EndpointSessionOpenInput,
    options: RequestOptions = {},
  ): Promise<EndpointSession> {
    return this.transport.request({
      method: "POST",
      path: ["v1", "endpoints", identifier(endpointId, "endpointId"), "sessions"],
      body: input,
      retry: "none",
      ...requestOptions(this.representation, options),
      decode: endpointSession,
    });
  }

  heartbeat(
    endpointId: string,
    sessionId: string,
    input: EndpointHeartbeatInput,
    options: RequestOptions = {},
  ): Promise<EndpointSession> {
    return this.transport.request({
      method: "POST",
      path: ["v1", "endpoints", identifier(endpointId, "endpointId"), "sessions", identifier(sessionId, "sessionId"), "heartbeat"],
      body: input,
      retry: "none",
      ...requestOptions(this.representation, options),
      decode: endpointSession,
    });
  }

  closeSession(
    endpointId: string,
    sessionId: string,
    input: EndpointSessionCloseInput,
    options: RequestOptions = {},
  ): Promise<EndpointSession> {
    return this.transport.request({
      method: "POST",
      path: ["v1", "endpoints", identifier(endpointId, "endpointId"), "sessions", identifier(sessionId, "sessionId"), "close"],
      body: input,
      retry: "none",
      ...requestOptions(this.representation, options),
      decode: endpointSession,
    });
  }

  listInboxPartitions(
    endpointId: string,
    input: EndpointInboxPartitionInput = {},
    options: RequestOptions = {},
  ): Promise<EndpointInboxPartitionPage> {
    const limit = positive(input.limit, "limit");
    return this.transport.request({
      method: "GET",
      path: ["v1", "endpoints", identifier(endpointId, "endpointId"), "inbox", "partitions"],
      query: {
        ...(input.cursor === undefined ? {} : { cursor: bounded(input.cursor, "cursor") }),
        ...(limit === undefined ? {} : { limit }),
      },
      retry: "query",
      ...requestOptions(this.representation, options),
      decode: (value) => page(value, (item: { readonly partition_id: string }) =>
        identifier(item.partition_id, "partition_id"),
      ) as EndpointInboxPartitionPage,
    });
  }

  listClaimableHandoffs(
    endpointId: string,
    input: EndpointInboxPartitionInput = {},
    options: RequestOptions = {},
  ): Promise<EndpointClaimableHandoffPage> {
    const limit = positive(input.limit, "limit");
    return this.transport.request({
      method: "GET",
      path: [
        "v1",
        "endpoints",
        identifier(endpointId, "endpointId"),
        "claimable-handoffs",
      ],
      query: {
        ...(input.cursor === undefined
          ? {}
          : { cursor: bounded(input.cursor, "cursor") }),
        ...(limit === undefined ? {} : { limit }),
      },
      retry: "query",
      ...requestOptions(this.representation, options),
      decode: (value) => page<EndpointClaimableHandoff>(
        value,
        (item) => identifier(item.handoff_id, "handoff_id"),
      ) as EndpointClaimableHandoffPage,
    });
  }

  private discoverProgressively<T extends EndpointIdentityCard>(
    disclosure: "identity" | "summary",
    input: EndpointDiscoveryInput,
    options: RequestOptions,
    decodeItem: (value: unknown) => T,
  ): Promise<{ readonly items: readonly T[]; readonly next_cursor?: string }> {
    const limit = positive(input.limit, "limit");
    const inputMedia = strings(input.required_input_media_types, "required_input_media_types");
    const outputMedia = strings(input.required_output_media_types, "required_output_media_types");
    const availability = strings(input.availability, "availability");
    return this.transport.request({
      method: "GET",
      path: ["v1", "endpoints"],
      query: {
        disclosure,
        ...(input.capability_id === undefined ? {} : { capability_id: input.capability_id }),
        ...(input.version_constraint === undefined ? {} : { version_constraint: input.version_constraint }),
        ...(inputMedia === undefined ? {} : { input_media_type: inputMedia }),
        ...(outputMedia === undefined ? {} : { output_media_type: outputMedia }),
        ...(availability === undefined ? {} : { availability }),
        ...(input.cursor === undefined ? {} : { cursor: bounded(input.cursor, "cursor") }),
        ...(limit === undefined ? {} : { limit }),
      },
      retry: "query",
      ...requestOptions(this.representation, options),
      decode: (value) => {
        const decoded = page<T>(value, (item) => {
          const card = decodeItem(item);
          return identifier(card.endpoint_id, "endpoint_id");
        });
        return {
          ...decoded,
          items: decoded.items.map((item) => decodeItem(item)),
        };
      },
    });
  }
}
