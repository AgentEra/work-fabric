import { isIP } from "node:net";

export type DebugParticipantConfig =
  | {
      readonly mode: "static";
      readonly external_subject_type: "human" | "agent" | "system";
      readonly external_subject_id: string;
      readonly actor_id: string;
      readonly actor_type: "human" | "agent" | "system";
      readonly endpoint_id: string;
    }
  | {
      readonly mode: "admission";
      readonly external_subject_type: "human" | "agent" | "system";
      readonly external_subject_id: string;
      readonly policy_id: string;
    };

export interface DebugHttpLimits {
  readonly max_request_bytes: number;
  readonly max_content_parts: number;
  readonly max_text_bytes: number;
  readonly max_json_depth: number;
  readonly max_page_size: number;
}

export interface DebugWorkerConfig {
  readonly poll_interval_ms: number;
  readonly lease_seconds: number;
  readonly batch_limit: number;
  readonly max_attempts: number;
}

export interface DebugPluginConfig {
  readonly connector_id: string;
  readonly external_tenant_id: string;
  readonly listen: { readonly host: string; readonly port: number };
  readonly credentials: { readonly bearer_token: string };
  readonly intake_target: {
    readonly actor_id: string;
    readonly endpoint_id: string;
  };
  readonly participants: Readonly<Record<string, DebugParticipantConfig>>;
  readonly delegation: {
    readonly scopes: readonly string[];
    readonly may_redelegate: boolean;
  };
  readonly accept_within_seconds: number;
  readonly result_due_within_seconds: number;
  readonly limits: DebugHttpLimits;
  readonly retention: {
    readonly max_age_days: number;
    readonly cleanup_batch_size: number;
  };
  readonly worker: DebugWorkerConfig;
}

function object(
  value: unknown,
  field: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${field} must be an object`);
  }
  const result = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(result);
  if (
    required.some((key) => !Object.hasOwn(result, key))
    || keys.some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    throw new TypeError(`${field} has invalid keys`);
  }
  const output: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(result, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      throw new TypeError(`${field}.${key} must be an own data property`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function id(value: unknown, field: string, maximum = 128): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value.trim() !== value
    || /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function integer(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved)
    || (resolved as number) < minimum
    || (resolved as number) > maximum
  ) {
    throw new RangeError(`${field} is outside its bound`);
  }
  return resolved as number;
}

function bool(value: unknown, field: string, fallback: boolean): boolean {
  const resolved = value ?? fallback;
  if (typeof resolved !== "boolean") throw new TypeError(`${field} is invalid`);
  return resolved;
}

function actorType(
  value: unknown,
  field: string,
): "human" | "agent" | "system" {
  if (value !== "human" && value !== "agent" && value !== "system") {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function loopback(value: unknown): string {
  const host = id(value, "listen.host", 64);
  const family = isIP(host);
  if (
    (family === 4 && !host.startsWith("127."))
    || (family === 6 && host !== "::1")
    || family === 0
  ) {
    throw new TypeError("listen.host must be a loopback IP address");
  }
  return host;
}

function scopes(value: unknown): readonly string[] {
  if (value === undefined) return ["work:read"];
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new TypeError("delegation.scopes is invalid");
  }
  const parsed = value.map((item, index) =>
    id(item, `delegation.scopes[${index}]`, 256));
  if (new Set(parsed).size !== parsed.length) {
    throw new TypeError("delegation.scopes contains duplicates");
  }
  return parsed;
}

export function validateDebugPluginConfig(value: unknown): DebugPluginConfig {
  const root = object(
    value,
    "Debug plugin config",
    [
      "connector_id",
      "external_tenant_id",
      "listen",
      "credentials",
      "intake_target",
      "participants",
      "limits",
      "retention",
    ],
    [
      "delegation",
      "accept_within_seconds",
      "result_due_within_seconds",
      "worker",
    ],
  );
  const listen = object(root.listen, "listen", ["host", "port"]);
  const credentials = object(
    root.credentials,
    "credentials",
    ["bearer_token"],
  );
  const target = object(
    root.intake_target,
    "intake_target",
    ["actor_id", "endpoint_id"],
  );
  const participantRecord = object(
    root.participants,
    "participants",
    [],
    Object.keys(root.participants as Record<string, unknown>),
  );
  const participantEntries = Object.entries(participantRecord);
  if (participantEntries.length === 0 || participantEntries.length > 100) {
    throw new RangeError("participants is outside its bound");
  }
  const participants: Record<string, DebugParticipantConfig> = {};
  const externalSubjects = new Set<string>();
  for (const [name, candidate] of participantEntries) {
    id(name, "participants key", 128);
    const modeObject = object(
      candidate,
      `participants.${name}`,
      ["mode", "external_subject_type", "external_subject_id"],
      ["actor_id", "actor_type", "endpoint_id", "policy_id"],
    );
    const externalSubjectType = actorType(
      modeObject.external_subject_type,
      `participants.${name}.external_subject_type`,
    );
    const externalSubjectId = id(
      modeObject.external_subject_id,
      `participants.${name}.external_subject_id`,
      255,
    );
    const externalKey = `${externalSubjectType}\0${externalSubjectId}`;
    if (externalSubjects.has(externalKey)) {
      throw new TypeError("duplicate external subject");
    }
    externalSubjects.add(externalKey);
    if (modeObject.mode === "static") {
      if (
        Object.hasOwn(modeObject, "policy_id")
        || !Object.hasOwn(modeObject, "actor_id")
        || !Object.hasOwn(modeObject, "actor_type")
        || !Object.hasOwn(modeObject, "endpoint_id")
      ) {
        throw new TypeError(`participants.${name} has invalid keys`);
      }
      participants[name] = {
        mode: "static",
        external_subject_type: externalSubjectType,
        external_subject_id: externalSubjectId,
        actor_id: id(modeObject.actor_id, `participants.${name}.actor_id`),
        actor_type: actorType(
          modeObject.actor_type,
          `participants.${name}.actor_type`,
        ),
        endpoint_id: id(
          modeObject.endpoint_id,
          `participants.${name}.endpoint_id`,
        ),
      };
    } else if (modeObject.mode === "admission") {
      if (
        Object.hasOwn(modeObject, "actor_id")
        || Object.hasOwn(modeObject, "actor_type")
        || Object.hasOwn(modeObject, "endpoint_id")
        || !Object.hasOwn(modeObject, "policy_id")
      ) {
        throw new TypeError(`participants.${name} has invalid keys`);
      }
      participants[name] = {
        mode: "admission",
        external_subject_type: externalSubjectType,
        external_subject_id: externalSubjectId,
        policy_id: id(
          modeObject.policy_id,
          `participants.${name}.policy_id`,
        ),
      };
    } else {
      throw new TypeError(`participants.${name}.mode is invalid`);
    }
  }
  const limits = object(root.limits, "limits", [
    "max_request_bytes",
    "max_content_parts",
    "max_text_bytes",
    "max_json_depth",
    "max_page_size",
  ]);
  const retention = object(root.retention, "retention", [
    "max_age_days",
    "cleanup_batch_size",
  ]);
  const delegation = root.delegation === undefined
    ? {}
    : object(root.delegation, "delegation", [], ["scopes", "may_redelegate"]);
  const worker = root.worker === undefined
    ? {}
    : object(root.worker, "worker", [], [
      "poll_interval_ms",
      "lease_seconds",
      "batch_limit",
      "max_attempts",
    ]);
  return {
    connector_id: id(root.connector_id, "connector_id"),
    external_tenant_id: id(root.external_tenant_id, "external_tenant_id", 255),
    listen: {
      host: loopback(listen.host),
      port: integer(listen.port, "listen.port", 8791, 1, 65_535),
    },
    credentials: {
      bearer_token: id(credentials.bearer_token, "credentials.bearer_token", 4096),
    },
    intake_target: {
      actor_id: id(target.actor_id, "intake_target.actor_id"),
      endpoint_id: id(target.endpoint_id, "intake_target.endpoint_id"),
    },
    participants,
    delegation: {
      scopes: scopes(delegation.scopes),
      may_redelegate: bool(
        delegation.may_redelegate,
        "delegation.may_redelegate",
        false,
      ),
    },
    accept_within_seconds: integer(
      root.accept_within_seconds,
      "accept_within_seconds",
      86_400,
      60,
      604_800,
    ),
    result_due_within_seconds: integer(
      root.result_due_within_seconds,
      "result_due_within_seconds",
      604_800,
      60,
      2_592_000,
    ),
    limits: {
      max_request_bytes: integer(
        limits.max_request_bytes,
        "limits.max_request_bytes",
        262_144,
        1024,
        4_194_304,
      ),
      max_content_parts: integer(
        limits.max_content_parts,
        "limits.max_content_parts",
        32,
        1,
        128,
      ),
      max_text_bytes: integer(
        limits.max_text_bytes,
        "limits.max_text_bytes",
        131_072,
        1,
        1_048_576,
      ),
      max_json_depth: integer(
        limits.max_json_depth,
        "limits.max_json_depth",
        32,
        1,
        64,
      ),
      max_page_size: integer(
        limits.max_page_size,
        "limits.max_page_size",
        100,
        1,
        100,
      ),
    },
    retention: {
      max_age_days: integer(
        retention.max_age_days,
        "retention.max_age_days",
        14,
        1,
        365,
      ),
      cleanup_batch_size: integer(
        retention.cleanup_batch_size,
        "retention.cleanup_batch_size",
        500,
        1,
        10_000,
      ),
    },
    worker: {
      poll_interval_ms: integer(
        worker.poll_interval_ms,
        "worker.poll_interval_ms",
        100,
        10,
        60_000,
      ),
      lease_seconds: integer(
        worker.lease_seconds,
        "worker.lease_seconds",
        30,
        5,
        300,
      ),
      batch_limit: integer(
        worker.batch_limit,
        "worker.batch_limit",
        100,
        1,
        1000,
      ),
      max_attempts: integer(
        worker.max_attempts,
        "worker.max_attempts",
        8,
        1,
        100,
      ),
    },
  };
}

export function debugSecretPaths(
  prefix: string,
  _config: DebugPluginConfig,
): readonly string[] {
  id(prefix, "secret path prefix", 1024);
  return [`${prefix}.credentials.bearer_token`];
}
