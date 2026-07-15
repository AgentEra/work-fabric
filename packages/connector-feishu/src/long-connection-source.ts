import type { ConnectorIngressStore } from "@work-fabric/connector-spi";
import type { JsonObject } from "@work-fabric/exchange-spi";

import { normalizeFeishuEvent } from "./ingress-normalizer.js";

export interface FeishuLongConnectionAcceptance {
  readonly accepted: true;
  readonly duplicate: boolean;
  readonly ingress_id: string;
}

export type FeishuLongConnectionHandler = (
  verifiedBody: JsonObject,
) => Promise<FeishuLongConnectionAcceptance>;

export interface FeishuLongConnectionClient {
  start(handler: FeishuLongConnectionHandler): Promise<void>;
  stop(): Promise<void>;
}

export interface FeishuLongConnectionSourceOptions {
  readonly client: FeishuLongConnectionClient;
  readonly ingress: ConnectorIngressStore;
  readonly scope: {
    readonly tenant_id: string;
    readonly connector_id: string;
    readonly expected_external_tenant_id: string;
  };
  readonly clock: { now(): string };
}

export class FeishuLongConnectionSource {
  private started = false;

  constructor(private readonly options: FeishuLongConnectionSourceOptions) {}

  async start(): Promise<void> {
    if (this.started) return;
    await this.options.client.start(async (verifiedBody) => {
      const envelope = normalizeFeishuEvent(verifiedBody, {
        ...this.options.scope,
        received_at: this.options.clock.now(),
      });
      const result = await this.options.ingress.accept(envelope);
      return {
        accepted: true,
        duplicate: result.kind === "duplicate",
        ingress_id: result.record.ingress_id,
      };
    });
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.options.client.stop();
    this.started = false;
  }
}
