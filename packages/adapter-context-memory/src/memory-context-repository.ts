import { isDeepStrictEqual } from "node:util";

import type {
  CapabilityManifest,
  ContextAccessRequest,
  ContextAvailability,
  ContextReadResult,
  ContextReference,
  ContextRepository,
  JsonObject,
  JsonValue,
} from "@work-fabric/exchange-spi";

interface StoredBundle {
  readonly bundle: JsonObject;
  readonly reference: ContextReference;
  readonly actorIds: readonly string[];
  readonly endpointIds: readonly string[];
  readonly expiresAt: string | null;
}

const manifest: CapabilityManifest = {
  profile: "exchange.context.v1",
  adapter: "memory",
  capabilities: {
    immutable_versions: true,
    digest_verification: true,
    visibility_enforcement: true,
  },
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function key(tenantId: string, contextId: string, version: number): string {
  return JSON.stringify([tenantId, contextId, version]);
}

function requiredString(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requiredVersion(value: JsonValue | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new TypeError("version must be a positive integer");
  }
  return value;
}

function normalizedDigest(value: JsonValue | undefined): string | null {
  if (value === null) {
    return null;
  }
  if (!isJsonObject(value)) {
    throw new TypeError("digest must be a WFPP Digest object or null");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "algorithm" || keys[1] !== "value") {
    throw new TypeError("digest must contain exactly algorithm and value");
  }
  const algorithm = requiredString(value.algorithm, "digest.algorithm");
  if (!new Set(["sha-256", "sha-384", "sha-512"]).has(algorithm)) {
    throw new TypeError("digest.algorithm must be a WFPP digest algorithm");
  }
  const digestValue = requiredString(value.value, "digest.value");
  return `${algorithm}:${digestValue}`;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonObject(value: JsonValue | undefined, field: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function stringArray(value: JsonValue | undefined, field: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(`${field} must be an array of strings`);
  }
  return value;
}

function expiry(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("visibility_scope.expires_at must be a timestamp or null");
  }
  return value;
}

export interface MemoryContextRepositoryOptions {
  readonly now?: () => string;
}

export class MemoryContextRepository implements ContextRepository {
  private readonly bundles = new Map<string, StoredBundle>();
  private readonly now: () => string;

  constructor(options: MemoryContextRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get manifest(): CapabilityManifest {
    return clone(manifest);
  }

  async putBundle(
    tenantId: string,
    bundle: JsonObject,
  ): Promise<ContextReference> {
    const clonedBundle = clone(bundle);
    const contextId = requiredString(clonedBundle.context_id, "context_id");
    const version = requiredVersion(clonedBundle.version);
    const digest = normalizedDigest(clonedBundle.digest);
    const visibility = jsonObject(
      clonedBundle.visibility_scope,
      "visibility_scope",
    );
    const actorIds = stringArray(
      visibility.actor_ids,
      "visibility_scope.actor_ids",
    );
    const endpointIds = stringArray(
      visibility.endpoint_ids,
      "visibility_scope.endpoint_ids",
    );
    const expiresAt = expiry(visibility.expires_at);
    const bundleKey = key(tenantId, contextId, version);
    const existing = this.bundles.get(bundleKey);
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing.bundle, clonedBundle)) {
        throw new Error(
          `Context ${contextId} version ${version} is immutable and has a different body`,
        );
      }
      return clone(existing.reference);
    }

    const reference: ContextReference = {
      context_id: contextId,
      version,
      digest,
    };
    this.bundles.set(bundleKey, {
      bundle: clonedBundle,
      reference,
      actorIds: clone(actorIds),
      endpointIds: clone(endpointIds),
      expiresAt,
    });
    return clone(reference);
  }

  private lookup(request: ContextAccessRequest):
    | { readonly kind: "available"; readonly stored: StoredBundle }
    | { readonly kind: "unavailable"; readonly reason: string } {
    const clonedRequest = clone(request);
    if (clonedRequest.reference === null) {
      return { kind: "unavailable", reason: "Context reference is required" };
    }
    const reference = clonedRequest.reference;
    const stored = this.bundles.get(
      key(clonedRequest.tenant_id, reference.context_id, reference.version),
    );
    if (stored === undefined) {
      return { kind: "unavailable", reason: "Context version was not found" };
    }
    if (
      reference.digest !== null &&
      reference.digest !== stored.reference.digest
    ) {
      return { kind: "unavailable", reason: "Context digest does not match" };
    }
    if (stored.expiresAt !== null) {
      const current = Date.parse(this.now());
      if (!Number.isFinite(current)) {
        throw new TypeError("Context repository clock is invalid");
      }
      if (Date.parse(stored.expiresAt) <= current) {
        return { kind: "unavailable", reason: "Context has expired" };
      }
    }
    if (stored.actorIds.length === 0 && stored.endpointIds.length === 0) {
      return { kind: "unavailable", reason: "Context declares no audience" };
    }
    if (
      stored.actorIds.length > 0 &&
      !stored.actorIds.includes(clonedRequest.actor_id)
    ) {
      return { kind: "unavailable", reason: "Actor is outside the Context audience" };
    }
    if (
      stored.endpointIds.length > 0 &&
      !stored.endpointIds.includes(clonedRequest.endpoint_id)
    ) {
      return {
        kind: "unavailable",
        reason: "Endpoint is outside the Context audience",
      };
    }
    return { kind: "available", stored };
  }

  async checkAvailability(
    request: ContextAccessRequest,
  ): Promise<ContextAvailability> {
    if (request.reference === null) return { kind: "available" };
    const result = this.lookup(request);
    if (result.kind === "unavailable") return result;
    return { kind: "available" };
  }

  async readBundle(request: ContextAccessRequest): Promise<ContextReadResult> {
    const result = this.lookup(request);
    if (result.kind === "unavailable") return result;
    return { kind: "available", bundle: clone(result.stored.bundle) };
  }
}
