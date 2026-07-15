import {
  assertFeishuAppCredentials,
  type FeishuAppCredentialProvider,
} from "./credentials.js";

export interface FeishuTenantTokenProvider {
  getToken(credentialReference: string, forceRefresh?: boolean): Promise<string>;
}

export interface FeishuTokenClock {
  nowEpochSeconds(): number;
}

export interface FeishuTenantAccessTokenProviderOptions {
  readonly credential_provider: FeishuAppCredentialProvider;
  readonly fetch: typeof globalThis.fetch;
  readonly base_url: string;
  readonly clock: FeishuTokenClock;
  readonly expiry_skew_seconds: number;
  readonly request_timeout_ms: number;
}

interface CachedToken {
  readonly value: string;
  readonly usable_until: number;
}

export class FeishuTokenError extends Error {
  constructor(readonly code: string) {
    super(`Feishu tenant token unavailable: ${code}`);
  }
}

function bounded(value: string, label: string, maximum = 255): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

export class FeishuTenantAccessTokenProvider
  implements FeishuTenantTokenProvider {
  private readonly cache = new Map<string, CachedToken>();
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly baseUrl: string;

  constructor(private readonly options: FeishuTenantAccessTokenProviderOptions) {
    this.baseUrl = new URL(options.base_url).toString().replace(/\/$/, "");
    positive(options.expiry_skew_seconds, "expiry_skew_seconds");
    positive(options.request_timeout_ms, "request_timeout_ms");
  }

  async getToken(
    credentialReference: string,
    forceRefresh = false,
  ): Promise<string> {
    bounded(credentialReference, "credential reference");
    const now = this.options.clock.nowEpochSeconds();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new FeishuTokenError("invalid_clock");
    }
    if (!forceRefresh) {
      const cached = this.cache.get(credentialReference);
      if (cached !== undefined && cached.usable_until > now) return cached.value;
    } else {
      this.cache.delete(credentialReference);
    }
    const active = this.inFlight.get(credentialReference);
    if (active !== undefined) return active;
    const request = this.fetchToken(credentialReference, now).finally(() => {
      this.inFlight.delete(credentialReference);
    });
    this.inFlight.set(credentialReference, request);
    return request;
  }

  private async fetchToken(
    credentialReference: string,
    now: number,
  ): Promise<string> {
    const credentials = await this.options.credential_provider.loadAppCredentials(
      credentialReference,
    );
    assertFeishuAppCredentials(credentials);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.request_timeout_ms,
    );
    try {
      const response = await this.options.fetch(
        `${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal/`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(credentials),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new FeishuTokenError(
          response.status === 429 || response.status >= 500
            ? "temporarily_unavailable"
            : "request_rejected",
        );
      }
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > 64_000) {
        throw new FeishuTokenError("response_too_large");
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new FeishuTokenError("invalid_response");
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new FeishuTokenError("invalid_response");
      }
      const value = body as Record<string, unknown>;
      if (
        value.code !== 0 ||
        !bounded(String(value.tenant_access_token ?? ""), "tenant token", 4_096) ||
        !Number.isSafeInteger(value.expire) ||
        (value.expire as number) <= this.options.expiry_skew_seconds
      ) {
        throw new FeishuTokenError("credential_rejected");
      }
      const token = String(value.tenant_access_token);
      this.cache.set(credentialReference, {
        value: token,
        usable_until:
          now + (value.expire as number) - this.options.expiry_skew_seconds,
      });
      return token;
    } catch (error) {
      if (error instanceof FeishuTokenError) throw error;
      throw new FeishuTokenError(
        controller.signal.aborted ? "request_timeout" : "network_failure",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
