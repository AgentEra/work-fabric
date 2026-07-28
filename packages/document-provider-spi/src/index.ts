export type DocumentOperation =
  | "create"
  | "read"
  | "update"
  | "append"
  | "delete";

export interface DocumentResourceReference {
  readonly resource_uri: string;
}

export type DocumentPlacementRequest =
  | { readonly resource_uri: string }
  | { readonly policy_ref: string };

export interface DocumentDelegationContext {
  readonly represented_actor_id: string;
  readonly delegation_id: string;
  readonly scopes: readonly string[];
  readonly expires_at: string;
}

export interface DocumentAccessRequest extends DocumentDelegationContext {
  readonly tenant_id: string;
  readonly operation: DocumentOperation;
  readonly resource: DocumentResourceReference;
}

export type DocumentAccessDecision =
  | {
      readonly decision: "allow";
      readonly evidence_ref: string;
      readonly valid_until: string;
    }
  | {
      readonly decision: "deny";
      readonly reason:
        | "delegation_invalid"
        | "identity_unavailable"
        | "permission_denied"
        | "authorization_unavailable";
    };

export interface DocumentAccessAuthorizer {
  authorize(
    input: DocumentAccessRequest,
    signal?: AbortSignal,
  ): Promise<DocumentAccessDecision>;
}

export interface NativeDocumentSubjectResolver {
  resolve(
    input: {
      readonly tenant_id: string;
      readonly represented_actor_id: string;
      readonly delegation_id: string;
    },
    signal?: AbortSignal,
  ): Promise<{
    readonly native_subject_ref: string;
    readonly valid_until: string;
  } | null>;
}

export interface NativeDocumentPermissionGateway {
  check(
    input: {
      readonly native_subject_ref: string;
      readonly operation: DocumentOperation;
      readonly resource: DocumentResourceReference;
    },
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly decision: "allow";
        readonly evidence_ref: string;
        readonly valid_until: string;
      }
    | {
        readonly decision: "deny";
        readonly evidence_ref: string;
      }
  >;
}

export interface BrokeredDocumentAccessAuthorizerOptions {
  readonly subjects: NativeDocumentSubjectResolver;
  readonly permissions: NativeDocumentPermissionGateway;
  readonly now?: () => string;
}

/**
 * Keeps provider-native subject identity and ACL evidence behind one adapter
 * boundary. Work Fabric only receives the public allow/deny decision.
 */
export class BrokeredDocumentAccessAuthorizer
implements DocumentAccessAuthorizer {
  private readonly now: () => string;

  constructor(
    private readonly options: BrokeredDocumentAccessAuthorizerOptions,
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async authorize(
    input: DocumentAccessRequest,
    signal?: AbortSignal,
  ): Promise<DocumentAccessDecision> {
    const delegationExpiry = Date.parse(input.expires_at);
    const now = Date.parse(this.now());
    if (
      !Number.isFinite(delegationExpiry) ||
      !Number.isFinite(now) ||
      delegationExpiry <= now
    ) {
      return { decision: "deny", reason: "delegation_invalid" };
    }

    const subject = await this.options.subjects.resolve({
      tenant_id: input.tenant_id,
      represented_actor_id: input.represented_actor_id,
      delegation_id: input.delegation_id,
    }, signal);
    if (subject === null) {
      return { decision: "deny", reason: "identity_unavailable" };
    }
    const subjectExpiry = checkedPrivateFact(
      subject.native_subject_ref,
      subject.valid_until,
      "native subject",
    );
    if (subjectExpiry <= now) {
      return { decision: "deny", reason: "identity_unavailable" };
    }

    const permission = await this.options.permissions.check({
      native_subject_ref: subject.native_subject_ref,
      operation: input.operation,
      resource: input.resource,
    }, signal);
    checkedPrivateRef(permission.evidence_ref, "native evidence");
    if (permission.decision === "deny") {
      return { decision: "deny", reason: "permission_denied" };
    }
    const permissionExpiry = checkedTimestamp(
      permission.valid_until,
      "native permission",
    );
    if (permissionExpiry <= now) {
      return { decision: "deny", reason: "permission_denied" };
    }
    return {
      decision: "allow",
      evidence_ref: permission.evidence_ref,
      valid_until: new Date(Math.min(
        delegationExpiry,
        subjectExpiry,
        permissionExpiry,
      )).toISOString(),
    };
  }
}

export interface DocumentPlacementResolver {
  resolve(input: {
    readonly tenant_id: string;
    readonly represented_actor_id: string;
    readonly delegation_id: string;
    readonly placement: DocumentPlacementRequest | null;
    readonly signal?: AbortSignal;
  }): Promise<DocumentResourceReference>;
}

export interface DocumentResourceAdapter<ResolvedResource = unknown> {
  supports(reference: DocumentResourceReference): boolean;
  resolve(reference: DocumentResourceReference): ResolvedResource;
}

const OPERATIONS = new Set<DocumentOperation>([
  "create",
  "read",
  "update",
  "append",
  "delete",
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const POLICY_REF = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const SCOPE = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/;

function checkedPrivateRef(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) throw new TypeError(`${path} is invalid`);
  return value;
}

function checkedTimestamp(value: unknown, path: string): number {
  if (typeof value !== "string") throw new TypeError(`${path} is invalid`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${path} is invalid`);
  return parsed;
}

function checkedPrivateFact(
  reference: unknown,
  validUntil: unknown,
  path: string,
): number {
  checkedPrivateRef(reference, path);
  return checkedTimestamp(validUntil, path);
}

function exactObject(
  value: unknown,
  fields: readonly string[],
  path: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) throw new TypeError(`${path} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  ) throw new TypeError(`${path} fields are invalid`);
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) throw new TypeError(`${path}.${field} is invalid`);
    output[field] = descriptor.value;
  }
  return output;
}

function boundedIdentifier(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value ||
    !IDENTIFIER.test(value)
  ) throw new TypeError(`${path} is invalid`);
  return value;
}

function resourceUri(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) throw new TypeError("resource_uri is invalid");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("resource_uri is invalid");
  }
  if (
    parsed.protocol.length < 2 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) throw new TypeError("resource_uri is invalid");
  return value;
}

export function validateDocumentResourceReference(
  value: unknown,
): DocumentResourceReference {
  const source = exactObject(value, ["resource_uri"], "resource reference");
  return Object.freeze({
    resource_uri: resourceUri(source.resource_uri),
  });
}

export function validateDocumentPlacementRequest(
  value: unknown,
): DocumentPlacementRequest {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "resource_uri")
  ) {
    const source = exactObject(value, ["resource_uri"], "placement");
    return Object.freeze({
      resource_uri: resourceUri(source.resource_uri),
    });
  }
  const source = exactObject(value, ["policy_ref"], "placement");
  if (
    typeof source.policy_ref !== "string" ||
    source.policy_ref.length > 256 ||
    !POLICY_REF.test(source.policy_ref)
  ) throw new TypeError("placement.policy_ref is invalid");
  return Object.freeze({ policy_ref: source.policy_ref });
}

export function validateDocumentAccessRequest(
  value: unknown,
): DocumentAccessRequest {
  const source = exactObject(value, [
    "tenant_id",
    "represented_actor_id",
    "delegation_id",
    "operation",
    "resource",
    "scopes",
    "expires_at",
  ], "document access request");
  if (
    typeof source.operation !== "string" ||
    !OPERATIONS.has(source.operation as DocumentOperation)
  ) throw new TypeError("document access request operation is invalid");
  if (
    !Array.isArray(source.scopes) ||
    source.scopes.length === 0 ||
    source.scopes.length > 32 ||
    source.scopes.some((scope) =>
      typeof scope !== "string" ||
      scope.length > 128 ||
      !SCOPE.test(scope)
    )
  ) throw new TypeError("document access request scopes are invalid");
  if (
    typeof source.expires_at !== "string" ||
    !Number.isFinite(Date.parse(source.expires_at))
  ) throw new TypeError("document access request expiry is invalid");
  return Object.freeze({
    tenant_id: boundedIdentifier(source.tenant_id, "tenant_id"),
    represented_actor_id: boundedIdentifier(
      source.represented_actor_id,
      "represented_actor_id",
    ),
    delegation_id: boundedIdentifier(source.delegation_id, "delegation_id"),
    operation: source.operation as DocumentOperation,
    resource: validateDocumentResourceReference(source.resource),
    scopes: Object.freeze([...(source.scopes as string[])]),
    expires_at: source.expires_at,
  });
}
