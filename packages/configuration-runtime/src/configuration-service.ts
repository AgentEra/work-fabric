import type { ConfigurationProvider } from "@work-fabric/configuration-spi";

import { ConfigurationError } from "./errors.js";

export interface ConfigurationSectionValidator<T = unknown> {
  readonly type: string;
  validate(value: unknown, path: string): T;
}

export interface NamedConfigurationSectionValidator<T = unknown> extends ConfigurationSectionValidator<T> {
  readonly section: string;
}

export interface ConfigurationClock {
  now(): string;
}

export interface PluginInstanceSnapshot {
  readonly type: string;
  readonly enabled: boolean;
  readonly config: unknown;
}

export interface ConfigurationValue<Service = unknown> {
  readonly api_version: "workfabric.config/v1";
  readonly service: Service;
  readonly plugins: {
    readonly instances: Readonly<Record<string, PluginInstanceSnapshot>>;
  };
  readonly sections: Readonly<Record<string, unknown>>;
}

export interface ConfigurationSnapshot<Service = unknown> {
  readonly revision: string;
  readonly loaded_at: string;
  readonly value: ConfigurationValue<Service>;
}

export interface ConfigurationServiceOptions<Service> {
  readonly provider: ConfigurationProvider;
  readonly clock: ConfigurationClock;
  readonly validate_service: (value: unknown, path: string) => Service;
  readonly plugin_validators: readonly ConfigurationSectionValidator[];
  readonly section_validators?: readonly NamedConfigurationSectionValidator[];
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError("invalid_object", path);
  }
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new ConfigurationError("invalid_identifier", path);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new ConfigurationError("unknown_key", `${path}.${unknown}`);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export class ConfigurationService<Service = unknown> {
  private snapshot: ConfigurationSnapshot<Service> | null = null;
  private loading: Promise<ConfigurationSnapshot<Service>> | null = null;

  constructor(private readonly options: ConfigurationServiceOptions<Service>) {}

  current(): ConfigurationSnapshot<Service> | null {
    return this.snapshot;
  }

  load(): Promise<ConfigurationSnapshot<Service>> {
    if (this.snapshot !== null) return Promise.resolve(this.snapshot);
    this.loading ??= this.loadOnce();
    return this.loading;
  }

  private async loadOnce(): Promise<ConfigurationSnapshot<Service>> {
    try {
      const document = await this.options.provider.load();
      if (typeof document.revision !== "string" || document.revision.length === 0) {
        throw new ConfigurationError("invalid_source_revision", "revision");
      }
      const root = record(document.value, "$" );
      const sectionValidators = this.options.section_validators ?? [];
      const sectionsByName = new Map(sectionValidators.map((item) => [item.section, item]));
      if (sectionsByName.size !== sectionValidators.length) {
        throw new ConfigurationError("duplicate_section_validator", "sections");
      }
      exactKeys(root, ["api_version", "service", "plugins", ...sectionsByName.keys()], "$");
      if (root.api_version !== "workfabric.config/v1") {
        throw new ConfigurationError("unsupported_api_version", "api_version");
      }
      const service = this.options.validate_service(root.service, "service");
      const pluginRoot = root.plugins === undefined
        ? { instances: {} }
        : record(root.plugins, "plugins");
      exactKeys(pluginRoot, ["instances"], "plugins");
      const instances = record(pluginRoot.instances ?? {}, "plugins.instances");
      const validators = new Map(this.options.plugin_validators.map((item) => [item.type, item]));
      if (validators.size !== this.options.plugin_validators.length) {
        throw new ConfigurationError("duplicate_plugin_validator", "plugins");
      }
      const normalized: Record<string, PluginInstanceSnapshot> = {};
      for (const instanceId of Object.keys(instances).sort()) {
        nonEmpty(instanceId, `plugins.instances.${instanceId}`);
        const path = `plugins.instances.${instanceId}`;
        const instance = record(instances[instanceId], path);
        exactKeys(instance, ["type", "enabled", "config"], path);
        const type = nonEmpty(instance.type, `${path}.type`);
        if (typeof instance.enabled !== "boolean") {
          throw new ConfigurationError("invalid_enabled_flag", `${path}.enabled`);
        }
        if (!instance.enabled) {
          normalized[instanceId] = deepFreeze({
            type, enabled: false, config: structuredClone(instance.config),
          });
          continue;
        }
        const validator = validators.get(type);
        if (validator === undefined) {
          throw new ConfigurationError("unknown_plugin_type", `${path}.type`);
        }
        normalized[instanceId] = deepFreeze({
          type,
          enabled: true,
          config: validator.validate(instance.config, `${path}.config`),
        });
      }
      const sections: Record<string, unknown> = {};
      for (const [section, validator] of sectionsByName) {
        if (root[section] !== undefined) {
          sections[section] = deepFreeze(validator.validate(root[section], section));
        }
      }
      const snapshot = deepFreeze({
        revision: document.revision,
        loaded_at: this.options.clock.now(),
        value: {
          api_version: "workfabric.config/v1" as const,
          service: structuredClone(service),
          plugins: { instances: normalized },
          sections,
        },
      });
      this.snapshot = snapshot;
      return snapshot;
    } catch (error) {
      this.loading = null;
      throw error;
    }
  }
}
