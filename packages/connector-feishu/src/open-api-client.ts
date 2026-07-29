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
  readonly msg_type: "text" | "post" | "interactive";
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

export interface FeishuGetMessageInput {
  readonly credential_ref: string;
  readonly message_id: string;
}

export interface FeishuListMessagesInput {
  readonly credential_ref: string;
  readonly container_type: "chat" | "thread";
  readonly container_id: string;
  readonly start_time?: number;
  readonly end_time?: number;
  readonly sort_type: "ByCreateTimeDesc";
  readonly page_size: number;
  readonly page_token?: string;
}

export interface FeishuHistoryMessage {
  readonly message_id: string;
  readonly root_id?: string;
  readonly parent_id?: string;
  readonly thread_id?: string;
  readonly msg_type: string;
  readonly create_time: string;
  readonly update_time: string;
  readonly deleted: boolean;
  readonly updated: boolean;
  readonly chat_id: string;
  readonly sender: {
    readonly id: string;
    readonly id_type: string;
    readonly sender_type: string;
    readonly tenant_key?: string;
  };
  readonly body: {
    readonly content: string;
  };
}

export type FeishuHistoryResult =
  | {
      readonly kind: "accepted";
      readonly items: readonly FeishuHistoryMessage[];
    }
  | {
      readonly kind: "retryable_failure";
      readonly error_code: string;
    }
  | {
      readonly kind: "permanent_failure";
      readonly error_code: string;
    };

export type FeishuHistoryPageResult =
  | {
      readonly kind: "accepted";
      readonly items: readonly FeishuHistoryMessage[];
      readonly has_more: boolean;
      readonly next_page_token?: string;
    }
  | Exclude<FeishuHistoryResult, { readonly kind: "accepted" }>;

/** Narrow read-only boundary for Feishu message history materialization. */
export interface FeishuConversationApi {
  getMessage(input: FeishuGetMessageInput): Promise<FeishuHistoryResult>;
  listMessages(
    input: FeishuListMessagesInput,
  ): Promise<FeishuHistoryPageResult>;
}

export interface FeishuContactBatchInput {
  readonly credential_ref: string;
  readonly user_ids: readonly string[];
}

export interface FeishuContactUser {
  readonly open_id: string;
  readonly status: {
    readonly is_activated: boolean;
    readonly is_exited?: boolean;
  };
}

export type FeishuContactBatchResult =
  | { readonly kind: "accepted"; readonly items: readonly FeishuContactUser[] }
  | {
      readonly kind: "failure";
      readonly error_code:
        | "invalid_request"
        | "token_unavailable"
        | "token_rejected"
        | "http_rejected"
        | "api_rejected"
        | "temporarily_unavailable"
        | "request_timeout"
        | "network_failure"
        | "response_too_large"
        | "response_read_failed"
        | "invalid_response";
    };

/** A deliberately narrow transport boundary for Feishu Contact v3 user lookup. */
export interface FeishuContactApiClient {
  batchUsers(input: FeishuContactBatchInput): Promise<FeishuContactBatchResult>;
}

export interface FeishuOpenApiClientOptions {
  readonly token_provider: FeishuTenantTokenProvider;
  readonly fetch: typeof globalThis.fetch;
  readonly base_url: string;
  readonly request_timeout_ms: number;
  readonly max_response_bytes: number;
}

const TOKEN_REJECTED_CODES = new Set([99991663, 99991664, 99991668]);
const CONTACT_TIMEOUT_MS = 10_000;
const CONTACT_MAX_RESPONSE_BYTES = 64 * 1_024;
const CONTACT_BATCH_URL = "https://open.feishu.cn/open-apis/contact/v3/users/batch";
const ABSENT = Symbol("absent");
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
  if (
    input.msg_type !== "text" &&
    input.msg_type !== "post" &&
    input.msg_type !== "interactive"
  ) {
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

function ownData(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid Contact response");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError("invalid Contact response");
  }
  return descriptor.value;
}

function optionalOwnData(value: object, key: string): unknown | typeof ABSENT {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    if (Reflect.has(value, key)) throw new TypeError("invalid Contact response");
    return ABSENT;
  }
  if (!("value" in descriptor)) throw new TypeError("invalid Contact response");
  return descriptor.value;
}

function safeContactItems(body: unknown): readonly FeishuContactUser[] {
  const data = ownData(body, "data");
  const items = ownData(data, "items");
  if (!Array.isArray(items)) throw new TypeError("invalid Contact response");
  const safeItems: FeishuContactUser[] = [];
  for (const item of items) {
    const openId = ownData(item, "open_id");
    if (typeof openId !== "string") throw new TypeError("invalid Contact response");
    bounded(openId, "open_id", 255);
    const status = ownData(item, "status");
    const activated = ownData(status, "is_activated");
    if (typeof activated !== "boolean") throw new TypeError("invalid Contact response");
    const exited = optionalOwnData(status as object, "is_exited");
    if (exited !== ABSENT && typeof exited !== "boolean") {
      throw new TypeError("invalid Contact response");
    }
    const safeStatus = exited === ABSENT
      ? Object.freeze({ is_activated: activated })
      : Object.freeze({ is_activated: activated, is_exited: exited });
    safeItems.push(Object.freeze({ open_id: openId, status: safeStatus }));
  }
  return Object.freeze(safeItems);
}

function historyString(
  value: unknown,
  label: string,
  maximum = 262_144,
): string {
  if (typeof value !== "string") throw new TypeError(`${label} is invalid`);
  bounded(value, label, maximum);
  return value;
}

function optionalHistoryString(
  value: object,
  key: string,
  maximum = 255,
): string | undefined {
  const found = optionalOwnData(value, key);
  if (found === ABSENT || found === null || found === "") return undefined;
  return historyString(found, key, maximum);
}

function historyTimestamp(value: unknown, label: string): string {
  const timestamp = historyString(value, label, 20);
  if (!/^\d+$/.test(timestamp)) throw new TypeError(`${label} is invalid`);
  return timestamp;
}

function safeHistoryItems(body: unknown): readonly FeishuHistoryMessage[] {
  const data = ownData(body, "data");
  const items = ownData(data, "items");
  if (!Array.isArray(items) || items.length > 50) {
    throw new TypeError("invalid history response");
  }
  const safeItems: FeishuHistoryMessage[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError("invalid history response");
    }
    const messageId = historyString(ownData(item, "message_id"), "message_id", 255);
    const msgType = historyString(ownData(item, "msg_type"), "msg_type", 64);
    const createTime = historyTimestamp(ownData(item, "create_time"), "create_time");
    const updateTime = historyTimestamp(ownData(item, "update_time"), "update_time");
    const deleted = ownData(item, "deleted");
    const updated = ownData(item, "updated");
    if (typeof deleted !== "boolean" || typeof updated !== "boolean") {
      throw new TypeError("invalid history response");
    }
    const chatId = historyString(ownData(item, "chat_id"), "chat_id", 255);
    const sender = ownData(item, "sender");
    if (sender === null || typeof sender !== "object" || Array.isArray(sender)) {
      throw new TypeError("invalid history response");
    }
    const safeSender = Object.freeze({
      id: historyString(ownData(sender, "id"), "sender.id", 255),
      id_type: historyString(ownData(sender, "id_type"), "sender.id_type", 64),
      sender_type: historyString(ownData(sender, "sender_type"), "sender.sender_type", 64),
      ...(() => {
        const tenantKey = optionalHistoryString(sender, "tenant_key", 255);
        return tenantKey === undefined ? {} : { tenant_key: tenantKey };
      })(),
    });
    const bodyValue = ownData(item, "body");
    if (bodyValue === null || typeof bodyValue !== "object" || Array.isArray(bodyValue)) {
      throw new TypeError("invalid history response");
    }
    const safeBody = Object.freeze({
      content: historyString(ownData(bodyValue, "content"), "body.content"),
    });
    const rootId = optionalHistoryString(item, "root_id");
    const parentId = optionalHistoryString(item, "parent_id");
    const threadId = optionalHistoryString(item, "thread_id");
    safeItems.push(Object.freeze({
      message_id: messageId,
      ...(rootId === undefined ? {} : { root_id: rootId }),
      ...(parentId === undefined ? {} : { parent_id: parentId }),
      ...(threadId === undefined ? {} : { thread_id: threadId }),
      msg_type: msgType,
      create_time: createTime,
      update_time: updateTime,
      deleted,
      updated,
      chat_id: chatId,
      sender: safeSender,
      body: safeBody,
    }));
  }
  return Object.freeze(safeItems);
}

function safeHistoryPage(body: unknown): {
  readonly has_more: boolean;
  readonly next_page_token?: string;
} {
  const data = ownData(body, "data");
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new TypeError("invalid history pagination");
  }
  const hasMore = ownData(data, "has_more");
  if (typeof hasMore !== "boolean") {
    throw new TypeError("invalid history pagination");
  }
  const pageToken = optionalHistoryString(data, "page_token", 2_048);
  if (hasMore && pageToken === undefined) {
    throw new TypeError("invalid history pagination");
  }
  return Object.freeze({
    has_more: hasMore,
    ...(hasMore ? { next_page_token: pageToken! } : {}),
  });
}

function validateHistoryBase(
  input: { readonly credential_ref: string },
): void {
  bounded(input.credential_ref, "credential_ref", 255);
}

function validateHistoryList(input: FeishuListMessagesInput): void {
  validateHistoryBase(input);
  bounded(input.container_id, "container_id", 255);
  if (input.container_type !== "chat" && input.container_type !== "thread") {
    throw new TypeError("container_type is invalid");
  }
  if (input.sort_type !== "ByCreateTimeDesc") {
    throw new TypeError("sort_type is invalid");
  }
  if (
    !Number.isSafeInteger(input.page_size) ||
    input.page_size < 1 ||
    input.page_size > 50
  ) {
    throw new RangeError("page_size is invalid");
  }
  if (
    input.container_type === "thread" &&
    (input.start_time !== undefined || input.end_time !== undefined)
  ) {
    throw new TypeError("thread history does not accept a time window");
  }
  for (const [name, value] of [
    ["start_time", input.start_time],
    ["end_time", input.end_time],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < 0)
    ) {
      throw new RangeError(`${name} is invalid`);
    }
  }
  if (
    input.start_time !== undefined &&
    input.end_time !== undefined &&
    input.start_time > input.end_time
  ) {
    throw new RangeError("history time window is invalid");
  }
  if (input.page_token !== undefined) {
    bounded(input.page_token, "page_token", 2_048);
  }
}

export class FeishuOpenApiClient
  implements FeishuMessageClient, FeishuContactApiClient, FeishuConversationApi {
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

  async batchUsers(
    input: FeishuContactBatchInput,
  ): Promise<FeishuContactBatchResult> {
    try {
      bounded(input.credential_ref, "credential_ref", 255);
      if (!Array.isArray(input.user_ids) || input.user_ids.length === 0 || input.user_ids.length > 50) {
        throw new TypeError("user_ids is invalid");
      }
      for (const userId of input.user_ids) bounded(userId, "user_id", 255);
    } catch {
      return { kind: "failure", error_code: "invalid_request" };
    }

    let forceRefresh = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let token: string;
      try {
        token = await this.options.token_provider.getToken(input.credential_ref, forceRefresh);
      } catch {
        return { kind: "failure", error_code: "token_unavailable" };
      }
      const result = await this.requestContactBatch(input.user_ids, token);
      if (result.kind !== "token_rejected") return result;
      forceRefresh = true;
    }
    return { kind: "failure", error_code: "token_rejected" };
  }

  async getMessage(input: FeishuGetMessageInput): Promise<FeishuHistoryResult> {
    try {
      validateHistoryBase(input);
      bounded(input.message_id, "message_id", 255);
    } catch {
      return { kind: "permanent_failure", error_code: "invalid_request" };
    }
    return this.historyWithToken(input.credential_ref, (token) =>
      this.requestHistory(
        `${this.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(input.message_id)}`,
        token,
      ));
  }

  async listMessages(
    input: FeishuListMessagesInput,
  ): Promise<FeishuHistoryPageResult> {
    try {
      validateHistoryList(input);
    } catch {
      return { kind: "permanent_failure", error_code: "invalid_request" };
    }
    const url = new URL(`${this.baseUrl}/open-apis/im/v1/messages`);
    url.searchParams.set("container_id_type", input.container_type);
    url.searchParams.set("container_id", input.container_id);
    if (input.start_time !== undefined) {
      url.searchParams.set("start_time", String(input.start_time));
    }
    if (input.end_time !== undefined) {
      url.searchParams.set("end_time", String(input.end_time));
    }
    url.searchParams.set("sort_type", input.sort_type);
    url.searchParams.set("page_size", String(input.page_size));
    if (input.page_token !== undefined) {
      url.searchParams.set("page_token", input.page_token);
    }
    return this.historyWithToken(input.credential_ref, (token) =>
      this.requestHistory(url, token, true));
  }

  private async historyWithToken<
    TResult extends FeishuHistoryResult | FeishuHistoryPageResult,
  >(
    credentialRef: string,
    request: (token: string) => Promise<
      TResult | { readonly kind: "token_rejected" }
    >,
  ): Promise<TResult> {
    let forceRefresh = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let token: string;
      try {
        token = await this.options.token_provider.getToken(
          credentialRef,
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
          } as TResult;
        }
        return {
          kind: "retryable_failure",
          error_code: "token_unavailable",
        } as TResult;
      }
      const result = await request(token);
      if (result.kind !== "token_rejected") return result;
      forceRefresh = true;
    }
    return {
      kind: "retryable_failure",
      error_code: "token_rejected",
    } as TResult;
  }

  private requestHistory(
    input: string | URL,
    token: string,
  ): Promise<FeishuHistoryResult | { readonly kind: "token_rejected" }>;
  private requestHistory(
    input: string | URL,
    token: string,
    paginated: true,
  ): Promise<FeishuHistoryPageResult | { readonly kind: "token_rejected" }>;
  private async requestHistory(
    input: string | URL,
    token: string,
    paginated = false,
  ): Promise<
    | FeishuHistoryResult
    | FeishuHistoryPageResult
    | { readonly kind: "token_rejected" }
  > {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.request_timeout_ms,
    );
    try {
      const response = await this.options.fetch(input, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
        },
        signal: controller.signal,
      });
      if (response.status === 401) return { kind: "token_rejected" };
      if (response.status === 429 || response.status >= 500) {
        return {
          kind: "retryable_failure",
          error_code: `http_${response.status}`,
        };
      }
      if (!response.ok) {
        return {
          kind: "permanent_failure",
          error_code: `http_${response.status}`,
        };
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
          error_code: controller.signal.aborted
            ? "request_timeout"
            : error instanceof FeishuBoundedResponseError
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
      let code: unknown;
      try {
        code = ownData(body, "code");
      } catch {
        return { kind: "retryable_failure", error_code: "invalid_response" };
      }
      if (typeof code !== "number" || !Number.isSafeInteger(code)) {
        return { kind: "retryable_failure", error_code: "invalid_response" };
      }
      if (TOKEN_REJECTED_CODES.has(code)) return { kind: "token_rejected" };
      if (code !== 0) {
        return { kind: "permanent_failure", error_code: "api_rejected" };
      }
      try {
        const items = safeHistoryItems(body);
        if (!paginated) return Object.freeze({ kind: "accepted", items });
        return Object.freeze({
          kind: "accepted",
          items,
          ...safeHistoryPage(body),
        });
      } catch {
        return { kind: "retryable_failure", error_code: "invalid_response" };
      }
    } catch {
      return {
        kind: "retryable_failure",
        error_code: controller.signal.aborted
          ? "request_timeout"
          : "network_failure",
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestContactBatch(
    userIds: readonly string[],
    token: string,
  ): Promise<FeishuContactBatchResult | { readonly kind: "token_rejected" }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONTACT_TIMEOUT_MS);
    try {
      const url = new URL(CONTACT_BATCH_URL);
      for (const userId of userIds) url.searchParams.append("user_ids", userId);
      url.searchParams.set("user_id_type", "open_id");
      const response = await this.options.fetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
        },
        signal: controller.signal,
      });
      if (response.status === 401) return { kind: "token_rejected" };
      if (response.status === 429 || response.status >= 500) {
        return { kind: "failure", error_code: "temporarily_unavailable" };
      }
      if (!response.ok) return { kind: "failure", error_code: "http_rejected" };

      let text: string;
      try {
        text = await readBoundedResponseText(response, CONTACT_MAX_RESPONSE_BYTES);
      } catch (error) {
        return {
          kind: "failure",
          error_code: controller.signal.aborted
            ? "request_timeout"
            : error instanceof FeishuBoundedResponseError
              ? "response_too_large"
              : "response_read_failed",
        };
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return { kind: "failure", error_code: "invalid_response" };
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return { kind: "failure", error_code: "invalid_response" };
      }
      try {
        const code = ownData(body, "code");
        if (typeof code !== "number" || !Number.isSafeInteger(code)) {
          return { kind: "failure", error_code: "invalid_response" };
        }
        if (TOKEN_REJECTED_CODES.has(code)) return { kind: "token_rejected" };
        if (code !== 0) return { kind: "failure", error_code: "api_rejected" };
        const items = safeContactItems(body);
        return Object.freeze({ kind: "accepted", items });
      } catch {
        return { kind: "failure", error_code: "invalid_response" };
      }
    } catch {
      return {
        kind: "failure",
        error_code: controller.signal.aborted ? "request_timeout" : "network_failure",
      };
    } finally {
      clearTimeout(timeout);
    }
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
