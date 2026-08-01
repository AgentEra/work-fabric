import {
  FeishuProviderBackendError,
} from "./contracts.js";
import type {
  FeishuConversationMembersClient,
} from "./conversation-members-executor.js";
import type {
  FeishuOpenApiRequestClient,
} from "./openapi-backend.js";

function record(value: unknown): Record<string, unknown> | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) return null;
  return value as Record<string, unknown>;
}

function invalid(): never {
  throw new FeishuProviderBackendError(
    "feishu_response_invalid",
    true,
  );
}

export class FeishuOpenApiConversationMembersClient
  implements FeishuConversationMembersClient {
  constructor(private readonly requests: FeishuOpenApiRequestClient) {}

  async list(
    input: Parameters<FeishuConversationMembersClient["list"]>[0],
  ): ReturnType<FeishuConversationMembersClient["list"]> {
    if (
      input.chat_id.length === 0 ||
      input.chat_id.length > 255 ||
      input.chat_id.trim() !== input.chat_id ||
      !Number.isSafeInteger(input.page_size) ||
      input.page_size < 1 ||
      input.page_size > 100 ||
      (
        input.page_token !== undefined &&
        (
          input.page_token.length === 0 ||
          input.page_token.length > 2_048
        )
      )
    ) invalid();
    const query = new URLSearchParams({
      member_id_type: "open_id",
      page_size: String(input.page_size),
      ...(input.page_token === undefined
        ? {}
        : { page_token: input.page_token }),
    });
    const result = await this.requests.request(
      "GET",
      `/open-apis/im/v1/chats/${encodeURIComponent(
        input.chat_id,
      )}/members?${query.toString()}`,
      undefined,
      input.signal,
    );
    const response = record(result);
    const data = record(response?.data);
    if (
      response?.code !== 0 ||
      data === null ||
      !Array.isArray(data.items) ||
      data.items.length > input.page_size ||
      data.items.length > 100 ||
      typeof data.has_more !== "boolean"
    ) invalid();
    const members = data.items.map((item) => {
      const member = record(item);
      if (
        member === null ||
        member.member_id_type !== "open_id" ||
        typeof member.member_id !== "string" ||
        member.member_id.length === 0 ||
        member.member_id.length > 255 ||
        (
          member.name !== undefined &&
          (
            typeof member.name !== "string" ||
            member.name.length > 255
          )
        )
      ) invalid();
      return {
        open_id: member.member_id,
        ...(member.name === undefined
          ? {}
          : { display_name: member.name as string }),
      };
    });
    if (
      data.has_more &&
      (
        typeof data.page_token !== "string" ||
        data.page_token.length === 0 ||
        data.page_token.length > 2_048
      )
    ) invalid();
    return {
      members,
      has_more: data.has_more,
      ...(data.has_more
        ? { next_page_token: data.page_token as string }
        : {}),
    };
  }
}
