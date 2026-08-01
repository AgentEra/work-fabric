export interface FeishuProviderCitizenConfig {
  readonly citizen_id: string;
  readonly principal_id: string;
  readonly actor_id: string;
  readonly endpoint_id: string;
  readonly registration_version: number;
}

export type FeishuProviderFacetConfig =
  | { readonly enabled: false }
  | ({ readonly enabled: true } & FeishuProviderCitizenConfig);

interface FeishuProviderBaseConfig {
  readonly credential_ref: string;
  readonly cursor_signing_key?: string;
  readonly open_api: {
    readonly base_url: string;
    readonly request_timeout_ms: number;
    readonly max_response_bytes: number;
  };
  readonly state:
    | { readonly type: "memory" }
    | {
        readonly type: "sqlite";
        readonly location: string;
        readonly busy_timeout_ms: number;
      };
  readonly context_citizen: FeishuProviderCitizenConfig;
}

export type FeishuProviderConfig = FeishuProviderBaseConfig & (
  | {
      readonly capability_citizen: FeishuProviderCitizenConfig;
      readonly message_citizen?: never;
      readonly document_citizen?: never;
      readonly calendar_citizen?: never;
    }
  | {
      readonly capability_citizen?: never;
      readonly message_citizen: FeishuProviderFacetConfig;
      readonly document_citizen: FeishuProviderFacetConfig;
      readonly calendar_citizen?: FeishuProviderFacetConfig;
    }
);

export interface EnabledFeishuProviderFacet {
  readonly facet: "aggregate" | "message" | "document" | "calendar";
  readonly citizen: FeishuProviderCitizenConfig;
}

export function enabledFeishuProviderFacets(
  config: FeishuProviderConfig,
): readonly EnabledFeishuProviderFacet[] {
  if (config.capability_citizen !== undefined) {
    return Object.freeze([Object.freeze({
      facet: "aggregate" as const,
      citizen: config.capability_citizen,
    })]);
  }
  return Object.freeze([
    ...(config.message_citizen.enabled
      ? [Object.freeze({
          facet: "message" as const,
          citizen: config.message_citizen,
        })]
      : []),
    ...(config.document_citizen.enabled
      ? [Object.freeze({
          facet: "document" as const,
          citizen: config.document_citizen,
        })]
      : []),
    ...(config.calendar_citizen?.enabled
      ? [Object.freeze({
          facet: "calendar" as const,
          citizen: config.calendar_citizen,
        })]
      : []),
  ]);
}

function object(
  value: unknown,
  path: string,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) throw new TypeError(`${path} must be an object`);
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => !fields.includes(key))) {
    throw new TypeError(`${path} contains an unsupported field`);
  }
  return source;
}

function string(value: unknown, path: string, maximum = 512): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value
  ) throw new TypeError(`${path} is invalid`);
  return value;
}

function positive(value: unknown, path: string, maximum: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  ) throw new RangeError(`${path} is invalid`);
  return value as number;
}

function citizen(value: unknown, path: string): FeishuProviderCitizenConfig {
  const source = object(value, path, [
    "citizen_id",
    "principal_id",
    "actor_id",
    "endpoint_id",
    "registration_version",
  ]);
  return Object.freeze({
    citizen_id: string(source.citizen_id, `${path}.citizen_id`, 128),
    principal_id: string(source.principal_id, `${path}.principal_id`, 128),
    actor_id: string(source.actor_id, `${path}.actor_id`, 128),
    endpoint_id: string(source.endpoint_id, `${path}.endpoint_id`, 128),
    registration_version: positive(
      source.registration_version,
      `${path}.registration_version`,
      Number.MAX_SAFE_INTEGER,
    ),
  });
}

function facet(value: unknown, path: string): FeishuProviderFacetConfig {
  const source = object(value, path, [
    "enabled",
    "citizen_id",
    "principal_id",
    "actor_id",
    "endpoint_id",
    "registration_version",
  ]);
  if (source.enabled === false) {
    if (Object.keys(source).length !== 1) {
      throw new TypeError(`${path} disabled facet contains an unsupported field`);
    }
    return Object.freeze({ enabled: false });
  }
  if (source.enabled !== true) {
    throw new TypeError(`${path}.enabled is invalid`);
  }
  const { enabled: _enabled, ...identity } = source;
  return Object.freeze({
    enabled: true,
    ...citizen(identity, path),
  });
}

export function validateFeishuProviderConfig(
  value: unknown,
): FeishuProviderConfig {
  const source = object(value, "feishu provider", [
    "credential_ref",
    "cursor_signing_key",
    "open_api",
    "state",
    "capability_citizen",
    "message_citizen",
    "document_citizen",
    "calendar_citizen",
    "context_citizen",
  ]);
  const hasLegacy = source.capability_citizen !== undefined;
  const hasMessageFacet = source.message_citizen !== undefined;
  const hasDocumentFacet = source.document_citizen !== undefined;
  const hasCalendarFacet = source.calendar_citizen !== undefined;
  if (hasLegacy && (hasMessageFacet || hasDocumentFacet || hasCalendarFacet)) {
    throw new TypeError(
      "legacy capability_citizen cannot be combined with Provider facets",
    );
  }
  if (!hasLegacy && (!hasMessageFacet || !hasDocumentFacet)) {
    throw new TypeError(
      "message_citizen and document_citizen Provider facets are required",
    );
  }
  const api = object(source.open_api, "open_api", [
    "base_url",
    "request_timeout_ms",
    "max_response_bytes",
  ]);
  const baseUrl = new URL(string(api.base_url, "open_api.base_url", 2_048));
  if (baseUrl.protocol !== "https:" && baseUrl.hostname !== "127.0.0.1") {
    throw new TypeError("open_api.base_url must use HTTPS");
  }
  const state = object(source.state, "state", [
    "type",
    "location",
    "busy_timeout_ms",
  ]);
  let normalizedState: FeishuProviderConfig["state"];
  if (state.type === "memory") {
    if (Object.keys(state).length !== 1) {
      throw new TypeError("memory state contains an unsupported field");
    }
    normalizedState = Object.freeze({ type: "memory" });
  } else if (state.type === "sqlite") {
    normalizedState = Object.freeze({
      type: "sqlite",
      location: string(state.location, "state.location", 4_096),
      busy_timeout_ms: positive(
        state.busy_timeout_ms,
        "state.busy_timeout_ms",
        60_000,
      ),
    });
  } else {
    throw new TypeError("state.type is invalid");
  }
  const shared = {
    credential_ref: string(source.credential_ref, "credential_ref", 255),
    ...(source.cursor_signing_key === undefined
      ? {}
      : {
          cursor_signing_key: string(
            source.cursor_signing_key,
            "cursor_signing_key",
            1_024,
          ),
        }),
    open_api: Object.freeze({
      base_url: baseUrl.toString().replace(/\/$/, ""),
      request_timeout_ms: positive(
        api.request_timeout_ms,
        "open_api.request_timeout_ms",
        120_000,
      ),
      max_response_bytes: positive(
        api.max_response_bytes,
        "open_api.max_response_bytes",
        1_048_576,
      ),
    }),
    state: normalizedState,
    context_citizen: citizen(source.context_citizen, "context_citizen"),
  };
  if (hasLegacy) {
    return Object.freeze({
      ...shared,
      capability_citizen: citizen(
        source.capability_citizen,
        "capability_citizen",
      ),
    });
  }
  const message = facet(source.message_citizen, "message_citizen");
  const document = facet(source.document_citizen, "document_citizen");
  const calendar = source.calendar_citizen === undefined
    ? undefined
    : facet(source.calendar_citizen, "calendar_citizen");
  if (!message.enabled && !document.enabled && !calendar?.enabled) {
    throw new TypeError("at least one Feishu Provider facet must be enabled");
  }
  const enabledFacets = [message, document, calendar].filter(
    (candidate): candidate is Extract<
      FeishuProviderFacetConfig,
      { readonly enabled: true }
    > => candidate?.enabled === true,
  );
  if (
    new Set(enabledFacets.map((candidate) => candidate.citizen_id)).size !==
      enabledFacets.length
  ) {
    throw new TypeError("enabled Feishu Provider facets have duplicate Citizen IDs");
  }
  const context = shared.context_citizen;
  if (enabledFacets.some((candidate) =>
    candidate.citizen_id === context.citizen_id
  )) {
    throw new TypeError("Feishu Provider Citizen IDs are duplicate");
  }
  if (message.enabled && shared.cursor_signing_key === undefined) {
    throw new TypeError(
      "cursor_signing_key is required when message_citizen is enabled",
    );
  }
  return Object.freeze({
    ...shared,
    message_citizen: message,
    document_citizen: document,
    ...(calendar === undefined ? {} : { calendar_citizen: calendar }),
  });
}
