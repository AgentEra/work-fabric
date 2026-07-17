export interface FeishuPluginIdentity {
  readonly external_open_id: string;
  readonly actor_id: string;
  readonly actor_type: "human" | "agent" | "system";
  readonly endpoint_id: string;
}
export interface FeishuStaticChannelConfig {
  readonly receive_id_type: "chat_id" | "open_id" | "user_id" | "union_id" | "email";
  readonly receive_id: string;
  readonly render_mode?: "text" | "card";
}
export interface FeishuStaticSubscriptionConfig {
  readonly channel_ref: string;
  readonly owner: {
    readonly actor_id: string;
    readonly actor_type: "human" | "agent" | "system";
    readonly endpoint_id: string;
  };
  readonly filter: {
    readonly event_types: readonly string[];
    readonly actor_ids: readonly string[];
    readonly endpoint_ids: readonly string[];
    readonly thread_ids: readonly string[];
    readonly handoff_ids: readonly string[];
    readonly work_reference_uris: readonly string[];
    readonly capability_ids: readonly string[];
    readonly lifecycle_states: readonly string[];
  };
}
export interface FeishuPluginConfig {
  readonly connector_id: string;
  readonly external_tenant_id: string;
  readonly bot_open_id: string;
  readonly credentials: {
    readonly app_id: string; readonly app_secret: string; readonly verification_token: string;
    readonly encrypt_key?: string; readonly work_fabric_access_token: string;
  };
  readonly inbound: {
    readonly enabled: boolean; readonly transport: "webhook"; readonly route_id: string;
    readonly mention_only: true; readonly intake_target: { readonly actor_id: string; readonly endpoint_id: string };
    readonly accept_within_seconds: number; readonly result_due_within_seconds: number;
  };
  readonly outbound: {
    readonly enabled: boolean; readonly default_render_mode: "text" | "card";
    readonly channels: Readonly<Record<string, FeishuStaticChannelConfig>>;
    readonly subscriptions: Readonly<Record<string, FeishuStaticSubscriptionConfig>>;
  };
  readonly identities: readonly FeishuPluginIdentity[];
  readonly worker: { readonly poll_interval_ms: number; readonly lease_seconds: number; readonly batch_limit: number; readonly max_attempts: number };
}

function object(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  const result = value as Record<string, unknown>;
  const unknown = Object.keys(result).find((key) => !keys.includes(key));
  if (unknown !== undefined) throw new TypeError(`${field} contains unknown key ${unknown}`);
  return result;
}
function id(value: unknown, field: string, maximum = 255): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim() !== value) throw new TypeError(`${field} is invalid`);
  return value;
}
function bool(value: unknown, field: string): boolean { if (typeof value !== "boolean") throw new TypeError(`${field} is invalid`); return value; }
function integer(value: unknown, field: string, fallback: number, max: number): number { const n = value ?? fallback; if (!Number.isSafeInteger(n) || (n as number) <= 0 || (n as number) > max) throw new RangeError(`${field} is outside its bound`); return n as number; }
function namedRecord(value: unknown, field: string, maximum: number): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length > maximum) throw new RangeError(`${field} exceeds its bound`);
  for (const key of Object.keys(result)) id(key, `${field} key`, 128);
  return result;
}
function stringList(value: unknown, field: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new TypeError(`${field} is invalid`);
  const result = value.map((item, index) => id(item, `${field}[${index}]`, 512));
  if (new Set(result).size !== result.length) throw new TypeError(`${field} contains duplicates`);
  return result;
}

export function validateFeishuPluginConfig(value: unknown): FeishuPluginConfig {
  const root = object(value, "Feishu plugin config", ["connector_id", "external_tenant_id", "bot_open_id", "credentials", "inbound", "outbound", "identities", "worker"]);
  const credentials = object(root.credentials, "credentials", ["app_id", "app_secret", "verification_token", "encrypt_key", "work_fabric_access_token"]);
  const inbound = object(root.inbound, "inbound", ["enabled", "transport", "route_id", "mention_only", "intake_target", "accept_within_seconds", "result_due_within_seconds"]);
  const target = object(inbound.intake_target, "inbound.intake_target", ["actor_id", "endpoint_id"]);
  if (inbound.transport !== "webhook") throw new TypeError("inbound.transport is invalid");
  if (inbound.mention_only !== true) throw new TypeError("inbound.mention_only must be true");
  const outbound = object(root.outbound, "outbound", ["enabled", "default_render_mode", "channels", "subscriptions"]);
  if (outbound.default_render_mode !== "text" && outbound.default_render_mode !== "card") throw new TypeError("outbound.default_render_mode is invalid");
  const channels = Object.fromEntries(Object.entries(namedRecord(outbound.channels ?? {}, "outbound.channels", 100)).map(([name, candidate]) => {
    const item = object(candidate, `outbound.channels.${name}`, ["receive_id_type", "receive_id", "render_mode"]);
    if (item.receive_id_type !== "chat_id" && item.receive_id_type !== "open_id" && item.receive_id_type !== "user_id" && item.receive_id_type !== "union_id" && item.receive_id_type !== "email") throw new TypeError(`outbound.channels.${name}.receive_id_type is invalid`);
    if (item.render_mode !== undefined && item.render_mode !== "text" && item.render_mode !== "card") throw new TypeError(`outbound.channels.${name}.render_mode is invalid`);
    return [name, { receive_id_type: item.receive_id_type, receive_id: id(item.receive_id, `outbound.channels.${name}.receive_id`), ...(item.render_mode === undefined ? {} : { render_mode: item.render_mode }) } satisfies FeishuStaticChannelConfig];
  }));
  const subscriptions = Object.fromEntries(Object.entries(namedRecord(outbound.subscriptions ?? {}, "outbound.subscriptions", 100)).map(([name, candidate]) => {
    const item = object(candidate, `outbound.subscriptions.${name}`, ["channel_ref", "owner", "filter"]);
    const channelRef = id(item.channel_ref, `outbound.subscriptions.${name}.channel_ref`, 128);
    if (channels[channelRef] === undefined) throw new TypeError(`outbound.subscriptions.${name}.channel_ref is unknown`);
    const owner = object(item.owner, `outbound.subscriptions.${name}.owner`, ["actor_id", "actor_type", "endpoint_id"]);
    if (owner.actor_type !== "human" && owner.actor_type !== "agent" && owner.actor_type !== "system") throw new TypeError(`outbound.subscriptions.${name}.owner.actor_type is invalid`);
    const filter = object(item.filter ?? {}, `outbound.subscriptions.${name}.filter`, ["event_types", "actor_ids", "endpoint_ids", "thread_ids", "handoff_ids", "work_reference_uris", "capability_ids", "lifecycle_states"]);
    return [name, {
      channel_ref: channelRef,
      owner: { actor_id: id(owner.actor_id, `outbound.subscriptions.${name}.owner.actor_id`, 128), actor_type: owner.actor_type, endpoint_id: id(owner.endpoint_id, `outbound.subscriptions.${name}.owner.endpoint_id`, 128) },
      filter: {
        event_types: stringList(filter.event_types, `outbound.subscriptions.${name}.filter.event_types`), actor_ids: stringList(filter.actor_ids, `outbound.subscriptions.${name}.filter.actor_ids`), endpoint_ids: stringList(filter.endpoint_ids, `outbound.subscriptions.${name}.filter.endpoint_ids`), thread_ids: stringList(filter.thread_ids, `outbound.subscriptions.${name}.filter.thread_ids`), handoff_ids: stringList(filter.handoff_ids, `outbound.subscriptions.${name}.filter.handoff_ids`), work_reference_uris: stringList(filter.work_reference_uris, `outbound.subscriptions.${name}.filter.work_reference_uris`), capability_ids: stringList(filter.capability_ids, `outbound.subscriptions.${name}.filter.capability_ids`), lifecycle_states: stringList(filter.lifecycle_states, `outbound.subscriptions.${name}.filter.lifecycle_states`),
      },
    } satisfies FeishuStaticSubscriptionConfig];
  }));
  if (!Array.isArray(root.identities) || root.identities.length > 500) throw new TypeError("identities is invalid");
  const identities = root.identities.map((entry, index): FeishuPluginIdentity => {
    const item = object(entry, `identities[${index}]`, ["external_open_id", "actor_id", "actor_type", "endpoint_id"]);
    if (item.actor_type !== "human" && item.actor_type !== "agent" && item.actor_type !== "system") throw new TypeError(`identities[${index}].actor_type is invalid`);
    return { external_open_id: id(item.external_open_id, `identities[${index}].external_open_id`), actor_id: id(item.actor_id, `identities[${index}].actor_id`, 128), actor_type: item.actor_type, endpoint_id: id(item.endpoint_id, `identities[${index}].endpoint_id`, 128) };
  });
  if (new Set(identities.map((item) => item.external_open_id)).size !== identities.length) throw new TypeError("duplicate identity mapping");
  const worker = object(root.worker, "worker", ["poll_interval_ms", "lease_seconds", "batch_limit", "max_attempts"]);
  return {
    connector_id: id(root.connector_id, "connector_id", 128), external_tenant_id: id(root.external_tenant_id, "external_tenant_id"), bot_open_id: id(root.bot_open_id, "bot_open_id"),
    credentials: {
      app_id: id(credentials.app_id, "credentials.app_id", 512), app_secret: id(credentials.app_secret, "credentials.app_secret", 512), verification_token: id(credentials.verification_token, "credentials.verification_token", 512),
      ...(credentials.encrypt_key === undefined ? {} : { encrypt_key: id(credentials.encrypt_key, "credentials.encrypt_key", 512) }),
      work_fabric_access_token: id(credentials.work_fabric_access_token, "credentials.work_fabric_access_token", 2048),
    },
    inbound: { enabled: bool(inbound.enabled, "inbound.enabled"), transport: "webhook", route_id: id(inbound.route_id, "inbound.route_id", 128), mention_only: true, intake_target: { actor_id: id(target.actor_id, "inbound.intake_target.actor_id", 128), endpoint_id: id(target.endpoint_id, "inbound.intake_target.endpoint_id", 128) }, accept_within_seconds: integer(inbound.accept_within_seconds, "inbound.accept_within_seconds", 86_400, 2_592_000), result_due_within_seconds: integer(inbound.result_due_within_seconds, "inbound.result_due_within_seconds", 604_800, 31_536_000) },
    outbound: { enabled: bool(outbound.enabled, "outbound.enabled"), default_render_mode: outbound.default_render_mode, channels, subscriptions },
    identities,
    worker: { poll_interval_ms: integer(worker.poll_interval_ms, "worker.poll_interval_ms", 1000, 60_000), lease_seconds: integer(worker.lease_seconds, "worker.lease_seconds", 30, 3600), batch_limit: integer(worker.batch_limit, "worker.batch_limit", 100, 1000), max_attempts: integer(worker.max_attempts, "worker.max_attempts", 8, 100) },
  };
}

export function feishuSecretPaths(base: string, config: FeishuPluginConfig): readonly string[] {
  const fields = ["app_id", "app_secret", "verification_token", ...(config.credentials.encrypt_key === undefined ? [] : ["encrypt_key"]), "work_fabric_access_token"];
  return fields.map((field) => `${base}.credentials.${field}`);
}
