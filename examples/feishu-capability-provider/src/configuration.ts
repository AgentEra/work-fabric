import { YamlConfigurationProvider } from "@work-fabric/adapter-configuration-yaml";
import {
  ConfigurationService,
  ConfigurationViewProvider,
  EnvironmentSecretResolver,
  resolveDeclaredSecrets,
  type NamedConfigurationSectionValidator,
} from "@work-fabric/configuration-runtime";
import type {
  ConfigurationDocument,
  ConfigurationProvider,
} from "@work-fabric/configuration-spi";
import {
  validateFeishuProviderConfig,
  type FeishuProviderConfig,
} from "@work-fabric/provider-feishu";

export interface FeishuProviderServiceConfiguration {
  readonly runtime_id: string;
  readonly development_mode: boolean;
  readonly work_fabric: {
    readonly base_url: string;
    readonly tenant_id: string;
    readonly exchange_id: string;
    readonly subscription_id: string;
    readonly access_token: string;
  };
  readonly concurrency: {
    readonly max_active_runs: number;
    readonly queue_capacity: number;
  };
  readonly runtime_state: {
    readonly location: string;
    readonly busy_timeout_ms: number;
  };
  readonly document_access:
    | { readonly mode: "brokered_native" }
    | {
        readonly mode: "development_app_identity";
        readonly default_resource_uri: string;
      };
  readonly citizen_lease: {
    readonly requested_lease_seconds: number;
    readonly heartbeat_safety_margin_ms: number;
  };
}

export interface FeishuProviderParticipant {
  readonly actor_id: string;
  readonly actor_type: "agent";
  readonly endpoint_id: string;
}

export interface LoadedFeishuProviderConfiguration {
  readonly service: FeishuProviderServiceConfiguration;
  readonly participant: FeishuProviderParticipant;
  readonly provider: FeishuProviderConfig;
  readonly provider_instance_id: string;
}

export interface LoadFeishuProviderConfigurationOptions {
  readonly document?: ConfigurationDocument;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  fields: readonly string[],
  path: string,
): void {
  const unknown = Object.keys(value).find((key) => !fields.includes(key));
  if (unknown !== undefined || Object.keys(value).length !== fields.length) {
    throw new TypeError(`${path}${unknown === undefined ? "" : `.${unknown}`} is invalid`);
  }
}

function string(value: unknown, path: string, maximum = 2_048): string {
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
  ) throw new TypeError(`${path} is invalid`);
  return value as number;
}

function service(
  value: unknown,
  path: string,
): FeishuProviderServiceConfiguration {
  const root = object(value, path);
  exact(root, [
    "runtime_id",
    "development_mode",
    "work_fabric",
    "concurrency",
    "runtime_state",
    "document_access",
    "citizen_lease",
  ], path);
  if (typeof root.development_mode !== "boolean") {
    throw new TypeError(`${path}.development_mode is invalid`);
  }
  const workFabric = object(root.work_fabric, `${path}.work_fabric`);
  exact(workFabric, [
    "base_url",
    "tenant_id",
    "exchange_id",
    "subscription_id",
    "access_token",
  ], `${path}.work_fabric`);
  const concurrency = object(root.concurrency, `${path}.concurrency`);
  exact(concurrency, ["max_active_runs", "queue_capacity"], `${path}.concurrency`);
  const runtimeState = object(root.runtime_state, `${path}.runtime_state`);
  exact(runtimeState, ["location", "busy_timeout_ms"], `${path}.runtime_state`);
  const documentAccess = object(
    root.document_access,
    `${path}.document_access`,
  );
  let parsedDocumentAccess: FeishuProviderServiceConfiguration[
    "document_access"
  ];
  if (documentAccess.mode === "brokered_native") {
    exact(documentAccess, ["mode"], `${path}.document_access`);
    parsedDocumentAccess = Object.freeze({
      mode: "brokered_native" as const,
    });
  } else if (documentAccess.mode === "development_app_identity") {
    exact(
      documentAccess,
      ["mode", "default_resource_uri"],
      `${path}.document_access`,
    );
    parsedDocumentAccess = Object.freeze({
      mode: "development_app_identity" as const,
      default_resource_uri: string(
        documentAccess.default_resource_uri,
        `${path}.document_access.default_resource_uri`,
      ),
    });
  } else {
    throw new TypeError(`${path}.document_access.mode is invalid`);
  }
  const lease = object(root.citizen_lease, `${path}.citizen_lease`);
  exact(lease, [
    "requested_lease_seconds",
    "heartbeat_safety_margin_ms",
  ], `${path}.citizen_lease`);
  return Object.freeze({
    runtime_id: string(root.runtime_id, `${path}.runtime_id`, 128),
    development_mode: root.development_mode,
    work_fabric: Object.freeze({
      base_url: string(workFabric.base_url, `${path}.work_fabric.base_url`),
      tenant_id: string(workFabric.tenant_id, `${path}.work_fabric.tenant_id`, 128),
      exchange_id: string(workFabric.exchange_id, `${path}.work_fabric.exchange_id`, 128),
      subscription_id: string(workFabric.subscription_id, `${path}.work_fabric.subscription_id`, 128),
      access_token: string(workFabric.access_token, `${path}.work_fabric.access_token`, 1_024),
    }),
    concurrency: Object.freeze({
      max_active_runs: positive(concurrency.max_active_runs, `${path}.concurrency.max_active_runs`, 128),
      queue_capacity: positive(concurrency.queue_capacity, `${path}.concurrency.queue_capacity`, 100_000),
    }),
    runtime_state: Object.freeze({
      location: string(runtimeState.location, `${path}.runtime_state.location`, 4_096),
      busy_timeout_ms: positive(runtimeState.busy_timeout_ms, `${path}.runtime_state.busy_timeout_ms`, 60_000),
    }),
    document_access: parsedDocumentAccess,
    citizen_lease: Object.freeze({
      requested_lease_seconds: positive(lease.requested_lease_seconds, `${path}.citizen_lease.requested_lease_seconds`, 86_400),
      heartbeat_safety_margin_ms: positive(lease.heartbeat_safety_margin_ms, `${path}.citizen_lease.heartbeat_safety_margin_ms`, 300_000),
    }),
  });
}

const participantValidator: NamedConfigurationSectionValidator<FeishuProviderParticipant> = {
  section: "participant",
  type: "workfabric.feishu-provider.participant.v1",
  validate(value, path) {
    const root = object(value, path);
    exact(root, ["actor_id", "actor_type", "endpoint_id"], path);
    if (root.actor_type !== "agent") {
      throw new TypeError(`${path}.actor_type is invalid`);
    }
    return Object.freeze({
      actor_id: string(root.actor_id, `${path}.actor_id`, 128),
      actor_type: "agent" as const,
      endpoint_id: string(root.endpoint_id, `${path}.endpoint_id`, 128),
    });
  },
};

function providerFor(
  options: LoadFeishuProviderConfigurationOptions,
  environment: Readonly<Record<string, string | undefined>>,
): ConfigurationProvider {
  const provider: ConfigurationProvider = options.document === undefined
    ? new YamlConfigurationProvider({
        path:
          environment.WORK_FABRIC_FEISHU_PROVIDER_CONFIG ??
          environment.WORK_FABRIC_CONFIG ??
          (() => {
            throw new TypeError(
              "WORK_FABRIC_FEISHU_PROVIDER_CONFIG|WORK_FABRIC_CONFIG is required",
            );
          })(),
        max_bytes: 4 * 1_024 * 1_024,
        max_depth: 64,
      })
    : { async load() { return options.document!; } };
  return new ConfigurationViewProvider({
    provider,
    application_id:
      environment.WORK_FABRIC_FEISHU_PROVIDER_CONFIG_APPLICATION ??
      "feishu-provider",
  });
}

export async function loadFeishuProviderConfiguration(
  options: LoadFeishuProviderConfigurationOptions = {},
): Promise<LoadedFeishuProviderConfiguration> {
  const environment = options.environment ?? process.env;
  const configuration = new ConfigurationService({
    provider: providerFor(options, environment),
    clock: { now: () => new Date().toISOString() },
    validate_service: service,
    section_validators: [participantValidator],
    plugin_validators: [{
      type: "capability-provider.feishu",
      validate: validateFeishuProviderConfig,
    }],
  });
  const snapshot = await configuration.load();
  const participant = snapshot.value.sections.participant as
    | FeishuProviderParticipant
    | undefined;
  if (participant === undefined) {
    throw new TypeError("participant is required");
  }
  const instances = Object.entries(snapshot.value.plugins.instances).filter(
    ([, instance]) =>
      instance.enabled && instance.type === "capability-provider.feishu",
  );
  if (instances.length !== 1) {
    throw new TypeError("plugins.instances must enable exactly one Feishu Provider");
  }
  const [providerInstanceId, instance] = instances[0]!;
  const provider = instance.config as FeishuProviderConfig;
  if (
    participant.actor_id !== provider.capability_citizen.actor_id ||
    participant.endpoint_id !== provider.capability_citizen.endpoint_id ||
    participant.actor_id !== provider.context_citizen.actor_id ||
    participant.endpoint_id !== provider.context_citizen.endpoint_id
  ) {
    throw new TypeError("participant does not match Provider Citizens");
  }
  const resolved = await resolveDeclaredSecrets(
    { service: snapshot.value.service, provider },
    [
      "service.work_fabric.access_token",
    ],
    {
      resolver: new EnvironmentSecretResolver(environment),
      allow_literals: false,
    },
  );
  return Object.freeze({
    service: resolved.service,
    participant,
    provider: resolved.provider,
    provider_instance_id: providerInstanceId,
  });
}
