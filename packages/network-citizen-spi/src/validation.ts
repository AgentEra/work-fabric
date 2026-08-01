import {
  NETWORK_CITIZEN_KINDS,
  type CitizenActorReference,
  type CitizenAvailability,
  type CitizenDeclaration,
  type CitizenDeclarationKind,
  type CitizenIdentity,
  type CitizenProvisioning,
  type CitizenRisk,
  type CitizenSchemaReference,
  type NetworkCitizenDescriptor,
  type NetworkCitizenKind,
} from "./contracts.js";
import {
  cloneCitizenJson,
  deepFreezeCitizenJson,
  type CitizenJsonObject,
  type CitizenJsonValue,
} from "./json.js";

const CITIZEN_ID = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;
const DECLARATION_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PROTOCOL_VERSION = /^[1-9]\d*(?:\.[0-9]+)*$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const BINDING = /^[a-z][a-z0-9+.-]{0,63}$/;
const URN = /^urn:[A-Za-z0-9][A-Za-z0-9:._/-]{1,510}$/;

function invalid(path: string, detail: string): never {
  throw new TypeError(`${path} ${detail}`);
}

function object(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(path, "must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(path, "must be a plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      invalid(path, "contains an accessor");
    }
    if (!keys.includes(key)) invalid(path, `has unknown field ${key}`);
  }
  return value as Record<string, unknown>;
}

function string(
  value: unknown,
  path: string,
  pattern: RegExp,
  maximum = 256,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !pattern.test(value)) {
    invalid(path, "is invalid");
  }
  return value;
}

function nonEmptyText(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    invalid(path, "is invalid");
  }
  return value;
}

function uniqueStrings(
  value: unknown,
  path: string,
  validator: (item: unknown, path: string) => string,
  maximum = 64,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(path, "must be a bounded array");
  const result = value.map((item, index) => validator(item, `${path}[${index}]`));
  if (new Set(result).size !== result.length) invalid(path, "must contain unique values");
  return Object.freeze(result);
}

function oneOf<T extends string>(
  value: unknown,
  path: string,
  values: readonly T[],
): T {
  if (typeof value !== "string" || !values.includes(value as T)) invalid(path, "is invalid");
  return value as T;
}

function actor(value: unknown, path: string): CitizenActorReference {
  const source = object(value, path, ["actor_id", "actor_type"]);
  return Object.freeze({
    actor_id: string(source.actor_id, `${path}.actor_id`, OPAQUE_ID),
    actor_type: oneOf(source.actor_type, `${path}.actor_type`, [
      "human",
      "agent",
      "system",
    ] as const),
  });
}

function identity(value: unknown, path: string): CitizenIdentity | null {
  if (value === null) return null;
  const source = object(value, path, ["principal_id", "actor", "endpoint_id"]);
  const actorValue = source.actor === undefined ? undefined : actor(source.actor, `${path}.actor`);
  const endpointId = source.endpoint_id === undefined
    ? undefined
    : string(source.endpoint_id, `${path}.endpoint_id`, OPAQUE_ID);
  if (endpointId !== undefined && actorValue === undefined) {
    invalid(`${path}.endpoint_id`, "requires actor");
  }
  return Object.freeze({
    principal_id: string(source.principal_id, `${path}.principal_id`, OPAQUE_ID),
    ...(actorValue === undefined ? {} : { actor: actorValue }),
    ...(endpointId === undefined ? {} : { endpoint_id: endpointId }),
  });
}

function schemaReference(value: unknown, path: string): CitizenSchemaReference {
  const source = object(value, path, ["uri", "digest"]);
  return Object.freeze({
    uri: string(source.uri, `${path}.uri`, URN, 512),
    digest: string(source.digest, `${path}.digest`, SHA256, 71) as `sha256:${string}`,
  });
}

export function assertNetworkCitizenKind(value: unknown): NetworkCitizenKind {
  return oneOf(value, "citizen_kind", NETWORK_CITIZEN_KINDS);
}

export function validateNetworkCitizenDescriptor(
  value: unknown,
): NetworkCitizenDescriptor {
  const source = object(value, "descriptor", [
    "citizen_id",
    "citizen_kind",
    "version",
    "identity",
    "protocol",
    "declarations",
    "availability",
    "extensions",
  ]);
  const protocol = object(source.protocol, "descriptor.protocol", [
    "versions",
    "bindings",
  ]);
  const declarations = object(source.declarations, "descriptor.declarations", [
    "count",
    "digest",
  ]);
  if (!Number.isSafeInteger(declarations.count) || (declarations.count as number) < 0 || (declarations.count as number) > 1024) {
    invalid("descriptor.declarations.count", "is invalid");
  }
  const extensions = cloneCitizenJson(source.extensions, "descriptor.extensions");
  if (extensions === null || typeof extensions !== "object" || Array.isArray(extensions)) {
    invalid("descriptor.extensions", "must be an object");
  }
  const result: NetworkCitizenDescriptor = {
    citizen_id: string(source.citizen_id, "descriptor.citizen_id", CITIZEN_ID, 128),
    citizen_kind: assertNetworkCitizenKind(source.citizen_kind),
    version: string(source.version, "descriptor.version", SEMVER, 64),
    identity: identity(source.identity, "descriptor.identity"),
    protocol: Object.freeze({
      versions: uniqueStrings(protocol.versions, "descriptor.protocol.versions", (item, path) => string(item, path, PROTOCOL_VERSION, 64), 16),
      bindings: uniqueStrings(protocol.bindings, "descriptor.protocol.bindings", (item, path) => string(item, path, BINDING, 64), 16),
    }),
    declarations: Object.freeze({
      count: declarations.count as number,
      digest: string(declarations.digest, "descriptor.declarations.digest", SHA256, 71) as `sha256:${string}`,
    }),
    availability: oneOf(source.availability, "descriptor.availability", [
      "available",
      "degraded",
      "draining",
      "unavailable",
    ] as const) satisfies CitizenAvailability,
    extensions: extensions as CitizenJsonObject,
  };
  return Object.freeze(result);
}

export function validateCitizenDeclaration(
  value: unknown,
): CitizenDeclaration {
  const source = object(value, "declaration", [
    "declaration_id",
    "declaration_kind",
    "version",
    "name",
    "description",
    "input_schema",
    "output_schema",
    "interaction_modes",
    "risk",
    "confirmation",
    "constraints",
    "extensions",
  ]);
  const constraints = cloneCitizenJson(source.constraints, "declaration.constraints");
  const extensions = cloneCitizenJson(source.extensions, "declaration.extensions");
  if (constraints === null || typeof constraints !== "object" || Array.isArray(constraints)) invalid("declaration.constraints", "must be an object");
  if (extensions === null || typeof extensions !== "object" || Array.isArray(extensions)) invalid("declaration.extensions", "must be an object");
  const result: CitizenDeclaration = {
    declaration_id: string(source.declaration_id, "declaration.declaration_id", DECLARATION_ID, 128),
    declaration_kind: oneOf(source.declaration_kind, "declaration.declaration_kind", [
      "capability",
      "context",
      "channel",
      "policy",
    ] as const) satisfies CitizenDeclarationKind,
    version: string(source.version, "declaration.version", SEMVER, 64),
    name: nonEmptyText(source.name, "declaration.name", 256),
    description: nonEmptyText(source.description, "declaration.description", 4096),
    ...(source.input_schema === undefined ? {} : { input_schema: schemaReference(source.input_schema, "declaration.input_schema") }),
    ...(source.output_schema === undefined ? {} : { output_schema: schemaReference(source.output_schema, "declaration.output_schema") }),
    interaction_modes: uniqueStrings(source.interaction_modes, "declaration.interaction_modes", (item, path) => oneOf(item, path, ["synchronous", "asynchronous", "status-updates"] as const), 3) as CitizenDeclaration["interaction_modes"],
    risk: oneOf(source.risk, "declaration.risk", ["low", "medium", "high", "destructive"] as const) satisfies CitizenRisk,
    confirmation: oneOf(source.confirmation, "declaration.confirmation", ["none", "explicit"] as const),
    constraints: constraints as CitizenJsonObject,
    extensions: extensions as CitizenJsonObject,
  };
  return deepFreezeCitizenJson(result as unknown as CitizenJsonValue) as unknown as CitizenDeclaration;
}

export function validateCitizenDeclarations(
  value: unknown,
): readonly CitizenDeclaration[] {
  if (!Array.isArray(value) || value.length > 1024) {
    invalid("declarations", "must be a bounded array");
  }
  const declarations = value.map(validateCitizenDeclaration);
  const ids = declarations.map((item) => item.declaration_id);
  if (new Set(ids).size !== ids.length) invalid("declarations", "must contain unique declaration_id values");
  return Object.freeze(declarations);
}

export function validateCitizenProvisioning(
  value: unknown,
): CitizenProvisioning {
  const source = object(value, "provisioning", [
    "citizen_id",
    "citizen_kind",
    "principal_id",
    "allowed_actor",
    "allowed_endpoint_id",
    "allowed_declaration_namespaces",
    "maximum_risk",
    "administrative_state",
    "registration_version",
  ]);
  const allowedActor = source.allowed_actor === undefined
    ? undefined
    : actor(source.allowed_actor, "provisioning.allowed_actor");
  const allowedEndpointId = source.allowed_endpoint_id === undefined
    ? undefined
    : string(
        source.allowed_endpoint_id,
        "provisioning.allowed_endpoint_id",
        OPAQUE_ID,
      );
  if (allowedEndpointId !== undefined && allowedActor === undefined) {
    invalid("provisioning.allowed_endpoint_id", "requires allowed_actor");
  }
  if (
    !Number.isSafeInteger(source.registration_version) ||
    (source.registration_version as number) <= 0
  ) {
    invalid("provisioning.registration_version", "is invalid");
  }
  return Object.freeze({
    citizen_id: string(source.citizen_id, "provisioning.citizen_id", CITIZEN_ID, 128),
    citizen_kind: assertNetworkCitizenKind(source.citizen_kind),
    principal_id: string(source.principal_id, "provisioning.principal_id", OPAQUE_ID),
    ...(allowedActor === undefined ? {} : { allowed_actor: allowedActor }),
    ...(allowedEndpointId === undefined
      ? {}
      : { allowed_endpoint_id: allowedEndpointId }),
    allowed_declaration_namespaces: uniqueStrings(
      source.allowed_declaration_namespaces,
      "provisioning.allowed_declaration_namespaces",
      (item, path) => string(item, path, /^[a-z][a-z0-9_]*$/, 64),
      64,
    ),
    maximum_risk: oneOf(
      source.maximum_risk,
      "provisioning.maximum_risk",
      ["low", "medium", "high", "destructive"] as const,
    ),
    administrative_state: oneOf(
      source.administrative_state,
      "provisioning.administrative_state",
      ["enabled", "disabled"] as const,
    ),
    registration_version: source.registration_version as number,
  });
}
