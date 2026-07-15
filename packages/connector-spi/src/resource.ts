import type {
  CapabilityManifest,
  ExchangeAdapter,
  JsonObject,
} from "@work-fabric/exchange-spi";

export interface ConnectorExternalReference {
  readonly uri: string;
  readonly external_type: string;
  readonly version?: string;
  readonly digest?: string;
  readonly media_type?: string;
  readonly metadata: JsonObject;
}

export interface ConnectorResourceQuery {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly reference: ConnectorExternalReference;
  readonly purpose: string;
  readonly max_bytes: number;
}

export type ConnectorResourceResolution =
  | {
      readonly kind: "available";
      readonly reference: ConnectorExternalReference;
      readonly content?: string;
    }
  | {
      readonly kind: "unavailable";
      readonly reason_code: string;
      readonly retryable: boolean;
    };

export interface ConnectorResourceResolver extends ExchangeAdapter {
  readonly manifest: CapabilityManifest;
  resolve(query: ConnectorResourceQuery): Promise<ConnectorResourceResolution>;
}
