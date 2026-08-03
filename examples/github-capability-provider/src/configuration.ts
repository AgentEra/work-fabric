import { YamlConfigurationProvider } from "@work-fabric/adapter-configuration-yaml";
import {
  ConfigurationService,
  ConfigurationViewProvider,
  type NamedConfigurationSectionValidator,
} from "@work-fabric/configuration-runtime";
import type {
  ConfigurationDocument,
  ConfigurationProvider,
} from "@work-fabric/configuration-spi";
import type { GitHubProviderPolicy, GitHubRepositoryRef } from "@work-fabric/provider-github";

export interface GitHubProviderServiceConfiguration {
  readonly runtime_id: string;
  readonly development_mode: boolean;
  readonly work_fabric: {
    readonly base_url: string;
    readonly tenant_id: string;
    readonly exchange_id: string;
    readonly subscription_id: string;
    /** An environment reference; never a resolved token in configuration. */
    readonly access_token: string;
  };
  readonly concurrency: {
    readonly max_active_runs: number;
    readonly queue_capacity: number;
    readonly max_active_partitions: number;
  };
  readonly citizen_lease: {
    readonly requested_lease_seconds: number;
    readonly heartbeat_safety_margin_ms: number;
  };
}

export interface GitHubProviderAuthentication {
  readonly mode: "github_app";
  readonly credential_ref: string;
  readonly app_id_environment: string;
  readonly installation_id_environment: string;
  readonly private_key_environment: string;
}

export interface GitHubProviderCitizenConfiguration {
  readonly citizen_id: string;
  readonly principal_id: string;
  readonly actor_id: string;
  readonly endpoint_id: string;
  readonly registration_version: number;
}

export interface GitHubProviderConfiguration {
  readonly authentication: GitHubProviderAuthentication;
  /** An environment reference; never a resolved key in configuration. */
  readonly cursor_signing_key: string;
  readonly policy: GitHubProviderPolicy;
  readonly citizen: GitHubProviderCitizenConfiguration;
}

export interface LoadedGitHubProviderConfiguration {
  readonly service: GitHubProviderServiceConfiguration;
  readonly provider: GitHubProviderConfiguration;
  readonly provider_instance_id: string;
}

export interface LoadGitHubProviderConfigurationOptions {
  readonly document?: ConfigurationDocument;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

const environmentReference = /^\$\{[A-Z_][A-Z0-9_]*\}$/u;
const environmentName = /^[A-Z_][A-Z0-9_]*$/u;

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], path: string): void {
  const keys = Object.keys(value);
  const unknown = keys.find((key) => !fields.includes(key));
  if (unknown !== undefined || keys.length !== fields.length) {
    throw new TypeError(`${path}${unknown === undefined ? "" : `.${unknown}`} is invalid`);
  }
}

function text(value: unknown, path: string, maximum = 2_048): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > maximum ||
    value.trim() !== value
  ) throw new TypeError(`${path} is invalid`);
  return value;
}

function identifier(value: unknown, path: string): string {
  return text(value, path, 128);
}

function positive(value: unknown, path: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new TypeError(`${path} is invalid`);
  }
  return value as number;
}

function declaredSecret(value: unknown, path: string): string {
  const reference = text(value, path, 256);
  if (!environmentReference.test(reference)) {
    throw new TypeError(`${path} must be an environment secret reference`);
  }
  return reference;
}

function service(value: unknown, path: string): GitHubProviderServiceConfiguration {
  const root = record(value, path);
  exact(root, ["runtime_id", "development_mode", "work_fabric", "concurrency", "citizen_lease"], path);
  if (typeof root.development_mode !== "boolean") {
    throw new TypeError(`${path}.development_mode is invalid`);
  }
  const workFabric = record(root.work_fabric, `${path}.work_fabric`);
  exact(workFabric, ["base_url", "tenant_id", "exchange_id", "subscription_id", "access_token"], `${path}.work_fabric`);
  const concurrency = record(root.concurrency, `${path}.concurrency`);
  exact(concurrency, ["max_active_runs", "queue_capacity", "max_active_partitions"], `${path}.concurrency`);
  const lease = record(root.citizen_lease, `${path}.citizen_lease`);
  exact(lease, ["requested_lease_seconds", "heartbeat_safety_margin_ms"], `${path}.citizen_lease`);
  return Object.freeze({
    runtime_id: identifier(root.runtime_id, `${path}.runtime_id`),
    development_mode: root.development_mode,
    work_fabric: Object.freeze({
      base_url: text(workFabric.base_url, `${path}.work_fabric.base_url`),
      tenant_id: identifier(workFabric.tenant_id, `${path}.work_fabric.tenant_id`),
      exchange_id: identifier(workFabric.exchange_id, `${path}.work_fabric.exchange_id`),
      subscription_id: identifier(workFabric.subscription_id, `${path}.work_fabric.subscription_id`),
      access_token: declaredSecret(workFabric.access_token, `${path}.work_fabric.access_token`),
    }),
    concurrency: Object.freeze({
      max_active_runs: positive(concurrency.max_active_runs, `${path}.concurrency.max_active_runs`, 128),
      queue_capacity: positive(concurrency.queue_capacity, `${path}.concurrency.queue_capacity`, 1_024),
      max_active_partitions: positive(concurrency.max_active_partitions, `${path}.concurrency.max_active_partitions`, 128),
    }),
    citizen_lease: Object.freeze({
      requested_lease_seconds: positive(lease.requested_lease_seconds, `${path}.citizen_lease.requested_lease_seconds`, 86_400),
      heartbeat_safety_margin_ms: positive(lease.heartbeat_safety_margin_ms, `${path}.citizen_lease.heartbeat_safety_margin_ms`, 300_000),
    }),
  });
}

function owners(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new TypeError(`${path} is invalid`);
  }
  const parsed = value.map((item, index) => text(item, `${path}.${index}`, 100));
  const normalized = new Set(parsed.map((item) => item.toLowerCase()));
  if (normalized.size !== parsed.length) throw new TypeError(`${path} contains duplicates`);
  return Object.freeze(parsed);
}

function repositories(value: unknown, path: string, allowedOwners: readonly string[]): readonly GitHubRepositoryRef[] {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError(`${path} is invalid`);
  const parsed = value.map((item, index) => {
    const root = record(item, `${path}.${index}`);
    exact(root, ["owner", "name"], `${path}.${index}`);
    const repository = Object.freeze({
      owner: text(root.owner, `${path}.${index}.owner`, 100),
      name: text(root.name, `${path}.${index}.name`, 100),
    });
    if (!allowedOwners.some((owner) => owner.toLowerCase() === repository.owner.toLowerCase())) {
      throw new TypeError(`${path}.${index}.owner is invalid`);
    }
    return repository;
  });
  const identities = new Set(parsed.map((item) => `${item.owner.toLowerCase()}/${item.name.toLowerCase()}`));
  if (identities.size !== parsed.length) throw new TypeError(`${path} contains duplicates`);
  return Object.freeze(parsed);
}

function provider(value: unknown, path: string): GitHubProviderConfiguration {
  const root = record(value, path);
  exact(root, ["authentication", "cursor_signing_key", "policy", "citizen"], path);
  const authentication = record(root.authentication, `${path}.authentication`);
  exact(authentication, ["mode", "credential_ref", "app_id_environment", "installation_id_environment", "private_key_environment"], `${path}.authentication`);
  if (authentication.mode !== "github_app") {
    throw new TypeError(`${path}.authentication.mode is invalid; github_app is required`);
  }
  for (const field of ["app_id_environment", "installation_id_environment", "private_key_environment"] as const) {
    if (typeof authentication[field] !== "string" || !environmentName.test(authentication[field])) {
      throw new TypeError(`${path}.authentication.${field} is invalid`);
    }
  }
  const policy = record(root.policy, `${path}.policy`);
  exact(policy, ["allowed_owners", "allowed_repositories", "maximum_page_size", "maximum_aggregate_repositories"], `${path}.policy`);
  const allowedOwners = owners(policy.allowed_owners, `${path}.policy.allowed_owners`);
  const parsedPolicy: GitHubProviderPolicy = Object.freeze({
    allowed_owners: allowedOwners,
    allowed_repositories: repositories(policy.allowed_repositories, `${path}.policy.allowed_repositories`, allowedOwners),
    maximum_page_size: positive(policy.maximum_page_size, `${path}.policy.maximum_page_size`, 100),
    maximum_aggregate_repositories: positive(policy.maximum_aggregate_repositories, `${path}.policy.maximum_aggregate_repositories`, 10_000),
  });
  const citizen = record(root.citizen, `${path}.citizen`);
  exact(citizen, ["citizen_id", "principal_id", "actor_id", "endpoint_id", "registration_version"], `${path}.citizen`);
  const parsedCitizen = Object.freeze({
    citizen_id: identifier(citizen.citizen_id, `${path}.citizen.citizen_id`),
    principal_id: identifier(citizen.principal_id, `${path}.citizen.principal_id`),
    actor_id: identifier(citizen.actor_id, `${path}.citizen.actor_id`),
    endpoint_id: identifier(citizen.endpoint_id, `${path}.citizen.endpoint_id`),
    registration_version: positive(citizen.registration_version, `${path}.citizen.registration_version`, Number.MAX_SAFE_INTEGER),
  });
  if (
    parsedCitizen.citizen_id !== "citizen-github-read" ||
    parsedCitizen.principal_id !== "principal-github-provider" ||
    parsedCitizen.actor_id !== "actor-github-provider" ||
    parsedCitizen.endpoint_id !== "endpoint-github-provider"
  ) {
    throw new TypeError(`${path}.citizen does not match the GitHub system participant`);
  }
  return Object.freeze({
    authentication: Object.freeze({
      mode: "github_app" as const,
      credential_ref: identifier(authentication.credential_ref, `${path}.authentication.credential_ref`),
      app_id_environment: authentication.app_id_environment,
      installation_id_environment: authentication.installation_id_environment,
      private_key_environment: authentication.private_key_environment,
    }),
    cursor_signing_key: declaredSecret(root.cursor_signing_key, `${path}.cursor_signing_key`),
    policy: parsedPolicy,
    citizen: parsedCitizen,
  });
}

function providerFor(options: LoadGitHubProviderConfigurationOptions, environment: Readonly<Record<string, string | undefined>>): ConfigurationProvider {
  const source: ConfigurationProvider = options.document === undefined
    ? new YamlConfigurationProvider({
        path: environment.WORK_FABRIC_GITHUB_PROVIDER_CONFIG ?? environment.WORK_FABRIC_CONFIG ?? (() => {
          throw new TypeError("WORK_FABRIC_GITHUB_PROVIDER_CONFIG|WORK_FABRIC_CONFIG is required");
        })(),
        max_bytes: 4 * 1_024 * 1_024,
        max_depth: 64,
      })
    : { async load() { return options.document!; } };
  return new ConfigurationViewProvider({
    provider: source,
    application_id: environment.WORK_FABRIC_GITHUB_PROVIDER_CONFIG_APPLICATION ?? "github-provider",
  });
}

const noSections: readonly NamedConfigurationSectionValidator[] = [];

export async function loadGitHubProviderConfiguration(
  options: LoadGitHubProviderConfigurationOptions = {},
): Promise<LoadedGitHubProviderConfiguration> {
  const environment = options.environment ?? process.env;
  const configuration = new ConfigurationService({
    provider: providerFor(options, environment),
    clock: { now: () => new Date().toISOString() },
    validate_service: service,
    section_validators: noSections,
    plugin_validators: [{ type: "capability-provider.github", validate: provider }],
  });
  const snapshot = await configuration.load();
  const instances = Object.entries(snapshot.value.plugins.instances).filter(([, instance]) =>
    instance.enabled && instance.type === "capability-provider.github"
  );
  if (instances.length !== 1) {
    throw new TypeError("plugins.instances must enable exactly one GitHub Provider");
  }
  const [providerInstanceId, instance] = instances[0]!;
  return Object.freeze({
    service: snapshot.value.service,
    provider: instance.config as GitHubProviderConfiguration,
    provider_instance_id: providerInstanceId,
  });
}
