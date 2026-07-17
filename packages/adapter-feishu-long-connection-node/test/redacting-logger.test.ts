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
    const secret = "app-secret-value";
    const message = "private message text";

    logger.error(secret, { message });
    logger.warn(message, secret);
    logger.info({ secret, message });
    logger.debug(secret, message);
    logger.trace(message, secret);

    expect(calls).toEqual([
      ["error", "feishu_sdk_error"],
      ["warn", "feishu_sdk_warning"],
      ["info", "feishu_sdk_info"],
    ]);
    expect(JSON.stringify(calls)).not.toContain(secret);
    expect(JSON.stringify(calls)).not.toContain(message);
  });
});
