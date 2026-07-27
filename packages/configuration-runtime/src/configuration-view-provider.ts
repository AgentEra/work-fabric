import type {
  ConfigurationDocument,
  ConfigurationProvider,
} from "@work-fabric/configuration-spi";

import { ConfigurationError } from "./errors.js";

export interface ConfigurationViewProviderOptions {
  readonly provider: ConfigurationProvider;
  readonly application_id: string;
  readonly allow_standalone?: boolean;
}

const APPLICATION_ID = /^[a-z][a-z0-9-]{0,127}$/;

function object(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new ConfigurationError("invalid_object", path);
  }
  return value as Record<string, unknown>;
}

function own(value: Record<string, unknown>, key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    !descriptor.enumerable
  ) {
    throw new ConfigurationError("missing_key", `${path}.${key}`);
  }
  return descriptor.value;
}

function exact(value: Record<string, unknown>, fields: readonly string[], path: string): void {
  const keys = Reflect.ownKeys(value);
  const invalid = keys.find((key) =>
    typeof key !== "string" || !fields.includes(key)
  );
  if (invalid !== undefined || keys.length !== fields.length) {
    throw new ConfigurationError(
      "unknown_key",
      typeof invalid === "string" ? `${path}.${invalid}` : path,
    );
  }
}

export class ConfigurationViewProvider implements ConfigurationProvider {
  constructor(private readonly options: ConfigurationViewProviderOptions) {
    if (!APPLICATION_ID.test(options.application_id)) {
      throw new ConfigurationError("invalid_identifier", "application_id");
    }
  }

  async load(): Promise<ConfigurationDocument> {
    const document = await this.options.provider.load();
    const root = object(document.value, "$");
    const version = own(root, "api_version", "$");
    if (version === "workfabric.config/v1") {
      if (this.options.allow_standalone === false) {
        throw new ConfigurationError("unsupported_api_version", "api_version");
      }
      return {
        revision: document.revision,
        value: structuredClone(root),
      };
    }
    if (version !== "workfabric.config-bundle/v1") {
      throw new ConfigurationError("unsupported_api_version", "api_version");
    }
    exact(root, ["api_version", "applications"], "$");
    const applications = object(own(root, "applications", "$"), "applications");
    const ids = Reflect.ownKeys(applications);
    if (
      ids.length === 0 ||
      ids.length > 64 ||
      ids.some((id) => typeof id !== "string" || !APPLICATION_ID.test(id))
    ) {
      throw new ConfigurationError("invalid_identifier", "applications");
    }
    const selected = object(
      own(applications, this.options.application_id, "applications"),
      `applications.${this.options.application_id}`,
    );
    if (own(selected, "api_version", `applications.${this.options.application_id}`) !==
      "workfabric.config/v1") {
      throw new ConfigurationError(
        "unsupported_api_version",
        `applications.${this.options.application_id}.api_version`,
      );
    }
    return {
      revision: `${document.revision}#${this.options.application_id}`,
      value: structuredClone(selected),
    };
  }
}
