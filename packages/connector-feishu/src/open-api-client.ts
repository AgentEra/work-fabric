import {
  FeishuBoundedResponseError,
  readBoundedResponseText,
} from "./bounded-response.js";
import {
  FeishuTokenError,
  type FeishuTenantTokenProvider,
} from "./token-provider.js";

export type FeishuReceiveIdType =
  | "open_id"
  | "user_id"
  | "union_id"
  | "email"
  | "chat_id";

export interface FeishuSendMessageInput {
  readonly credential_ref: string;
  readonly receive_id_type: FeishuReceiveIdType;
  readonly receive_id: string;
  readonly msg_type: "text" | "interactive";
  readonly content: string;
  readonly uuid: string;
}

export type FeishuSendMessageResult =
  | { readonly kind: "accepted"; readonly message_id: string }
  | {
      readonly kind: "retryable_failure";
      readonly error_code: string;
    }
  | {
      readonly kind: "permanent_failure";
      readonly error_code: string;
    };

export interface FeishuMessageClient {
  sendMessage(input: FeishuSendMessageInput): Promise<FeishuSendMessageResult>;
}

export interface FeishuOpenApiClientOptions {
  readonly token_provider: FeishuTenantTokenProvider;
  readonly fetch: typeof globalThis.fetch;
  readonly base_url: string;
  readonly request_timeout_ms: number;
  readonly max_response_bytes: number;
}

const TOKEN_REJECTED_CODES = new Set([99991663, 99991664, 99991668]);
const RECEIVE_ID_TYPES = new Set<FeishuReceiveIdType>([
  "open_id",
  "user_id",
  "union_id",
  "email",
  "chat_id",
]);

function bounded(value: string, label: string, maximum: number): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value
  ) throw new TypeError(`${label} is invalid`);
}

function validateMessage(input: FeishuSendMessageInput): void {
  bounded(input.credential_ref, "credential_ref", 255);
  bounded(input.receive_id, "receive_id", 255);
  bounded(input.uuid, "uuid", 50);
  if (!RECEIVE_ID_TYPES.has(input.receive_id_type)) {
    throw new TypeError("receive_id_type is invalid");
  }
  if (input.msg_type !== "text" && input.msg_type !== "interactive") {
    throw new TypeError("msg_type is invalid");
  }
  const bytes = new TextEncoder().encode(input.content).byteLength;
  const maximum = input.msg_type === "text" ? 150_000 : 30_000;
  if (bytes === 0 || bytes > maximum) {
    throw new RangeError("Feishu message content exceeds its limit");
  }
  try {
    JSON.parse(input.content);
  } catch {
    throw new TypeError("Feishu message content must be JSON");
  }
}

export class FeishuOpenApiClient implements FeishuMessageClient {
  private readonly baseUrl: string;

  constructor(private readonly options: FeishuOpenApiClientOptions) {
    this.baseUrl = new URL(options.base_url).toString().replace(/\/$/, "");
    for (const [name, value] of [
      ["request_timeout_ms", options.request_timeout_ms],
      ["max_response_bytes", options.max_response_bytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer`);
      }
    }
  }

  async sendMessage(
    input: FeishuSendMessageInput,
  ): Promise<FeishuSendMessageResult> {
    try {
      validateMessage(input);
    } catch {
      return { kind: "permanent_failure", error_code: "invalid_message" };
    }
    let forceRefresh = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let token: string;
      try {
        token = await this.options.token_provider.getToken(
          input.credential_ref,
          forceRefresh,
        );
      } catch (error) {
        if (
          error instanceof FeishuTokenError &&
          (error.code === "credential_rejected" ||
            error.code === "request_rejected" ||
            error.code === "invalid_clock")
        ) {
          return {
            kind: "permanent_failure",
            error_code: `token_${error.code}`,
          };
        }
        return { kind: "retryable_failure", error_code: "token_unavailable" };
      }
      const result = await this.request(input, token);
      if (result.kind !== "token_rejected") return result;
      forceRefresh = true;
    }
    return { kind: "retryable_failure", error_code: "token_rejected" };
  }

  private async request(
    input: FeishuSendMessageInput,
    token: string,
  ): Promise<FeishuSendMessageResult | { readonly kind: "token_rejected" }> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.request_timeout_ms,
    );
    try {
      const url = new URL(`${this.baseUrl}/open-apis/im/v1/messages`);
      url.searchParams.set("receive_id_type", input.receive_id_type);
      const response = await this.options.fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          receive_id: input.receive_id,
          msg_type: input.msg_type,
          content: input.content,
          uuid: input.uuid,
        }),
        signal: controller.signal,
      });
      if (response.status === 401) return { kind: "token_rejected" };
      if (response.status === 429 || response.status >= 500) {
        return { kind: "retryable_failure", error_code: `http_${response.status}` };
      }
      if (response.status === 400 || response.status === 403) {
        return { kind: "permanent_failure", error_code: `http_${response.status}` };
      }
      let text: string;
      try {
        text = await readBoundedResponseText(
          response,
          this.options.max_response_bytes,
        );
      } catch (error) {
        return {
          kind: "retryable_failure",
          error_code: error instanceof FeishuBoundedResponseError
            ? "response_too_large"
            : "response_read_failed",
        };
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return { kind: "retryable_failure", error_code: "invalid_response" };
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return { kind: "retryable_failure", error_code: "invalid_response" };
      }
      const value = body as Record<string, unknown>;
      if (typeof value.code === "number" && TOKEN_REJECTED_CODES.has(value.code)) {
        return { kind: "token_rejected" };
      }
      if (!response.ok || value.code !== 0) {
        return { kind: "permanent_failure", error_code: "api_rejected" };
      }
      const data = value.data;
      const messageId =
        data !== null && typeof data === "object" && !Array.isArray(data)
          ? (data as Record<string, unknown>).message_id
          : undefined;
      if (typeof messageId !== "string" || messageId.length === 0) {
        return { kind: "retryable_failure", error_code: "invalid_response" };
      }
      return { kind: "accepted", message_id: messageId };
    } catch {
      return {
        kind: "retryable_failure",
        error_code: controller.signal.aborted ? "request_timeout" : "network_failure",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
