import { describe, expect, it } from "vitest";

import { createFeishuSdkLogger } from "../src/redacting-logger.js";

describe("createFeishuSdkLogger", () => {
  it("emits only stable codes and never SDK arguments", () => {
    const calls: Array<readonly [string, string]> = [];
    const logger = createFeishuSdkLogger({
      error: (code) => calls.push(["error", code]),
      warn: (code) => calls.push(["warn", code]),
      info: (code) => calls.push(["info", code]),
    });
    const sensitiveValues = [
      "app-secret-value",
      "tenant-access-key-value",
      "sender-open-id-value",
      "chat-id-value",
      "private-message-text-value",
    ] as const;
    const [appSecret, tenantKey, senderOpenId, chatId, messageText] = sensitiveValues;

    logger.error(appSecret, { tenantKey, senderOpenId, chatId, messageText });
    logger.warn(messageText, tenantKey, { senderOpenId });
    logger.info({ appSecret, tenantKey, senderOpenId, chatId, messageText });
    logger.debug(appSecret, tenantKey, senderOpenId, chatId, messageText);
    logger.trace(messageText, chatId, senderOpenId, tenantKey, appSecret);

    expect(calls).toEqual([
      ["error", "feishu_sdk_error"],
      ["warn", "feishu_sdk_warning"],
      ["info", "feishu_sdk_info"],
    ]);
    const serializedCalls = JSON.stringify(calls);
    for (const sensitiveValue of sensitiveValues) {
      expect(serializedCalls).not.toContain(sensitiveValue);
    }
  });
});
