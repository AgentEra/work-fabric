import type {
  DiscoveryFederatedQueryResponse,
  DiscoveryPage,
  DiscoveryQuery,
  DiscoveryQueryBudget,
  DiscoveryRecord,
  DiscoveryRecordKind,
} from "@work-fabric/discovery-spi";

import {
  normalizeRepresentationContext,
  type RepresentationContext,
} from "./config.js";
import {
  decodeObject,
  identifier,
  type RequestOptions,
} from "./query-client.js";
import type { SdkTransport } from "./transport.js";

export type DiscoveryResult = DiscoveryRecord;

export interface DiscoveryFindCapabilitiesInput {
  readonly capability_id?: string;
  readonly version_constraint?: string;
  readonly input_media_types?: readonly string[];
  readonly output_media_types?: readonly string[];
  readonly interaction_modes?: readonly string[];
  readonly binding_types?: readonly string[];
  readonly cursor?: string;
  readonly limit?: number;
}

export interface DiscoveryFederatedQueryInput {
  readonly query_id?: string;
  readonly query: DiscoveryQuery;
  readonly budget: DiscoveryQueryBudget;
}

function options(defaultRepresentation: RepresentationContext, input: RequestOptions) {
  return {
    representation: input.representation === undefined
      ? defaultRepresentation
      : normalizeRepresentationContext(input.representation),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

function bounded(value: string | undefined, field: string, maximum = 4096): string | undefined {
  if (value !== undefined && (value.length < 1 || value.length > maximum || value.trim() !== value)) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function strings(value: readonly string[] | undefined, field: string, maximum = 32): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (value.length < 1 || value.length > maximum || value.some((item) => typeof item !== "string" || item.length < 1 || item.length > 256)) {
    throw new TypeError(`${field} is invalid`);
  }
  return [...value];
}

function pageLimit(value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 200)) throw new TypeError("limit is invalid");
  return value;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.endsWith("Z") || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new TypeError(`${field} is invalid`);
  return value;
}

function decodeRecord(value: unknown, expected?: DiscoveryRecordKind): DiscoveryRecord {
  const record = decodeObject<Record<string, unknown>>(value);
  const kinds: readonly DiscoveryRecordKind[] = ["exchange", "capability_route", "participant", "endpoint"];
  if (record.profile !== "workfabric.discovery.v1" || !kinds.includes(record.record_kind as DiscoveryRecordKind) ||
      (expected !== undefined && record.record_kind !== expected)) throw new TypeError("record discriminant is invalid");
  identifier(record.record_id as string, "record_id");
  identifier(record.origin_exchange_id as string, "origin_exchange_id");
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 1) throw new TypeError("revision is invalid");
  const issuedAt = timestamp(record.issued_at, "issued_at");
  const expiresAt = timestamp(record.expires_at, "expires_at");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) throw new TypeError("record freshness is invalid");
  stringArray(record.audiences, "audiences");
  decodeObject(record.payload);
  if (typeof record.payload_digest !== "string" || !/^[a-f0-9]{64}$/.test(record.payload_digest) ||
      typeof record.key_id !== "string" || typeof record.signature !== "string") throw new TypeError("record proof is invalid");
  return record as unknown as DiscoveryRecord;
}

function decodePage(value: unknown): DiscoveryPage {
  const source = decodeObject<Record<string, unknown>>(value);
  if (!(source.coverage === "authoritative" || source.coverage === "complete" || source.coverage === "partial") || !Array.isArray(source.items)) {
    throw new TypeError("discovery page is invalid");
  }
  const warnings = stringArray(source.warnings, "warnings");
  if (source.next_cursor !== undefined && (typeof source.next_cursor !== "string" || source.next_cursor.length < 1)) {
    throw new TypeError("next_cursor is invalid");
  }
  return {
    coverage: source.coverage,
    items: source.items.map((item) => decodeRecord(item)),
    warnings,
    ...(source.next_cursor === undefined ? {} : { next_cursor: source.next_cursor as string }),
  };
}

function natural(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new TypeError(`${field} is invalid`);
  return value;
}

function validateBudget(value: DiscoveryQueryBudget): DiscoveryQueryBudget {
  return {
    deadline: timestamp(value.deadline, "deadline"),
    remaining_hops: natural(value.remaining_hops, "remaining_hops", 8),
    remaining_fanout: natural(value.remaining_fanout, "remaining_fanout", 64),
    remaining_results: natural(value.remaining_results, "remaining_results", 10_000),
    remaining_bytes: natural(value.remaining_bytes, "remaining_bytes", 65_536),
  };
}

function validateQuery(value: DiscoveryQuery): DiscoveryQuery {
  const limit = pageLimit(value.limit);
  const recordKinds = strings(value.record_kinds, "record_kinds", 4) as readonly DiscoveryRecordKind[] | undefined;
  if (recordKinds?.some((kind) => !(["exchange", "capability_route", "participant", "endpoint"] as const).includes(kind))) {
    throw new TypeError("record_kinds is invalid");
  }
  return {
    ...value,
    limit: limit!,
    ...(recordKinds === undefined ? {} : { record_kinds: recordKinds }),
    ...(value.input_media_types === undefined ? {} : { input_media_types: strings(value.input_media_types, "input_media_types")! }),
    ...(value.output_media_types === undefined ? {} : { output_media_types: strings(value.output_media_types, "output_media_types")! }),
    ...(value.interaction_modes === undefined ? {} : { interaction_modes: strings(value.interaction_modes, "interaction_modes")! }),
    ...(value.binding_types === undefined ? {} : { binding_types: strings(value.binding_types, "binding_types")! }),
  };
}

export class DiscoveryClient {
  constructor(
    private readonly transport: SdkTransport,
    private readonly representation: RepresentationContext,
  ) {}

  getExchange(exchangeId: string, request: RequestOptions = {}): Promise<DiscoveryRecord<"exchange">> {
    return this.detail("exchanges", exchangeId, "exchange", request);
  }

  getParticipant(actorId: string, request: RequestOptions = {}): Promise<DiscoveryRecord<"participant">> {
    return this.detail("participants", actorId, "participant", request);
  }

  getEndpoint(endpointId: string, request: RequestOptions = {}): Promise<DiscoveryRecord<"endpoint">> {
    return this.detail("endpoints", endpointId, "endpoint", request);
  }

  findCapabilities(input: DiscoveryFindCapabilitiesInput = {}, request: RequestOptions = {}): Promise<DiscoveryPage> {
    const inputMedia = strings(input.input_media_types, "input_media_types");
    const outputMedia = strings(input.output_media_types, "output_media_types");
    const interactions = strings(input.interaction_modes, "interaction_modes");
    const bindings = strings(input.binding_types, "binding_types");
    const limit = pageLimit(input.limit);
    return this.transport.request({
      method: "GET",
      path: ["v1", "discovery", "capabilities"],
      query: {
        ...(input.capability_id === undefined ? {} : { capability_id: bounded(input.capability_id, "capability_id", 128) }),
        ...(input.version_constraint === undefined ? {} : { version_constraint: bounded(input.version_constraint, "version_constraint", 256) }),
        ...(inputMedia === undefined ? {} : { input_media_type: inputMedia }),
        ...(outputMedia === undefined ? {} : { output_media_type: outputMedia }),
        ...(interactions === undefined ? {} : { interaction_mode: interactions }),
        ...(bindings === undefined ? {} : { binding_type: bindings }),
        ...(input.cursor === undefined ? {} : { cursor: bounded(input.cursor, "cursor") }),
        ...(limit === undefined ? {} : { limit }),
      },
      retry: "query",
      ...options(this.representation, request),
      decode: decodePage,
    });
  }

  query(input: DiscoveryFederatedQueryInput, request: RequestOptions = {}): Promise<DiscoveryPage> {
    const body = {
      ...(input.query_id === undefined ? {} : { query_id: identifier(input.query_id, "query_id") }),
      query: validateQuery(input.query),
      budget: validateBudget(input.budget),
    };
    return this.transport.request({
      method: "POST",
      path: ["v1", "discovery", "queries"],
      body,
      retry: "none",
      ...options(this.representation, request),
      decode: decodePage,
    });
  }

  private detail<K extends Exclude<DiscoveryRecordKind, "capability_route">>(
    resource: "exchanges" | "participants" | "endpoints",
    id: string,
    kind: K,
    request: RequestOptions,
  ): Promise<DiscoveryRecord<K>> {
    return this.transport.request({
      method: "GET",
      path: ["v1", "discovery", resource, identifier(id, "id")],
      retry: "query",
      ...options(this.representation, request),
      decode: (value) => decodeRecord(value, kind) as DiscoveryRecord<K>,
    });
  }
}
