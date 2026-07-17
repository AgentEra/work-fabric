import type { SignalAdapter } from "@work-fabric/exchange-spi";

export interface PluginServiceLocator {
  get<T>(capability: string): T;
}

export interface PluginContext {
  readonly configuration_revision: string;
  readonly service: PluginServiceLocator;
}

export interface PluginInstanceConfiguration {
  readonly instance_id: string;
  readonly type: string;
  readonly config: unknown;
}

export interface PluginHealth {
  readonly state: "healthy" | "degraded" | "unhealthy";
  readonly code?: string;
}

export interface PluginInstance {
  prepare(): Promise<void>;
  start(): Promise<void>;
  health(): Promise<PluginHealth>;
  stop(): Promise<void>;
  readonly signal_adapter?: SignalAdapter;
}

export interface PluginValidationResult {
  readonly valid: boolean;
  readonly value?: unknown;
  readonly code?: string;
  readonly path?: string;
}

export interface PluginFactory {
  readonly type: string;
  validate(config: unknown): unknown;
  create(
    context: PluginContext,
    instance: PluginInstanceConfiguration,
  ): Promise<PluginInstance>;
}
