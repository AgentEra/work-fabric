import type { JsonObject } from "@work-fabric/exchange-spi";

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
