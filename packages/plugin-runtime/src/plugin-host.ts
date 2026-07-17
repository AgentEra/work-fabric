import type {
  PluginContext,
  PluginHealth,
  PluginInstance,
} from "@work-fabric/plugin-spi";

import { PluginRuntimeError } from "./errors.js";
import type { PluginRegistry } from "./plugin-registry.js";

export interface PluginHostInstanceConfiguration {
  readonly type: string;
  readonly enabled: boolean;
  readonly config: unknown;
}

export type PluginHostConfiguration = Readonly<
  Record<string, PluginHostInstanceConfiguration>
>;

export interface PluginHostOptions {
  readonly registry: PluginRegistry;
  readonly context: PluginContext;
  readonly configuration: PluginHostConfiguration;
}

export interface PluginInstanceHealth extends PluginHealth {
  readonly instance_id: string;
}

interface HostedInstance {
  readonly instanceId: string;
  readonly instance: PluginInstance;
}

export class PluginHost {
  private instances: HostedInstance[] = [];
  private state: "new" | "prepared" | "started" | "stopped" = "new";

  constructor(private readonly options: PluginHostOptions) {}

  async prepare(): Promise<void> {
    if (this.state !== "new") throw new PluginRuntimeError("invalid_plugin_host_state");
    const enabled = Object.entries(this.options.configuration)
      .filter(([, config]) => config.enabled)
      .sort(([left], [right]) => left.localeCompare(right));
    const resolved = enabled.map(([instanceId, config]) => {
      const factory = this.options.registry.get(config.type);
      if (factory === undefined) throw new PluginRuntimeError("unknown_plugin_type");
      return { instanceId, config, factory };
    });

    try {
      for (const item of resolved) {
        const validated = item.factory.validate(item.config.config);
        const instance = await item.factory.create(this.options.context, {
          instance_id: item.instanceId,
          type: item.config.type,
          config: validated,
        });
        this.instances.push({ instanceId: item.instanceId, instance });
      }
    } catch (error) {
      await this.stopInstances(this.instances);
      this.instances = [];
      this.state = "stopped";
      throw error;
    }

    let prepared = 0;
    try {
      for (const item of this.instances) {
        await item.instance.prepare();
        prepared += 1;
      }
      this.state = "prepared";
    } catch (error) {
      const possiblyPrepared = this.instances.slice(0, prepared + 1);
      await this.stopInstances(possiblyPrepared);
      this.instances = [];
      this.state = "stopped";
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.state !== "prepared") throw new PluginRuntimeError("invalid_plugin_host_state");
    let started = 0;
    try {
      for (const item of this.instances) {
        await item.instance.start();
        started += 1;
      }
      this.state = "started";
    } catch (error) {
      await this.stopInstances(this.instances.slice(0, started + 1));
      this.instances = [];
      this.state = "stopped";
      throw error;
    }
  }

  async health(): Promise<readonly PluginInstanceHealth[]> {
    const output: PluginInstanceHealth[] = [];
    for (const item of this.instances) {
      try {
        const health = await item.instance.health();
        output.push({ instance_id: item.instanceId, ...health });
      } catch {
        output.push({
          instance_id: item.instanceId,
          state: "degraded",
          code: "health_check_failed",
        });
      }
    }
    return output;
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    await this.stopInstances(this.instances);
    this.instances = [];
    this.state = "stopped";
  }

  private async stopInstances(items: readonly HostedInstance[]): Promise<void> {
    for (const item of [...items].reverse()) {
      try { await item.instance.stop(); } catch { /* continue deterministic rollback */ }
    }
  }
}
