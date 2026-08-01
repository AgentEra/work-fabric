import type { ExchangeAdapter } from "./capabilities.js";
import type { JsonObject } from "./json.js";

export const CONTEXT_REQUIRED_CAPABILITIES = [
  "immutable_versions",
  "digest_verification",
  "visibility_enforcement",
] as const;

export interface ContextReference {
  readonly context_id: string;
  readonly version: number;
  readonly digest: string | null;
}

export interface ContextAccessRequest {
  readonly tenant_id: string;
  readonly actor_id: string;
  readonly endpoint_id: string;
  readonly reference: ContextReference | null;
}

export type ContextAvailability =
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly reason: string };

export type ContextReadResult =
  | { readonly kind: "available"; readonly bundle: JsonObject }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface ContextRepository extends ExchangeAdapter {
  putBundle(tenantId: string, bundle: JsonObject): Promise<ContextReference>;
  checkAvailability(request: ContextAccessRequest): Promise<ContextAvailability>;
  readBundle(request: ContextAccessRequest): Promise<ContextReadResult>;
}
