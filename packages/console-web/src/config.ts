export interface ConsoleRuntimeConfig {
  readonly baseUrl: string;
  readonly tenantId: string;
  readonly exchangeId: string;
  readonly actorId: string;
  readonly endpointId: string;
  /** Existing authenticated subscription used only to invalidate SDK queries. */
  readonly invalidationSubscriptionId?: string;
}

declare global {
  interface Window {
    __WORK_FABRIC_AUTH__?: () => string | Promise<string>;
    __WORK_FABRIC_CONFIG__?: ConsoleRuntimeConfig;
  }
}

function bounded(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

export function validateConsoleConfig(input: unknown): ConsoleRuntimeConfig {
  if (typeof input !== "object" || input === null) throw new TypeError("runtime config is missing");
  const value = input as Record<string, unknown>;
  const baseUrl = bounded(value.baseUrl, "baseUrl");
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("baseUrl is unsafe");
  }
  return {
    baseUrl,
    tenantId: bounded(value.tenantId, "tenantId"),
    exchangeId: bounded(value.exchangeId, "exchangeId"),
    actorId: bounded(value.actorId, "actorId"),
    endpointId: bounded(value.endpointId, "endpointId"),
    ...(value.invalidationSubscriptionId === undefined
      ? {}
      : { invalidationSubscriptionId: bounded(value.invalidationSubscriptionId, "invalidationSubscriptionId") }),
  };
}

export async function loadConsoleConfig(): Promise<ConsoleRuntimeConfig> {
  if (window.__WORK_FABRIC_CONFIG__ !== undefined) {
    return validateConsoleConfig(window.__WORK_FABRIC_CONFIG__);
  }
  const response = await fetch("/work-fabric-config.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Console runtime configuration is unavailable");
  return validateConsoleConfig(await response.json());
}
