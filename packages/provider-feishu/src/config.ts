export interface FeishuProviderCitizenConfig {
  readonly citizen_id: string;
  readonly principal_id: string;
  readonly actor_id: string;
  readonly endpoint_id: string;
  readonly registration_version: number;
}

export interface FeishuProviderConfig {
  readonly credential_ref: string;
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
  readonly shared_folder: {
    readonly token: string;
    readonly policy_ref: string;
    readonly visibility: "tenant_readable";
  };
  readonly capability_citizen: FeishuProviderCitizenConfig;
  readonly context_citizen: FeishuProviderCitizenConfig;
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

export function validateFeishuProviderConfig(
  value: unknown,
): FeishuProviderConfig {
  const source = object(value, "feishu provider", [
    "credential_ref",
    "open_api",
    "state",
    "shared_folder",
    "capability_citizen",
    "context_citizen",
  ]);
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
  const sharedFolder = object(source.shared_folder, "shared_folder", [
    "token",
    "policy_ref",
    "visibility",
  ]);
  if (sharedFolder.visibility !== "tenant_readable") {
    throw new TypeError("shared_folder.visibility is invalid");
  }
  return Object.freeze({
    credential_ref: string(source.credential_ref, "credential_ref", 255),
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
    shared_folder: Object.freeze({
      token: string(sharedFolder.token, "shared_folder.token", 512),
      policy_ref: string(
        sharedFolder.policy_ref,
        "shared_folder.policy_ref",
        256,
      ),
      visibility: "tenant_readable" as const,
    }),
    capability_citizen: citizen(
      source.capability_citizen,
      "capability_citizen",
    ),
    context_citizen: citizen(source.context_citizen, "context_citizen"),
  });
}
