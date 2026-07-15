import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import type { JsonObject } from "@work-fabric/exchange-spi";
import { compareUtcTimestamps, parseUtcTimestamp } from "@work-fabric/exchange-spi";

const PREFIX = "wfaf1.";
const AAD = Buffer.from("work-fabric.feishu.action.v1", "utf8");
const ACTIONS = new Set([
  "handoff.accept",
  "handoff.decline",
  "handoff.verify",
  "handoff.request_rework",
  "handoff.report_status",
  "handoff.return_result",
]);

export interface FeishuActionReferenceClaims {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly external_tenant_id: string;
  readonly external_subject_id: string;
  readonly operation: string;
  readonly expected_version: number;
  readonly input: JsonObject;
  readonly expires_at: string;
}

export interface FeishuActionReferenceScope {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly external_tenant_id: string;
  readonly external_subject_id: string;
  readonly now: string;
}

export interface FeishuActionReferenceCodecOptions {
  readonly encryption_key: Uint8Array;
  readonly nonce_factory?: () => Uint8Array;
  readonly max_reference_length?: number;
}

export class FeishuActionReferenceError extends Error {
  constructor(
    readonly code: "invalid" | "scope_mismatch" | "expired" | "unsupported_action",
  ) {
    super(
      code === "scope_mismatch"
        ? "Feishu action reference scope mismatch"
        : code === "expired"
          ? "Feishu action reference expired"
          : code === "unsupported_action"
            ? "Feishu action reference contains an unsupported action"
            : "Feishu action reference is invalid",
    );
  }
}

function bounded(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    value.trim() === value
  );
}

function validateClaims(value: unknown): FeishuActionReferenceClaims {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FeishuActionReferenceError("invalid");
  }
  const claims = value as Record<string, unknown>;
  const keys = [
    "tenant_id",
    "connector_id",
    "external_tenant_id",
    "external_subject_id",
    "operation",
    "expected_version",
    "input",
    "expires_at",
  ];
  if (
    Object.keys(claims).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(claims, key)) ||
    !bounded(claims.tenant_id) ||
    !bounded(claims.connector_id) ||
    !bounded(claims.external_tenant_id) ||
    !bounded(claims.external_subject_id) ||
    !bounded(claims.operation) ||
    !ACTIONS.has(claims.operation) ||
    !Number.isSafeInteger(claims.expected_version) ||
    (claims.expected_version as number) <= 0 ||
    claims.input === null ||
    typeof claims.input !== "object" ||
    Array.isArray(claims.input) ||
    !bounded(claims.expires_at)
  ) {
    throw new FeishuActionReferenceError(
      typeof claims.operation === "string" && !ACTIONS.has(claims.operation)
        ? "unsupported_action"
        : "invalid",
    );
  }
  try {
    parseUtcTimestamp(claims.expires_at, "expires_at");
  } catch {
    throw new FeishuActionReferenceError("invalid");
  }
  return structuredClone(claims) as unknown as FeishuActionReferenceClaims;
}

export class FeishuActionReferenceCodec {
  private readonly key: Buffer;
  private readonly nonceFactory: () => Uint8Array;
  private readonly maximumLength: number;

  constructor(options: FeishuActionReferenceCodecOptions) {
    if (options.encryption_key.byteLength !== 32) {
      throw new TypeError("Feishu action encryption key must contain 32 bytes");
    }
    this.key = Buffer.from(options.encryption_key);
    this.nonceFactory = options.nonce_factory ?? (() => randomBytes(12));
    this.maximumLength = options.max_reference_length ?? 2_048;
    if (!Number.isSafeInteger(this.maximumLength) || this.maximumLength <= 0) {
      throw new RangeError("max_reference_length must be positive");
    }
  }

  issue(input: FeishuActionReferenceClaims): string {
    const claims = validateClaims(input);
    const nonce = Buffer.from(this.nonceFactory());
    if (nonce.byteLength !== 12) {
      throw new TypeError("Feishu action nonce must contain 12 bytes");
    }
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(claims), "utf8"),
      cipher.final(),
    ]);
    const token = `${PREFIX}${Buffer.concat([
      nonce,
      ciphertext,
      cipher.getAuthTag(),
    ]).toString("base64url")}`;
    if (token.length > this.maximumLength) {
      throw new RangeError("Feishu action reference exceeds its configured limit");
    }
    return token;
  }

  resolve(
    reference: string,
    scope: FeishuActionReferenceScope,
  ): FeishuActionReferenceClaims {
    if (
      typeof reference !== "string" ||
      !reference.startsWith(PREFIX) ||
      reference.length > this.maximumLength
    ) {
      throw new FeishuActionReferenceError("invalid");
    }
    let claims: FeishuActionReferenceClaims;
    try {
      const encoded = reference.slice(PREFIX.length);
      const packed = Buffer.from(encoded, "base64url");
      if (packed.toString("base64url") !== encoded || packed.byteLength <= 28) {
        throw new Error("non-canonical action reference");
      }
      const nonce = packed.subarray(0, 12);
      const tag = packed.subarray(packed.length - 16);
      const ciphertext = packed.subarray(12, packed.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
      decipher.setAAD(AAD);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf8");
      claims = validateClaims(JSON.parse(plaintext));
    } catch (error) {
      if (error instanceof FeishuActionReferenceError) throw error;
      throw new FeishuActionReferenceError("invalid");
    }
    if (
      claims.tenant_id !== scope.tenant_id ||
      claims.connector_id !== scope.connector_id ||
      claims.external_tenant_id !== scope.external_tenant_id ||
      claims.external_subject_id !== scope.external_subject_id
    ) {
      throw new FeishuActionReferenceError("scope_mismatch");
    }
    try {
      parseUtcTimestamp(scope.now, "now");
    } catch {
      throw new FeishuActionReferenceError("invalid");
    }
    if (compareUtcTimestamps(claims.expires_at, scope.now) <= 0) {
      throw new FeishuActionReferenceError("expired");
    }
    return structuredClone(claims);
  }
}
