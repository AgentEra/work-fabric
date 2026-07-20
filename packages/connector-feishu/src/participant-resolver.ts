import type {
  ConnectorIngressClaim,
  ConnectorResolvedIdentity,
} from "@work-fabric/connector-spi";

export type FeishuParticipantResolution =
  | {
      readonly kind: "resolved";
      readonly identity: ConnectorResolvedIdentity;
      readonly representation_grant?: string;
    }
  | { readonly kind: "denied"; readonly reason_code: string }
  | { readonly kind: "temporarily_unavailable"; readonly reason_code: string };

export interface FeishuParticipantResolver {
  resolve(input: {
    readonly claim: ConnectorIngressClaim;
    readonly external_subject_id: string;
    readonly external_subject_type: "human";
  }): Promise<FeishuParticipantResolution>;
}

const DENIED_REASON_CODES = new Set([
  "identity_unmapped",
  "scope_mismatch",
  "explicit_deny",
  "not_internal_member",
  "inactive_subject",
  "default_deny",
]);

const UNAVAILABLE_REASON_CODES = new Set([
  "admission_unavailable",
  "policy_unavailable",
  "evidence_unavailable",
  "store_unavailable",
  "grant_unavailable",
]);

function strictRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("participant resolution is invalid");
  }
  let actualKeys: readonly PropertyKey[];
  try {
    actualKeys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError("participant resolution is invalid");
  }
  if (
    actualKeys.length !== keys.length
    || actualKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    throw new TypeError("participant resolution is invalid");
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new TypeError("participant resolution is invalid");
    }
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError("participant resolution is invalid");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function boundedIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 255
    && value.trim() === value;
}

function participantIdentity(value: unknown): ConnectorResolvedIdentity {
  const identity = strictRecord(value, ["actor_id", "actor_type", "endpoint_id"]);
  if (
    !boundedIdentifier(identity.actor_id)
    || identity.actor_type !== "human"
    || !boundedIdentifier(identity.endpoint_id)
  ) {
    throw new TypeError("participant resolution is invalid");
  }
  return {
    actor_id: identity.actor_id,
    actor_type: "human",
    endpoint_id: identity.endpoint_id,
  };
}

function boundedCredential(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 16_384
    && value.trim() === value;
}

export function parseFeishuParticipantResolution(
  value: unknown,
): FeishuParticipantResolution {
  let discriminator: Readonly<Record<string, unknown>>;
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("participant resolution is invalid");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError("participant resolution is invalid");
    }
    discriminator = { kind: descriptor.value };
  } catch {
    throw new TypeError("participant resolution is invalid");
  }
  if (discriminator.kind === "denied") {
    const record = strictRecord(value, ["kind", "reason_code"]);
    if (typeof record.reason_code !== "string" || !DENIED_REASON_CODES.has(record.reason_code)) {
      throw new TypeError("participant resolution is invalid");
    }
    return { kind: "denied", reason_code: record.reason_code };
  }
  if (discriminator.kind === "temporarily_unavailable") {
    const record = strictRecord(value, ["kind", "reason_code"]);
    if (typeof record.reason_code !== "string" || !UNAVAILABLE_REASON_CODES.has(record.reason_code)) {
      throw new TypeError("participant resolution is invalid");
    }
    return { kind: "temporarily_unavailable", reason_code: record.reason_code };
  }
  if (discriminator.kind === "resolved") {
    let hasGrant: boolean;
    try {
      hasGrant = Object.getOwnPropertyDescriptor(value, "representation_grant") !== undefined;
    } catch {
      throw new TypeError("participant resolution is invalid");
    }
    const record = strictRecord(
      value,
      hasGrant ? ["kind", "identity", "representation_grant"] : ["kind", "identity"],
    );
    const identity = participantIdentity(record.identity);
    if (!hasGrant) return { kind: "resolved", identity };
    if (!boundedCredential(record.representation_grant)) {
      throw new TypeError("participant resolution is invalid");
    }
    return {
      kind: "resolved",
      identity,
      representation_grant: record.representation_grant,
    };
  }
  throw new TypeError("participant resolution is invalid");
}
