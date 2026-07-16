import type { JsonObject } from "@work-fabric/exchange-spi";
import type { ConnectorIngressStore } from "@work-fabric/connector-spi";
import type { FeishuCredentialProvider } from "@work-fabric/connector-feishu";

export interface HttpAuthenticationMetadata {
  readonly authorization: string | null;
  readonly request_id: string;
}

export interface HttpRequestAuthenticator {
  authenticationEvidence(
    metadata: HttpAuthenticationMetadata,
  ): Promise<JsonObject | null>;
}

export interface HttpDispatchRequest {
  readonly method:
    | "DELETE"
    | "GET"
    | "HEAD"
    | "OPTIONS"
    | "PATCH"
    | "POST"
    | "PUT";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly payload?: JsonObject | readonly unknown[] | string | null;
}

export interface HttpDispatchResponse {
  readonly status_code: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  json(): unknown;
}

export interface HttpService {
  dispatch(request: HttpDispatchRequest): Promise<HttpDispatchResponse>;
  listen(options: {
    readonly host: string;
    readonly port: number;
  }): Promise<{ readonly origin: string }>;
  close(): Promise<void>;
}

export interface FeishuWebhookBinding {
  readonly route_connector_id: string;
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly external_tenant_id: string;
  readonly credential_ref: string;
}

export interface FeishuWebhookBindingResolver {
  resolve(routeConnectorId: string): Promise<FeishuWebhookBinding | null>;
}

export interface FeishuWebhookClock {
  now(): string;
  nowEpochSeconds(): number;
}

export interface FeishuWebhookDependencies {
  readonly ingress: ConnectorIngressStore;
  readonly credential_provider: FeishuCredentialProvider;
  readonly binding_resolver: FeishuWebhookBindingResolver;
  readonly clock: FeishuWebhookClock;
}
