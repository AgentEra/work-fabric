import { YamlConfigurationProvider } from "@work-fabric/adapter-configuration-yaml";
import { admissionConfigurationValidator, type AdmissionConfigurationSection } from "@work-fabric/adapter-admission-configuration";
import { ConfigurationService, EnvironmentSecretResolver, resolveDeclaredSecrets } from "@work-fabric/configuration-runtime";
import { FeishuPluginFactory, feishuSecretPaths, validateFeishuPluginConfig } from "@work-fabric/plugin-channel-feishu";
import type { PluginHostConfiguration } from "@work-fabric/plugin-runtime";
import { parseServiceConfig, type NodeServiceConfig } from "./config.js";

export interface LoadedNodeConfiguration {
  readonly revision: string;
  readonly service: NodeServiceConfig;
  readonly plugins: PluginHostConfiguration;
  readonly admission: AdmissionConfigurationSection;
}

const emptyAdmissionConfiguration: AdmissionConfigurationSection = Object.freeze({
  policies: Object.freeze({}),
  evidence_providers: Object.freeze({}),
});

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function declaredSecretPaths(root: Record<string, unknown>): readonly string[] {
  const paths = ["service.cursor_secret"];
  const service = object(root.service, "service");
  if (service.postgres !== undefined) paths.push("service.postgres.connection_string");
  if (service.admission !== undefined) {
    const admission = object(service.admission, "service.admission");
    paths.push("service.admission.subject_fingerprint_key");
    const grantKeys = object(admission.grant_keys, "service.admission.grant_keys");
    for (const keyId of Object.keys(grantKeys)) {
      paths.push(`service.admission.grant_keys.${keyId}`);
    }
  }
  if (Array.isArray(service.identities)) {
    service.identities.forEach((identity, index) => {
      if (typeof identity === "object" && identity !== null && !Array.isArray(identity)) {
        const evidence = (identity as Record<string, unknown>).authentication_evidence;
        if (typeof evidence === "object" && evidence !== null && !Array.isArray(evidence) && Object.hasOwn(evidence, "bearer_token")) paths.push(`service.identities.${index}.authentication_evidence.bearer_token`);
      }
    });
  }
  const plugins = root.plugins === undefined ? {} : object(root.plugins, "plugins");
  const instances = plugins.instances === undefined ? {} : object(plugins.instances, "plugins.instances");
  for (const [instanceId, candidate] of Object.entries(instances)) {
    const instance = object(candidate, `plugins.instances.${instanceId}`);
    if (instance.enabled !== true) continue;
    if (instance.type !== "collaboration-channel.feishu") continue;
    const config = validateFeishuPluginConfig(instance.config);
    paths.push(...feishuSecretPaths(`plugins.instances.${instanceId}.config`, config));
  }
  return paths;
}

export async function loadNodeConfiguration(environment: Readonly<Record<string, string | undefined>>): Promise<LoadedNodeConfiguration> {
  const path = environment.WORK_FABRIC_CONFIG;
  if (path === undefined || path.trim() === "") throw new Error("WORK_FABRIC_CONFIG must point to an explicit YAML configuration file");
  const yaml = new YamlConfigurationProvider({ path, max_bytes: 4 * 1024 * 1024, max_depth: 64 });
  const document = await yaml.load();
  const root = object(document.value, "configuration");
  const serviceRaw = object(root.service, "service");
  const resolved = await resolveDeclaredSecrets(document.value, declaredSecretPaths(root), {
    resolver: new EnvironmentSecretResolver(environment),
    allow_literals: serviceRaw.development_mode === true,
  });
  const feishu = new FeishuPluginFactory();
  const configuration = new ConfigurationService({
    provider: { async load() { return { revision: document.revision, value: resolved }; } },
    clock: { now: () => new Date().toISOString() },
    validate_service: (value) => parseServiceConfig(value),
    plugin_validators: [{ type: feishu.type, validate: (value) => feishu.validate(value) }],
    section_validators: [admissionConfigurationValidator],
  });
  const snapshot = await configuration.load();
  const admission = snapshot.value.sections.admission ?? emptyAdmissionConfiguration;
  return {
    revision: snapshot.revision,
    service: snapshot.value.service,
    plugins: snapshot.value.plugins.instances,
    admission: admission as AdmissionConfigurationSection,
  };
}
