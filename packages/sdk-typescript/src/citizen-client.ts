import {
  validateCitizenDeclaration,
  validateCitizenDeclarations,
  validateCitizenProvisioning,
  validateNetworkCitizenDescriptor,
  type CitizenAvailability,
  type CitizenCardPage,
  type CitizenDeclarationContract,
  type CitizenDeclarationReplaceInput,
  type CitizenDeclarationSummary,
  type CitizenDeclarationSummaryPage,
  type CitizenHeartbeatInput,
  type CitizenProvisioning,
  type CitizenSessionCloseInput,
  type CitizenSessionOpenInput,
  type NetworkCitizenDescriptor,
  type NetworkCitizenKind,
  type PublicCitizenSession,
} from "@work-fabric/network-citizen-spi";

import {
  normalizeRepresentationContext,
  type RepresentationContext,
} from "./config.js";
import {
  identifier,
  positive,
  type RequestOptions,
} from "./query-client.js";
import type { SdkTransport } from "./transport.js";

export interface CitizenDiscoveryInput {
  readonly citizen_kind?: NetworkCitizenKind;
  readonly declaration_id?: string;
  readonly availability?: readonly CitizenAvailability[];
  readonly executable_only?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

function requestOptions(
  representation: RepresentationContext,
  options: RequestOptions,
) {
  return {
    representation:
      options.representation === undefined
        ? representation
        : normalizeRepresentationContext(options.representation),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function exactObject(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!keys.includes(key)) throw new TypeError(`${path} has unknown field ${key}`);
  }
  return source;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string`);
  return identifier(value, path);
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${path} must be a positive safe integer`);
  }
  return value as number;
}

function digest(value: unknown, path: string): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${path} is invalid`);
  }
  return value as `sha256:${string}`;
}

function cursor(value: string | undefined): string | undefined {
  if (value !== undefined && (value.length === 0 || value.length > 4096)) {
    throw new TypeError("cursor is invalid");
  }
  return value;
}

function stringList<T extends string>(
  value: readonly T[] | undefined,
  path: string,
): readonly T[] | undefined {
  if (value === undefined) return undefined;
  if (
    value.length === 0 ||
    new Set(value).size !== value.length ||
    value.some((item) => item.length === 0 || item.length > 128)
  ) {
    throw new TypeError(`${path} is invalid`);
  }
  return [...value];
}

function decodeProvisioning(value: unknown): CitizenProvisioning {
  return validateCitizenProvisioning(value);
}

function decodeDescriptor(value: unknown): NetworkCitizenDescriptor {
  return validateNetworkCitizenDescriptor(value);
}

function decodeSummary(value: unknown): CitizenDeclarationSummary {
  const source = exactObject(value, "declaration summary", [
    "declaration_id",
    "declaration_kind",
    "version",
    "name",
    "description",
  ]);
  const validated = validateCitizenDeclaration({
    ...source,
    interaction_modes: [],
    risk: "low",
    confirmation: "none",
    constraints: {},
    extensions: {},
  });
  return {
    declaration_id: validated.declaration_id,
    declaration_kind: validated.declaration_kind,
    version: validated.version,
    name: validated.name,
    description: validated.description,
  };
}

function decodeSession(value: unknown): PublicCitizenSession {
  const source = exactObject(value, "Citizen session", [
    "citizen_id",
    "session_id",
    "client_session_id",
    "descriptor",
    "declarations",
    "declaration_version",
    "declaration_digest",
    "accepted_lease_seconds",
    "fencing_token",
    "heartbeat_sequence",
    "state",
    "expires_at",
    "renew_after",
    "registration_version",
  ]);
  if (!Array.isArray(source.declarations)) {
    throw new TypeError("Citizen session declarations must be an array");
  }
  const state = source.state;
  if (!["active", "closed", "fenced"].includes(String(state))) {
    throw new TypeError("Citizen session state is invalid");
  }
  if (
    !Number.isSafeInteger(source.heartbeat_sequence) ||
    (source.heartbeat_sequence as number) < 0
  ) {
    throw new TypeError("Citizen session heartbeat_sequence is invalid");
  }
  return {
    citizen_id: requiredString(source.citizen_id, "citizen_id"),
    session_id: requiredString(source.session_id, "session_id"),
    client_session_id: requiredString(source.client_session_id, "client_session_id"),
    descriptor: decodeDescriptor(source.descriptor),
    declarations: validateCitizenDeclarations(source.declarations),
    declaration_version: positiveInteger(source.declaration_version, "declaration_version"),
    declaration_digest: digest(source.declaration_digest, "declaration_digest"),
    accepted_lease_seconds: positiveInteger(source.accepted_lease_seconds, "accepted_lease_seconds"),
    fencing_token: positiveInteger(source.fencing_token, "fencing_token"),
    heartbeat_sequence: source.heartbeat_sequence as number,
    state: state as PublicCitizenSession["state"],
    expires_at: requiredString(source.expires_at, "expires_at"),
    renew_after: requiredString(source.renew_after, "renew_after"),
    registration_version: positiveInteger(source.registration_version, "registration_version"),
  };
}

function decodeCardPage(value: unknown): CitizenCardPage {
  const source = exactObject(value, "Citizen page", ["items", "next_cursor"]);
  if (!Array.isArray(source.items)) throw new TypeError("Citizen page items must be an array");
  const nextCursor = source.next_cursor;
  if (
    nextCursor !== undefined &&
    (typeof nextCursor !== "string" || nextCursor.length === 0)
  ) {
    throw new TypeError("next_cursor is invalid");
  }
  return {
    items: source.items.map(decodeDescriptor),
    ...(nextCursor === undefined ? {} : { next_cursor: nextCursor as string }),
  };
}

function decodeSummaryPage(value: unknown): CitizenDeclarationSummaryPage {
  const source = exactObject(value, "Citizen declaration page", ["items"]);
  if (!Array.isArray(source.items)) {
    throw new TypeError("Citizen declaration page items must be an array");
  }
  return { items: source.items.map(decodeSummary) };
}

function decodeContract(value: unknown): CitizenDeclarationContract {
  const source = exactObject(value, "Citizen declaration contract", [
    "citizen_id",
    "citizen_kind",
    "availability",
    "declaration",
    "declaration_version",
    "fencing_token",
  ]);
  const citizenKind = source.citizen_kind;
  if (
    ![
      "decision-body",
      "capability-provider",
      "channel",
      "context-provider",
      "governance-provider",
      "observer",
    ].includes(String(citizenKind))
  ) {
    throw new TypeError("citizen_kind is invalid");
  }
  const availability = source.availability;
  if (!["available", "degraded", "draining", "unavailable"].includes(String(availability))) {
    throw new TypeError("availability is invalid");
  }
  return {
    citizen_id: requiredString(source.citizen_id, "citizen_id"),
    citizen_kind: citizenKind as NetworkCitizenKind,
    availability: availability as CitizenAvailability,
    declaration: validateCitizenDeclaration(source.declaration),
    declaration_version: positiveInteger(source.declaration_version, "declaration_version"),
    fencing_token: positiveInteger(source.fencing_token, "fencing_token"),
  };
}

export class CitizenClient {
  constructor(
    private readonly transport: SdkTransport,
    private readonly representation: RepresentationContext,
  ) {}

  provision(
    citizenId: string,
    input: CitizenProvisioning,
    options: RequestOptions = {},
  ): Promise<CitizenProvisioning> {
    return this.transport.request({
      method: "PUT",
      path: ["v1", "admin", "citizens", identifier(citizenId, "citizenId")],
      body: input,
      retry: "none",
      ...requestOptions(this.representation, options),
      decode: decodeProvisioning,
    });
  }

  list(
    input: CitizenDiscoveryInput = {},
    options: RequestOptions = {},
  ): Promise<CitizenCardPage> {
    const limit = positive(input.limit, "limit");
    const availability = stringList(input.availability, "availability");
    return this.transport.request({
      method: "GET",
      path: ["v1", "citizens"],
      query: {
        ...(input.citizen_kind === undefined ? {} : { citizen_kind: input.citizen_kind }),
        ...(input.declaration_id === undefined ? {} : { declaration_id: input.declaration_id }),
        ...(availability === undefined ? {} : { availability }),
        ...(input.executable_only === undefined ? {} : { executable_only: input.executable_only }),
        ...(input.cursor === undefined ? {} : { cursor: cursor(input.cursor) }),
        ...(limit === undefined ? {} : { limit }),
      },
      retry: "query",
      ...requestOptions(this.representation, options),
      decode: decodeCardPage,
    });
  }

  get(
    citizenId: string,
    options: RequestOptions = {},
  ): Promise<NetworkCitizenDescriptor> {
    return this.transport.request({
      method: "GET",
      path: ["v1", "citizens", identifier(citizenId, "citizenId")],
      retry: "query",
      ...requestOptions(this.representation, options),
      decode: decodeDescriptor,
    });
  }

  listDeclarations(
    citizenId: string,
    options: RequestOptions = {},
  ): Promise<CitizenDeclarationSummaryPage> {
    return this.transport.request({
      method: "GET",
      path: ["v1", "citizens", identifier(citizenId, "citizenId"), "declarations"],
      retry: "query",
      ...requestOptions(this.representation, options),
      decode: decodeSummaryPage,
    });
  }

  getDeclaration(
    citizenId: string,
    declarationId: string,
    options: RequestOptions = {},
  ): Promise<CitizenDeclarationContract> {
    return this.transport.request({
      method: "GET",
      path: [
        "v1",
        "citizens",
        identifier(citizenId, "citizenId"),
        "declarations",
        identifier(declarationId, "declarationId"),
      ],
      retry: "query",
      ...requestOptions(this.representation, options),
      decode: decodeContract,
    });
  }

  openSession(
    citizenId: string,
    input: CitizenSessionOpenInput,
    options: RequestOptions = {},
  ): Promise<PublicCitizenSession> {
    return this.transport.request({
      method: "POST",
      path: ["v1", "citizens", identifier(citizenId, "citizenId"), "sessions"],
      body: input,
      retry: "none",
      ...requestOptions(this.representation, options),
      decode: decodeSession,
    });
  }

  heartbeat(
    citizenId: string,
    sessionId: string,
    input: CitizenHeartbeatInput,
    options: RequestOptions = {},
  ): Promise<PublicCitizenSession> {
    return this.transport.request({
      method: "POST",
      path: [
        "v1",
        "citizens",
        identifier(citizenId, "citizenId"),
        "sessions",
        identifier(sessionId, "sessionId"),
        "heartbeat",
      ],
      body: input,
      retry: "none",
      ...requestOptions(this.representation, options),
      decode: decodeSession,
    });
  }

  replaceDeclarations(
    citizenId: string,
    sessionId: string,
    input: CitizenDeclarationReplaceInput,
    options: RequestOptions = {},
  ): Promise<PublicCitizenSession> {
    return this.transport.request({
      method: "PUT",
      path: [
        "v1",
        "citizens",
        identifier(citizenId, "citizenId"),
        "sessions",
        identifier(sessionId, "sessionId"),
        "declarations",
      ],
      body: input,
      retry: "none",
      ...requestOptions(this.representation, options),
      decode: decodeSession,
    });
  }

  closeSession(
    citizenId: string,
    sessionId: string,
    input: CitizenSessionCloseInput,
    options: RequestOptions = {},
  ): Promise<PublicCitizenSession> {
    return this.transport.request({
      method: "POST",
      path: [
        "v1",
        "citizens",
        identifier(citizenId, "citizenId"),
        "sessions",
        identifier(sessionId, "sessionId"),
        "close",
      ],
      body: input,
      retry: "none",
      ...requestOptions(this.representation, options),
      decode: decodeSession,
    });
  }
}
