import type { PluginFactory } from "@work-fabric/plugin-spi";

import { PluginRuntimeError } from "./errors.js";

function validType(type: string): boolean {
  return /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(type) && type.length <= 128;
}

export class PluginRegistry {
  private readonly factories = new Map<string, PluginFactory>();

  constructor(factories: readonly PluginFactory[] = []) {
    for (const factory of factories) this.register(factory);
  }

  register(factory: PluginFactory): void {
    if (!validType(factory.type)) throw new PluginRuntimeError("invalid_plugin_type");
    if (this.factories.has(factory.type)) {
      throw new PluginRuntimeError("duplicate_plugin_factory");
    }
    this.factories.set(factory.type, factory);
  }

  get(type: string): PluginFactory | undefined {
    return this.factories.get(type);
  }
}
