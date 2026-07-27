import { YamlConfigurationProvider } from "@work-fabric/adapter-configuration-yaml";
import {
  ConfigurationService,
  ConfigurationViewProvider,
  EnvironmentSecretResolver,
  resolveDeclaredSecrets,
  type NamedConfigurationSectionValidator,
} from "@work-fabric/configuration-runtime";
import type { ConfigurationDocument, ConfigurationProvider } from "@work-fabric/configuration-spi";
import { defineAgentRoleProfile, type AgentRoleProfile } from "@work-fabric/agent-runtime-spi";

import type { AgentRuntimeParticipant, AgentRuntimeServiceConfiguration, AgentlyDriverConfiguration, LoadedAgentRuntimeConfiguration } from "./config.js";
import { invalid } from "./errors.js";

export interface LoadAgentRuntimeConfigurationOptions {
  readonly document?: ConfigurationDocument;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly WORK_FABRIC_AGENT_RUNTIME_CONFIG?: string;
  readonly WORK_FABRIC_AGENT_RUNTIME_CONFIG_APPLICATION?: string;
  readonly WORK_FABRIC_CONFIG?: string;
  readonly AGENT_RUNTIME_WORK_FABRIC_TOKEN?: string;
  readonly AGENTLY_MODEL_API_KEY?: string;
  readonly [key: string]: unknown;
}

function environmentOf(options: LoadAgentRuntimeConfigurationOptions): Readonly<Record<string, string | undefined>> {
  if (options.environment !== undefined) return options.environment;
  const environment: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === "string" || value === undefined) environment[key] = value;
  }
  return environment;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("invalid_object", path);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], path: string): void {
  const unknown = Object.keys(value).find((key) => !fields.includes(key));
  if (unknown !== undefined || Object.keys(value).length !== fields.length) invalid("invalid_configuration", unknown === undefined ? path : `${path}.${unknown}`);
}

function string(value: unknown, path: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim() !== value) invalid("invalid_string", path);
  return value;
}

function positive(value: unknown, path: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) invalid("invalid_number", path);
  return value;
}

function capability(value: unknown, path: string): string {
  const id = string(value, path, 128);
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(id)) invalid("invalid_capability", path);
  return id;
}

function capabilityList(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) invalid("invalid_capabilities", path);
  const items = value.map((item, index) => {
    if (typeof item === "string") return capability(item, `${path}.${index}`);
    const descriptor = object(item, `${path}.${index}`);
    return capability(descriptor.capability_id, `${path}.${index}.capability_id`);
  });
  if (new Set(items).size !== items.length) invalid("invalid_capabilities", path);
  return items;
}

function namespaceList(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    invalid("invalid_namespaces", path);
  }
  const items = value.map((item, index) => {
    const namespace = string(item, `${path}.${index}`, 128);
    if (
      !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\.$/.test(namespace)
    ) {
      invalid("invalid_namespace", `${path}.${index}`);
    }
    return namespace;
  });
  if (new Set(items).size !== items.length) invalid("invalid_namespaces", path);
  return items;
}

function validateService(value: unknown, path: string): AgentRuntimeServiceConfiguration {
  const root = object(value, path); exact(root, ["runtime_id", "development_mode", "work_fabric", "acceptance", "concurrency", "state", "capability_invocation"], path);
  const workFabric = object(root.work_fabric, `${path}.work_fabric`);
  exact(workFabric, ["base_url", "tenant_id", "exchange_id", "actor_id", "endpoint_id", "subscription_id", "access_token"], `${path}.work_fabric`);
  const acceptance = object(root.acceptance, `${path}.acceptance`);
  exact(acceptance, ["mode", "require_explicit_target", "reject_expired_handoffs", "require_authority_scope", "allowed_capability_ids"], `${path}.acceptance`);
  if (acceptance.mode !== "accept_all_targeted") invalid("invalid_acceptance_mode", `${path}.acceptance.mode`);
  for (const field of ["require_explicit_target", "reject_expired_handoffs", "require_authority_scope"] as const) {
    if (acceptance[field] !== true) invalid("invalid_acceptance_policy", `${path}.acceptance.${field}`);
  }
  const concurrency = object(root.concurrency, `${path}.concurrency`);
  exact(concurrency, ["max_active_runs", "queue_capacity"], `${path}.concurrency`);
  const state = object(root.state, `${path}.state`);
  exact(state, ["provider", "location", "busy_timeout_ms"], `${path}.state`);
  if (state.provider !== "sqlite") invalid("invalid_state_provider", `${path}.state.provider`);
  const capabilityInvocation = object(
    root.capability_invocation,
    `${path}.capability_invocation`,
  );
  exact(
    capabilityInvocation,
    ["enabled", "max_invocations_per_handoff", "allowed_namespaces"],
    `${path}.capability_invocation`,
  );
  if (typeof capabilityInvocation.enabled !== "boolean") {
    invalid("invalid_boolean", `${path}.capability_invocation.enabled`);
  }
  return {
    runtime_id: string(root.runtime_id, `${path}.runtime_id`, 128),
    development_mode: root.development_mode === true,
    work_fabric: {
      base_url: string(workFabric.base_url, `${path}.work_fabric.base_url`), tenant_id: string(workFabric.tenant_id, `${path}.work_fabric.tenant_id`, 128), exchange_id: string(workFabric.exchange_id, `${path}.work_fabric.exchange_id`, 128), actor_id: string(workFabric.actor_id, `${path}.work_fabric.actor_id`, 128), endpoint_id: string(workFabric.endpoint_id, `${path}.work_fabric.endpoint_id`, 128), subscription_id: string(workFabric.subscription_id, `${path}.work_fabric.subscription_id`, 128), access_token: string(workFabric.access_token, `${path}.work_fabric.access_token`, 1024),
    },
    acceptance: { mode: "accept_all_targeted", require_explicit_target: true, reject_expired_handoffs: true, require_authority_scope: true, allowed_capability_ids: capabilityList(acceptance.allowed_capability_ids, `${path}.acceptance.allowed_capability_ids`) },
    concurrency: { max_active_runs: positive(concurrency.max_active_runs, `${path}.concurrency.max_active_runs`, 128), queue_capacity: positive(concurrency.queue_capacity, `${path}.concurrency.queue_capacity`, 100_000) },
    state: { provider: "sqlite", location: string(state.location, `${path}.state.location`), busy_timeout_ms: positive(state.busy_timeout_ms, `${path}.state.busy_timeout_ms`, 60_000) },
    capability_invocation: {
      enabled: capabilityInvocation.enabled,
      max_invocations_per_handoff: positive(
        capabilityInvocation.max_invocations_per_handoff,
        `${path}.capability_invocation.max_invocations_per_handoff`,
        4,
      ),
      allowed_namespaces: namespaceList(
        capabilityInvocation.allowed_namespaces,
        `${path}.capability_invocation.allowed_namespaces`,
      ),
    },
  };
}

const roleValidator: NamedConfigurationSectionValidator<Omit<AgentRoleProfile, "capability_ids">> = {
  section: "role", type: "workfabric.agent-runtime.role.v1",
  validate(value, path) {
    const root = object(value, path); exact(root, ["role_id", "version", "display_name", "description"], path);
    if (!Number.isSafeInteger(root.version) || (root.version as number) < 1) invalid("invalid_role", `${path}.version`);
    return { role_id: string(root.role_id, `${path}.role_id`, 128), version: root.version as number, display_name: string(root.display_name, `${path}.display_name`), description: string(root.description, `${path}.description`) } as Omit<AgentRoleProfile, "capability_ids">;
  },
};

const participantValidator: NamedConfigurationSectionValidator<AgentRuntimeParticipant> = {
  section: "participant", type: "workfabric.agent-runtime.participant.v1",
  validate(value, path) {
    const root = object(value, path); exact(root, ["actor_id", "actor_type", "endpoint_id"], path);
    if (root.actor_type !== "agent") invalid("invalid_participant", `${path}.actor_type`);
    return { actor_id: string(root.actor_id, `${path}.actor_id`, 128), actor_type: "agent", endpoint_id: string(root.endpoint_id, `${path}.endpoint_id`, 128) };
  },
};

const capabilitiesValidator: NamedConfigurationSectionValidator<readonly string[]> = {
  section: "capabilities", type: "workfabric.agent-runtime.capabilities.v1",
  validate(value, path) { return capabilityList(value, path); },
};

function validateAgently(value: unknown, path: string): AgentlyDriverConfiguration {
  const root = object(value, path); exact(root, ["python", "workspace_root", "execution_timeout_seconds", "cancellation_grace_seconds", "provider"], path);
  const python = object(root.python, `${path}.python`); exact(python, ["executable", "module"], `${path}.python`);
  const provider = object(root.provider, `${path}.provider`); exact(provider, ["type", "model", "base_url", "api_key"], `${path}.provider`);
  return { python: { executable: string(python.executable, `${path}.python.executable`), module: string(python.module, `${path}.python.module`, 256) }, workspace_root: string(root.workspace_root, `${path}.workspace_root`), execution_timeout_seconds: positive(root.execution_timeout_seconds, `${path}.execution_timeout_seconds`, 86_400), cancellation_grace_seconds: positive(root.cancellation_grace_seconds, `${path}.cancellation_grace_seconds`, 3_600), provider: { type: string(provider.type, `${path}.provider.type`, 128), model: string(provider.model, `${path}.provider.model`, 256), base_url: string(provider.base_url, `${path}.provider.base_url`), api_key: string(provider.api_key, `${path}.provider.api_key`, 1024) } };
}

function providerFor(options: LoadAgentRuntimeConfigurationOptions): ConfigurationProvider {
  const environment = environmentOf(options);
  let provider: ConfigurationProvider;
  if (options.document !== undefined) {
    provider = { async load() { return options.document!; } };
  } else {
    const path =
      environment.WORK_FABRIC_AGENT_RUNTIME_CONFIG ??
      environment.WORK_FABRIC_CONFIG;
    if (path === undefined || path.length === 0) {
      invalid(
        "config_path_missing",
        "WORK_FABRIC_AGENT_RUNTIME_CONFIG|WORK_FABRIC_CONFIG",
      );
    }
    provider = new YamlConfigurationProvider({
      path,
      max_bytes: 4 * 1024 * 1024,
      max_depth: 64,
    });
  }
  return new ConfigurationViewProvider({
    provider,
    application_id:
      environment.WORK_FABRIC_AGENT_RUNTIME_CONFIG_APPLICATION ??
      "daily-assistant",
  });
}

export async function loadAgentRuntimeConfiguration(options: LoadAgentRuntimeConfigurationOptions): Promise<LoadedAgentRuntimeConfiguration> {
  const service = new ConfigurationService({ provider: providerFor(options), clock: { now: () => new Date().toISOString() }, validate_service: validateService, section_validators: [roleValidator, participantValidator, capabilitiesValidator], plugin_validators: [{ type: "agent-runtime.agently", validate: validateAgently }] });
  const snapshot = await service.load();
  const sections = snapshot.value.sections as { readonly role?: Omit<AgentRoleProfile, "capability_ids">; readonly participant?: AgentRuntimeParticipant; readonly capabilities?: readonly string[] };
  if (sections.role === undefined) invalid("required_section_missing", "role");
  if (sections.participant === undefined) invalid("required_section_missing", "participant");
  if (sections.capabilities === undefined) invalid("required_section_missing", "capabilities");
  const role = defineAgentRoleProfile({ ...sections.role, capability_ids: sections.capabilities });
  if (sections.participant.actor_id !== snapshot.value.service.work_fabric.actor_id || sections.participant.endpoint_id !== snapshot.value.service.work_fabric.endpoint_id) invalid("participant_service_mismatch", "participant");
  const supportedCapabilities = new Set([
    "collaboration.request.intake",
    "information.synthesis",
    "collaboration.handoff.draft",
  ]);
  if (role.capability_ids.some((item) => !supportedCapabilities.has(item))) invalid("capabilities", "capabilities");
  if (snapshot.value.service.acceptance.allowed_capability_ids.some((item) => !role.capability_ids.includes(item))) {
    invalid("invalid_capability", "service.acceptance.allowed_capability_ids");
  }
  const instances = Object.entries(snapshot.value.plugins.instances).filter(([, item]) => item.enabled && item.type === "agent-runtime.agently");
  if (instances.length !== 1) invalid("driver_instance_invalid", "plugins.instances");
  const [instance_id, instance] = instances[0]!;
  const driverConfig = instance.config as AgentlyDriverConfiguration;
  const resolved = await resolveDeclaredSecrets({ service: snapshot.value.service, driver: driverConfig }, ["service.work_fabric.access_token", "driver.provider.api_key"], { resolver: new EnvironmentSecretResolver(environmentOf(options)), allow_literals: false });
  return { service: resolved.service, role, participant: sections.participant, driver: { instance_id, config: resolved.driver } };
}
